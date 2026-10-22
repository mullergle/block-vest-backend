require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Resend } = require("resend");
const crypto = require("crypto");

const supabase = require("./supabase");

const resend = new Resend(process.env.RESEND_API_KEY);

const CODE_EXPIRY = 10 * 60 * 1000; // 10 minutes
const TOKEN_EXPIRY = 15 * 60 * 1000; // 15 minutes
const AUTH_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

// Fallback to a default secret if not set in .env to prevent crashes
const JWT_SECRET = process.env.JWT_SECRET || "my-investment-super-secret-key-change-me";

const app = express();
app.set("trust proxy", 1); 
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://myinvestments.cfd")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    fileFilter: (req, file, cb) => {
        const allowed = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/;
        if (!allowed.test(file.mimetype)) {
            return cb(new Error("Invalid file type. Only images and PDFs are allowed."));
        }
        cb(null, true);
    }
});

/* ---------------- MIDDLEWARES ---------------- */
app.use(cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        cb(new Error("Not allowed by CORS"));
    },
    credentials: true
}));
app.use(express.json({ limit: "1mb" }));

/* ---------------- ZERO-DEPENDENCY RATE LIMITER ---------------- */
const rateLimitStore = new Map();

function customRateLimit({ windowMs, max, message }) {
    return (req, res, next) => {
        const ip = req.ip || req.connection.remoteAddress;
        const now = Date.now();
        
        if (!rateLimitStore.has(ip)) {
            rateLimitStore.set(ip, []);
        }
        
        const requests = rateLimitStore.get(ip).filter(time => now - time < windowMs);
        
        if (requests.length >= max) {
            return res.status(429).json({ success: false, message });
        }
        
        requests.push(now);
        rateLimitStore.set(ip, requests);
        next();
    };
}

const authLimiter = customRateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: "Too many attempts. Please try again later."
});
const codeLimiter = customRateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    message: "Too many code requests. Please wait."
});
const verifyLimiter = customRateLimit({
    windowMs: 10 * 60 * 1000,
    max: 10,
    message: "Too many verification attempts."
});

/* ---------------- VALIDATION HELPERS ---------------- */
function isEmail(v) {
    return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}
function isUuid(v) {
    return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
function isPositiveNumber(v) {
    const n = Number(String(v ?? "").replace(/,/g, "").trim());
    return !isNaN(n) && n > 0;
}
function escapeHtml(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/* ---------------- FORMATTING HELPERS ---------------- */
function formatMoney(value) {
    const num = Number(value || 0);
    if (isNaN(num)) return "0.00";
    return num.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}
function cleanNumber(v) {
    if (v === undefined || v === null || v === "") return v;
    const n = Number(String(v).replace(/,/g, "").trim());
    return isNaN(n) ? v : n;
}

/* ---------------- ZERO-DEPENDENCY AUTH (HMAC) ---------------- */
function base64url(str) {
    return Buffer.from(str).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function base64urlDecode(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(str, "base64").toString("utf8");
}

function signToken(user) {
    const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({
        sub: user.id,
        is_admin: !!user.is_admin,
        email: user.email,
        exp: Date.now() + AUTH_EXPIRY
    }));
    
    const signature = crypto
        .createHmac("sha256", JWT_SECRET)
        .update(`${header}.${payload}`)
        .digest("base64")
        .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

    return `${header}.${payload}.${signature}`;
}

function authRequired(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: "Authentication required." });
    
    const parts = token.split(".");
    if (parts.length !== 3) return res.status(401).json({ success: false, message: "Invalid token format." });

    const [headerB64, payloadB64, signature] = parts;
    const expectedSignature = crypto
        .createHmac("sha256", JWT_SECRET)
        .update(`${headerB64}.${payloadB64}`)
        .digest("base64")
        .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

    if (signature !== expectedSignature) {
        return res.status(401).json({ success: false, message: "Invalid token signature." });
    }

    try {
        const payload = JSON.parse(base64urlDecode(payloadB64));
        if (payload.exp && Date.now() > payload.exp) {
            return res.status(401).json({ success: false, message: "Token expired." });
        }
        req.user = payload;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: "Invalid token payload." });
    }
}

function adminRequired(req, res, next) {
    authRequired(req, res, () => {
        if (!req.user.is_admin) {
            return res.status(403).json({ success: false, message: "Admin access required." });
        }
        next();
    });
}

function selfOrAdmin(paramName = "userId") {
    return (req, res, next) => {
        authRequired(req, res, () => {
            const targetId = req.params[paramName] || req.params.id;
            if (req.user.is_admin || req.user.sub === targetId) return next();
            return res.status(403).json({ success: false, message: "Forbidden." });
        });
    };
}

/* ---------------- SAFE ERROR RESPONSE ---------------- */
function serverError(res, err, context = "") {
    console.error(`❌${context ? " [" + context + "]" : ""}`, err);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
}

/* ---------------- ATOMIC BALANCE HELPER ---------------- */
async function adjustBalance(userId, delta) {
    const { error } = await supabase.rpc("increment_balance", {
        p_user_id: userId,
        p_delta: delta
    });
    if (!error) return { ok: true };

    console.warn("⚠️ RPC increment_balance failed, falling back:", error.message);
    const { data: row, error: fetchErr } = await supabase
        .from("users").select("balance").eq("id", userId).single();
    if (fetchErr || !row) return { ok: false, error: "User not found" };
    const newBalance = Number(row.balance || 0) + Number(delta);
    const { error: updateErr } = await supabase
        .from("users").update({ balance: newBalance }).eq("id", userId);
    if (updateErr) return { ok: false, error: updateErr.message };
    return { ok: true };
}

/* ---------------- WELCOME EMAIL ---------------- */
async function sendWelcomeEmail({ to, fullName }) {
    const safeFirst = escapeHtml((fullName || "there").trim().split(" ")[0] || "there");

    const html = `
    <div style="font-family:Arial,sans-serif;background:#f9fafb;padding:32px 16px;">
        <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
            <div style="background:#08090d;padding:28px 32px;">
                <h1 style="color:#ffffff;font-size:20px;margin:0;">My Investment</h1>
            </div>
            <div style="padding:32px;">
                <h2 style="color:#08090d;font-size:22px;margin:0 0 16px;">Welcome, ${safeFirst}!</h2>
                <p style="color:#5b6473;font-size:15px;line-height:1.6;margin:0 0 16px;">
                    Thank you for joining <strong>My Investment</strong>. Your email address has been successfully verified, and your account is now fully activated.
                </p>
                <p style="color:#5b6473;font-size:15px;line-height:1.6;margin:0 0 16px;">
                    You can now access your dashboard to manage deposits, track withdrawals, monitor your portfolio, and communicate securely with our support team.
                </p>
                <div style="text-align:center;margin:28px 0;">
                    <a href="https://myinvestments.cfd" style="background:#ff3b5c;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;display:inline-block;">
                        Go to Dashboard
                    </a>
                </div>
                <p style="color:#5b6473;font-size:15px;line-height:1.6;margin:0;">
                    Welcome aboard,<br/>
                    <strong>The My Investment Team</strong>
                </p>
            </div>
            <div style="background:#f3f4f6;padding:16px 32px;text-align:center;">
                <p style="color:#9ca3af;font-size:12px;margin:0;">
                    This is an automated message. Please do not reply directly to this email.
                </p>
            </div>
        </div>
    </div>`;

    try {
        const { error } = await resend.emails.send({
            from: "My Investment <noreply@myinvestments.cfd>",
            to,
            subject: "Welcome to My Investment — Your Account Is Verified",
            html
        });
        if (error) {
            console.error("❌ Welcome email failed:", error);
            return { ok: false, error };
        }
        return { ok: true };
    } catch (err) {
        console.error("❌ Welcome email exception:", err);
        return { ok: false, error: err };
    }
}

/* ---------------- CODE STORAGE HELPERS ---------------- */
async function saveCode(email, code, purpose) {
    const expiresAt = new Date(Date.now() + CODE_EXPIRY).toISOString();
    const { error } = await supabase
        .from("password_resets")
        .upsert([{ email, code, expires_at: expiresAt, purpose }], { onConflict: "email" });
    if (error) {
        console.error("saveCode error:", error);
        const { error: e2 } = await supabase
            .from("password_resets")
            .upsert([{ email, code, expires_at: expiresAt }], { onConflict: "email" });
        if (e2) throw e2;
    }
}

async function fetchCode(email) {
    const { data, error } = await supabase
        .from("password_resets")
        .select("*")
        .eq("email", email)
        .maybeSingle();
    if (error) return { ok: false, error };
    return { ok: true, data };
}

async function consumeCode(email) {
    await supabase.from("password_resets").delete().eq("email", email);
}

/* ---------------- HOME / HEALTH ---------------- */
app.get("/", (req, res) => {
    res.json({ success: true, message: "🚀 Backend is running" });
});

app.get("/health", async (req, res) => {
    const { error } = await supabase.from("users").select("id").limit(1);
    if (error) {
        return res.status(503).json({ success: false, message: "DB unavailable" });
    }
    res.json({ success: true, message: "OK" });
});

async function checkDB() {
    const { error } = await supabase.from("users").select("id").limit(1);
    if (error) console.log("❌ Database NOT connected:", error.message);
    else console.log("✅ Database connected successfully");
}

/* ---------------- TEST (admin only) ---------------- */
app.get("/test", adminRequired, async (req, res) => {
    const { data, error } = await supabase.from("users").select("*").limit(5);
    if (error) return serverError(res, error, "/test");
    res.json({ success: true, data });
});

/* ==========================================================
   SIGNUP
========================================================== */
app.post("/signup/send-code", codeLimiter, async (req, res) => {
    try {
        const { fullName, phone, country, email, password } = req.body;

        if (!isEmail(email)) {
            return res.status(400).json({ success: false, message: "A valid email is required." });
        }
        if (!password || String(password).length < 6) {
            return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
        }

        const { data: existingUser } = await supabase
            .from("users").select("id,is_verified").eq("email", email).maybeSingle();

        if (existingUser && existingUser.is_verified) {
            return res.status(400).json({ success: false, message: "Email already exists." });
        }

        if (existingUser) {
            await supabase.from("users").update({
                full_name: fullName, phone, country, password
            }).eq("id", existingUser.id);
        } else {
            const { error: dbError } = await supabase
                .from("users")
                .insert([{ full_name: fullName, phone, country, email, password, is_verified: false }]);
            if (dbError) {
                if (/duplicate|unique/i.test(dbError.message)) {
                    return res.status(400).json({ success: false, message: "Email already exists." });
                }
                return serverError(res, dbError, "signup/send-code insert");
            }
        }

        const code = crypto.randomInt(100000, 999999).toString();
        await saveCode(email, code, "signup");

        const { error } = await resend.emails.send({
            from: "My Investment <noreply@myinvestments.cfd>",
            to: email,
            subject: "Verify your My Investment account",
            html: `
                <h2>Welcome to My Investment</h2>
                <p>Your verification code is:</p>
                <h1>${code}</h1>
                <p>This code expires in 10 minutes.</p>
            `
        });
        if (error) {
            console.error("❌ RESEND ERROR:", error);
            return res.status(500).json({ success: false, message: "Unable to send code." });
        }

        res.json({ success: true, message: "Verification code sent." });
    } catch (err) {
        return serverError(res, err, "signup/send-code");
    }
});

app.post("/signup/verify", verifyLimiter, async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!isEmail(email) || !code) {
            return res.status(400).json({ success: false, message: "Email and code are required." });
        }

        const fetched = await fetchCode(email);
        if (!fetched.ok || !fetched.data) {
            return res.status(401).json({ success: false, message: "Verification code not found or expired." });
        }
        const record = fetched.data;

        if (new Date() > new Date(record.expires_at)) {
            await consumeCode(email);
            return res.status(401).json({ success: false, message: "Verification code has expired." });
        }
        if (record.code !== code) {
            return res.status(401).json({ success: false, message: "Invalid verification code." });
        }

        const { error: updateError } = await supabase
            .from("users").update({ is_verified: true }).eq("email", email);
        if (updateError) return serverError(res, updateError, "signup/verify update");

        await consumeCode(email);

        const { data: verifiedUser } = await supabase
            .from("users").select("id,full_name,email,is_admin").eq("email", email).maybeSingle();

        await sendWelcomeEmail({ to: email, fullName: verifiedUser?.full_name });

        const token = verifiedUser ? signToken(verifiedUser) : null;

        res.json({
            success: true,
            message: "Email verified successfully.",
            token,
            user: verifiedUser
                ? {
                      id: verifiedUser.id,
                      full_name: verifiedUser.full_name,
                      email: verifiedUser.email,
                      is_admin: !!verifiedUser.is_admin
                  }
                : null
        });
    } catch (err) {
        return serverError(res, err, "signup/verify");
    }
});

app.post("/signup-direct", async (req, res) => {
    if (!process.env.ADMIN_SECRET || req.headers["x-admin-secret"] !== process.env.ADMIN_SECRET) {
        return res.status(404).json({ success: false, message: "Not found." });
    }
    try {
        const { fullName, phone, country, email, password } = req.body;
        if (!fullName || !phone || !country || !isEmail(email) || !password) {
            return res.status(400).json({ success: false, message: "All fields are required." });
        }
        const { data: existing } = await supabase
            .from("users").select("id").eq("email", email).maybeSingle();
        if (existing) return res.status(400).json({ success: false, message: "Email already exists." });

        const { data, error } = await supabase
            .from("users")
            .insert([{ full_name: fullName, phone, country, email, password, is_verified: true }])
            .select();
        if (error) return serverError(res, error, "signup-direct");

        await sendWelcomeEmail({ to: email, fullName });
        res.json({ success: true, message: "Account created.", user: data });
    } catch (err) {
        return serverError(res, err, "signup-direct");
    }
});

/* ==========================================================
   LOGIN
========================================================== */
app.post("/login", authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!isEmail(email) || !password) {
            return res.status(400).json({ success: false, message: "Email and password required." });
        }

        const { data, error } = await supabase
            .from("users").select("*").eq("email", email).eq("password", password).maybeSingle();

        if (error || !data) {
            return res.status(401).json({ success: false, message: "Invalid email or password." });
        }
        if (data.is_verified === false) {
            return res.status(403).json({ success: false, message: "Please verify your email address before logging in." });
        }
        if (data.is_suspended) {
            return res.status(403).json({ success: false, message: "Account suspended." });
        }

        const token = signToken(data);
        res.json({
            success: true,
            message: "Login successful.",
            is_admin: !!data.is_admin,
            token,
            user: data
        });
    } catch (err) {
        return serverError(res, err, "login");
    }
});

/* ==========================================================
   USER (self or admin)
========================================================== */
app.get("/user/:id", selfOrAdmin("id"), async (req, res) => {
    if (!isUuid(req.params.id)) {
        return res.status(400).json({ success: false, message: "Invalid user id." });
    }
    const { data, error } = await supabase
        .from("users").select("*").eq("id", req.params.id).maybeSingle();
    if (error || !data) {
        return res.status(404).json({ success: false, message: "User not found." });
    }
    res.json({
        success: true,
        user: {
            ...data,
            balance_display: formatMoney(data.balance),
            total_trade_display: formatMoney(data.total_trade),
            assets_display: formatMoney(data.assets),
            active_assets_display: formatMoney(data.active_assets),
            btc_balance_display: formatMoney(data.btc_balance),
            eth_balance_display: formatMoney(data.eth_balance),
            usdt_balance_display: formatMoney(data.usdt_balance)
        }
    });
});

/* ==========================================================
   FORGOT PASSWORD
========================================================== */
app.post("/forgot-password", codeLimiter, async (req, res) => {
    try {
        const { email } = req.body;
        if (!isEmail(email)) {
            return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        }

        const { data: user } = await supabase
            .from("users").select("id,email").eq("email", email).maybeSingle();
        if (!user) {
            return res.json({ success: false, message: "No account was found with that email address." });
        }

        const code = crypto.randomInt(100000, 999999).toString();
        await saveCode(email, code, "password_reset");

        const { error } = await resend.emails.send({
            from: "My Investment <noreply@myinvestments.cfd>",
            to: email,
            subject: "My Investment Password Reset Code",
            html: `
                <h2>My Investment Verification</h2>
                <p>Your verification code is:</p>
                <h1>${code}</h1>
                <p>This code expires in 10 minutes.</p>
            `
        });
        if (error) {
            console.error("❌ RESEND ERROR:", error);
            return res.status(500).json({ success: false, message: "Unable to send code." });
        }
        res.json({ success: true, message: "Verification code sent successfully." });
    } catch (err) {
        return serverError(res, err, "forgot-password");
    }
});

app.post("/verify-code", verifyLimiter, async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!isEmail(email) || !code) {
            return res.status(400).json({ success: false, message: "Email and code are required." });
        }

        const fetched = await fetchCode(email);
        if (!fetched.ok || !fetched.data) {
            return res.status(401).json({ success: false, message: "No reset request found for this email." });
        }
        const record = fetched.data;
        if (new Date() > new Date(record.expires_at)) {
            await consumeCode(email);
            return res.status(401).json({ success: false, message: "Verification code expired. Request a new one." });
        }
        if (record.code !== code) {
            return res.status(401).json({ success: false, message: "Invalid verification code." });
        }

        const resetToken = crypto.randomBytes(32).toString("hex");
        const tokenExpiresAt = new Date(Date.now() + TOKEN_EXPIRY).toISOString();

        const { error: updErr } = await supabase
            .from("password_resets")
            .update({ token: resetToken, token_expires_at: tokenExpiresAt })
            .eq("email", email);
        if (updErr) return serverError(res, updErr, "verify-code update");

        res.json({ success: true, message: "Verification successful.", reset_token: resetToken });
    } catch (err) {
        return serverError(res, err, "verify-code");
    }
});

app.post("/reset-password", authLimiter, async (req, res) => {
    try {
        const { email, password, token } = req.body;
        if (!isEmail(email) || !password || !token) {
            return res.status(400).json({ success: false, message: "Missing required fields." });
        }
        if (String(password).length < 6) {
            return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
        }

        const { data: record, error } = await supabase
            .from("password_resets").select("*")
            .eq("email", email).eq("token", token).maybeSingle();

        if (error || !record) {
            return res.status(403).json({ success: false, message: "Invalid or expired reset session. Please request a new code." });
        }
        if (!record.token_expires_at || new Date() > new Date(record.token_expires_at)) {
            await consumeCode(email);
            return res.status(403).json({ success: false, message: "Session expired. Please request a new code." });
        }

        const { error: updateError } = await supabase
            .from("users").update({ password }).eq("email", email);
        if (updateError) return serverError(res, updateError, "reset-password update");

        await consumeCode(email);
        res.json({ success: true, message: "Password reset successfully." });
    } catch (err) {
        return serverError(res, err, "reset-password");
    }
});

/* ==========================================================
   WITHDRAW
========================================================== */
app.post("/withdraw/send-code", codeLimiter, authRequired, async (req, res) => {
    try {
        const email = req.user.email;
        if (!isEmail(email)) {
            return res.status(400).json({ success: false, message: "Invalid email on account." });
        }

        const code = crypto.randomInt(100000, 999999).toString();
        await saveCode(email, code, "withdrawal");

        const { error } = await resend.emails.send({
            from: "My Investment <noreply@myinvestments.cfd>",
            to: email,
            subject: "My Investment Withdrawal Verification",
            html: `
                <h2>Withdrawal Verification</h2>
                <p>Your withdrawal verification code is:</p>
                <h1>${code}</h1>
                <p>This code expires in 10 minutes.</p>
            `
        });
        if (error) {
            console.error("❌ RESEND ERROR:", error);
            return res.status(500).json({ success: false, message: "Unable to send code." });
        }
        res.json({ success: true, message: "Verification code sent successfully." });
    } catch (err) {
        return serverError(res, err, "withdraw/send-code");
    }
});

app.post("/withdraw/create", authRequired, async (req, res) => {
    try {
        const userId = req.user.sub;
        const email = req.user.email;
        const { code, method, wallet_address, amount } = req.body;

        if (!code || !method || !wallet_address || !amount) {
            return res.status(400).json({ success: false, message: "All fields are required." });
        }
        if (!isPositiveNumber(amount)) {
            return res.status(400).json({ success: false, message: "Invalid withdrawal amount." });
        }
        const numericAmount = Number(String(amount).replace(/,/g, "").trim());

        const { data: userRow, error: balErr } = await supabase
            .from("users").select("balance").eq("id", userId).maybeSingle();
        if (balErr || !userRow) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        const userBalance = Number(userRow.balance || 0);
        if (numericAmount > userBalance) {
            return res.status(400).json({
                success: false,
                message: `Insufficient balance. Available: $${userBalance.toFixed(2)}`
            });
        }

        const fetched = await fetchCode(email);
        if (!fetched.ok || !fetched.data) {
            return res.status(401).json({ success: false, message: "Verification code not found." });
        }
        const record = fetched.data;
        if (new Date() > new Date(record.expires_at)) {
            await consumeCode(email);
            return res.status(401).json({ success: false, message: "Verification code expired." });
        }
        if (record.code !== code) {
            return res.status(401).json({ success: false, message: "Invalid verification code." });
        }

        const debit = await adjustBalance(userId, -numericAmount);
        if (!debit.ok) {
            return res.status(500).json({ success: false, message: "Could not reserve balance." });
        }

        const { data: txnData, error: txnError } = await supabase
            .from("transactions")
            .insert([{
                user_id: userId,
                type: "Withdrawal",
                amount: numericAmount,
                status: "Pending",
                description: `${method} Withdrawal`
            }])
            .select();
        if (txnError) {
            await adjustBalance(userId, numericAmount);
            return serverError(res, txnError, "withdraw/create txn");
        }
        const transactionId = txnData?.[0]?.id ?? null;

        const { data, error } = await supabase
            .from("withdrawals")
            .insert([{
                user_id: userId,
                method,
                wallet_address,
                amount: numericAmount,
                status: "Pending",
                transaction_id: transactionId
            }])
            .select();
        if (error) {
            await adjustBalance(userId, numericAmount);
            await supabase.from("transactions").delete().eq("id", transactionId);
            return serverError(res, error, "withdraw/create insert");
        }

        await consumeCode(email);
        res.json({ success: true, message: "Withdrawal request submitted successfully.", withdrawal: data });
    } catch (err) {
        return serverError(res, err, "withdraw/create");
    }
});

/* ==========================================================
   ADMIN — STATS
========================================================== */
app.get("/admin/stats", adminRequired, async (req, res) => {
    try {
        const { count: totalUsers } = await supabase
            .from("users").select("*", { count: "exact", head: true }).eq("is_admin", false);

        const { data: balanceRows } = await supabase.from("users").select("balance").eq("is_admin", false);
        const totalBalance = (balanceRows || []).reduce((s, r) => s + Number(r.balance || 0), 0);

        const { count: pendingDeposits } = await supabase
            .from("deposits").select("*", { count: "exact", head: true }).eq("status", "Pending");
        const { count: pendingWithdrawals } = await supabase
            .from("withdrawals").select("*", { count: "exact", head: true }).eq("status", "Pending");

        const { data: approvedDeposits } = await supabase
            .from("deposits").select("amount").eq("status", "Approved");
        const { data: approvedWithdrawals } = await supabase
            .from("withdrawals").select("amount").eq("status", "Approved");

        res.json({
            totalUsers: totalUsers || 0,
            totalBalance,
            pendingDeposits: pendingDeposits || 0,
            pendingWithdrawals: pendingWithdrawals || 0,
            totalDeposits: (approvedDeposits || []).reduce((s, r) => s + Number(r.amount || 0), 0),
            totalWithdrawals: (approvedWithdrawals || []).reduce((s, r) => s + Number(r.amount || 0), 0)
        });
    } catch (err) {
        return serverError(res, err, "admin/stats");
    }
});

/* ---------------- ADMIN — WITHDRAWALS ---------------- */
app.get("/admin/withdrawals", adminRequired, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const { data, error } = await supabase
        .from("withdrawals")
        .select(`*, users (full_name, email)`)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
    if (error) return serverError(res, error, "admin/withdrawals");
    res.json({
        success: true,
        withdrawals: (data || []).map(w => ({ ...w, amount_display: formatMoney(w.amount) }))
    });
});

app.get("/admin/unread-withdrawals", adminRequired, async (req, res) => {
    const { count, error } = await supabase
        .from("withdrawals").select("*", { count: "exact", head: true }).eq("status", "Pending");
    if (error) return serverError(res, error, "admin/unread-withdrawals");
    res.json({ success: true, count: count || 0 });
});

/* ---------------- ADMIN — USERS ---------------- */
app.get("/admin/user/:id", adminRequired, async (req, res) => {
    if (!isUuid(req.params.id)) {
        return res.status(400).json({ success: false, message: "Invalid user id." });
    }
    const { data, error } = await supabase
        .from("users")
        .select(`id, full_name, email, balance, total_trade, assets, active_assets, btc_balance, eth_balance, usdt_balance, is_suspended`)
        .eq("id", req.params.id).maybeSingle();
    if (error || !data) return res.status(404).json({ success: false, message: "User not found" });
    res.json({
        success: true,
        user: {
            ...data,
            balance_display: formatMoney(data.balance),
            total_trade_display: formatMoney(data.total_trade),
            assets_display: formatMoney(data.assets),
            active_assets_display: formatMoney(data.active_assets),
            btc_balance_display: formatMoney(data.btc_balance),
            eth_balance_display: formatMoney(data.eth_balance),
            usdt_balance_display: formatMoney(data.usdt_balance)
        }
    });
});

app.put("/admin/user/:id", adminRequired, async (req, res) => {
    try {
        const userId = req.params.id;
        if (!isUuid(userId)) {
            return res.status(400).json({ success: false, message: "Invalid user id." });
        }
        const {
            balance, total_trade, assets, active_assets,
            btc_balance, eth_balance, usdt_balance, is_suspended, note
        } = req.body;

        const { data: existing, error: fetchError } = await supabase
            .from("users").select("balance").eq("id", userId).maybeSingle();
        if (fetchError || !existing) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        const oldBalance = Number(existing.balance || 0);
        const newBalance = cleanNumber(balance);
        const difference = Number(newBalance || 0) - oldBalance;

        const { data, error } = await supabase
            .from("users")
            .update({
                balance: newBalance,
                total_trade: cleanNumber(total_trade),
                assets: cleanNumber(assets),
                active_assets: cleanNumber(active_assets),
                btc_balance: cleanNumber(btc_balance),
                eth_balance: cleanNumber(eth_balance),
                usdt_balance: cleanNumber(usdt_balance),
                is_suspended
            })
            .eq("id", userId)
            .select();
        if (error) return serverError(res, error, "admin/user update");

        if (difference !== 0) {
            const isCredit = difference > 0;
            const absoluteAmount = Math.abs(difference);
            const desc = note && String(note).trim()
                ? String(note).trim().slice(0, 200)
                : (isCredit ? "Credit by My Investment" : "Account adjustment by My Investment");
            const { error: txnError } = await supabase.from("transactions").insert([{
                user_id: userId,
                type: isCredit ? "Deposit" : "Withdrawal",
                amount: absoluteAmount,
                status: "Approved",
                description: desc
            }]);
            if (txnError) console.log("Transaction log error:", txnError);
        }

        res.json({ success: true, message: "User updated successfully", user: data });
    } catch (err) {
        return serverError(res, err, "admin/user update");
    }
});

app.put("/admin/user-assets/:id", adminRequired, async (req, res) => {
    const { btc_balance, eth_balance, usdt_balance } = req.body;
    const { data, error } = await supabase
        .from("users")
        .update({
            btc_balance: cleanNumber(btc_balance),
            eth_balance: cleanNumber(eth_balance),
            usdt_balance: cleanNumber(usdt_balance)
        })
        .eq("id", req.params.id)
        .select();
    if (error) return serverError(res, error, "admin/user-assets");
    res.json({ success: true, message: "Assets updated successfully", user: data });
});

app.get("/admin/users", adminRequired, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const { data, error } = await supabase
        .from("users")
        .select("*")
        .eq("is_admin", false)
        .order("id", { ascending: false })
        .range(offset, offset + limit - 1);
    if (error) return serverError(res, error, "admin/users");
    res.json({
        success: true,
        users: (data || []).map(u => ({
            ...u,
            balance_display: formatMoney(u.balance),
            total_trade_display: formatMoney(u.total_trade),
            assets_display: formatMoney(u.assets),
            active_assets_display: formatMoney(u.active_assets),
            btc_balance_display: formatMoney(u.btc_balance),
            eth_balance_display: formatMoney(u.eth_balance),
            usdt_balance_display: formatMoney(u.usdt_balance)
        }))
    });
});

/* ==========================================================
   CHANGE PASSWORD (self or admin)
========================================================== */
app.put("/change-password/:id", selfOrAdmin("id"), async (req, res) => {
    try {
        const { old_password, new_password } = req.body;
        if (!old_password || !new_password) {
            return res.status(400).json({ success: false, message: "All fields are required" });
        }
        if (String(new_password).length < 6) {
            return res.status(400).json({ success: false, message: "New password must be at least 6 characters." });
        }

        const { data: user, error } = await supabase
            .from("users").select("*").eq("id", req.params.id).maybeSingle();
        if (error || !user) return res.status(404).json({ success: false, message: "User not found" });
        if (user.password !== old_password) {
            return res.status(401).json({ success: false, message: "Old password incorrect" });
        }

        const { error: updateError } = await supabase
            .from("users").update({ password: new_password }).eq("id", req.params.id);
        if (updateError) return serverError(res, updateError, "change-password");
        res.json({ success: true, message: "Password updated successfully" });
    } catch (err) {
        return serverError(res, err, "change-password");
    }
});

/* ==========================================================
   DEPOSIT
========================================================== */
app.post("/deposit", authRequired, upload.single("receipt"), async (req, res) => {
    try {
        const userId = req.user.sub;
        const { amount, payment_method } = req.body;

        if (!req.file) return res.status(400).json({ success: false, message: "Receipt is required." });
        if (!isPositiveNumber(amount)) {
            return res.status(400).json({ success: false, message: "Invalid deposit amount." });
        }
        const numericAmount = Number(String(amount).replace(/,/g, "").trim());

        const ext = (req.file.originalname.split(".").pop() || "bin").replace(/[^a-zA-Z0-9]/g, "").slice(0, 6);
        const fileName = `${userId}/${crypto.randomUUID()}.${ext}`;

        const { error: uploadError } = await supabase.storage
            .from("receipts")
            .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
        if (uploadError) return serverError(res, uploadError, "deposit upload");

        const { data: publicUrl } = supabase.storage.from("receipts").getPublicUrl(fileName);
        const receipt_url = publicUrl.publicUrl;

        const method = (payment_method || "Crypto").toString().slice(0, 40);
        const description = `${method} Deposit`;

        const { data: txnData, error: transactionError } = await supabase
            .from("transactions")
            .insert([{ user_id: userId, type: "Deposit", amount: numericAmount, status: "Pending", description }])
            .select();
        if (transactionError) return serverError(res, transactionError, "deposit txn");
        const transactionId = txnData?.[0]?.id ?? null;

        const { data, error } = await supabase
            .from("deposits")
            .insert([{
                user_id: userId,
                amount: numericAmount,
                receipt_url,
                status: "Pending",
                transaction_id: transactionId,
                payment_method: method
            }])
            .select();
        if (error) {
            await supabase.from("transactions").delete().eq("id", transactionId);
            return serverError(res, error, "deposit insert");
        }

        res.json({ success: true, message: "Deposit submitted successfully.", deposit: data });
    } catch (err) {
        return serverError(res, err, "deposit");
    }
});

/* ---------------- USER TRANSACTIONS ---------------- */
app.get("/transactions/:userId", selfOrAdmin("userId"), async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const { data, error } = await supabase
        .from("transactions").select("*")
        .eq("user_id", req.params.userId)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
    if (error) return serverError(res, error, "transactions");
    res.json({
        success: true,
        transactions: (data || []).map(t => ({ ...t, amount_display: formatMoney(t.amount) }))
    });
});

/* ==========================================================
   ADMIN — WITHDRAWAL APPROVE / REJECT / DELETE
========================================================== */
app.put("/admin/withdrawals/:id/approve", adminRequired, async (req, res) => {
    try {
        const { data: withdrawal, error } = await supabase
            .from("withdrawals").select("*").eq("id", req.params.id).maybeSingle();
        if (error || !withdrawal) return res.status(404).json({ success: false, message: "Withdrawal not found." });
        if (withdrawal.status === "Approved") return res.status(400).json({ success: false, message: "Already approved." });
        if (withdrawal.status === "Rejected") return res.status(400).json({ success: false, message: "Already rejected." });

        await supabase.from("withdrawals").update({ status: "Approved" }).eq("id", req.params.id);
        if (withdrawal.transaction_id) {
            await supabase.from("transactions").update({ status: "Approved" }).eq("id", withdrawal.transaction_id);
        }
        res.json({ success: true, message: "Withdrawal approved." });
    } catch (err) {
        return serverError(res, err, "admin/withdrawals/approve");
    }
});

app.put("/admin/withdrawals/:id/reject", adminRequired, async (req, res) => {
    try {
        const { data: withdrawal, error } = await supabase
            .from("withdrawals").select("*").eq("id", req.params.id).maybeSingle();
        if (error || !withdrawal) return res.status(404).json({ success: false, message: "Withdrawal not found." });
        if (withdrawal.status === "Rejected") return res.status(400).json({ success: false, message: "Already rejected." });
        if (withdrawal.status === "Approved") return res.status(400).json({ success: false, message: "Already approved — cannot reject." });

        const refund = await adjustBalance(withdrawal.user_id, Number(withdrawal.amount));
        if (!refund.ok) return res.status(500).json({ success: false, message: "Could not refund balance." });

        await supabase.from("withdrawals").update({ status: "Rejected" }).eq("id", req.params.id);
        if (withdrawal.transaction_id) {
            await supabase.from("transactions").update({
                status: "Rejected",
                description: "Withdrawal rejected. Please contact support."
            }).eq("id", withdrawal.transaction_id);
        }
        res.json({ success: true, message: "Withdrawal rejected." });
    } catch (err) {
        return serverError(res, err, "admin/withdrawals/reject");
    }
});

app.delete("/admin/withdrawals/:id", adminRequired, async (req, res) => {
    const { data: withdrawal, error } = await supabase
        .from("withdrawals").select("*").eq("id", req.params.id).maybeSingle();
    if (error || !withdrawal) return res.status(404).json({ success: false, message: "Withdrawal not found." });

    if (withdrawal.status === "Pending") {
        await adjustBalance(withdrawal.user_id, Number(withdrawal.amount));
    }
    const { error: deleteError } = await supabase.from("withdrawals").delete().eq("id", req.params.id);
    if (deleteError) return serverError(res, deleteError, "admin/withdrawals/delete");
    if (withdrawal.transaction_id) {
        await supabase.from("transactions").delete().eq("id", withdrawal.transaction_id);
    }
    res.json({ success: true, message: "Withdrawal deleted successfully." });
});

/* ==========================================================
   ADMIN — DEPOSITS
========================================================== */
app.get("/admin/deposits", adminRequired, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const { data: deposits, error } = await supabase
        .from("deposits").select("*")
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
    if (error) return serverError(res, error, "admin/deposits");

    const userIds = [...new Set((deposits || []).map(d => d.user_id).filter(Boolean))];
    let usersById = {};
    if (userIds.length) {
        const { data: users } = await supabase
            .from("users").select("id, full_name, email").in("id", userIds);
        usersById = Object.fromEntries((users || []).map(u => [u.id, u]));
    }

    res.json({
        success: true,
        deposits: (deposits || []).map(d => ({
            ...d,
            users: usersById[d.user_id] || null,
            amount_display: formatMoney(d.amount)
        }))
    });
});

app.put("/admin/deposits/:id/approve", adminRequired, async (req, res) => {
    try {
        const { data: deposit, error } = await supabase
            .from("deposits").select("*").eq("id", req.params.id).maybeSingle();
        if (error || !deposit) return res.status(404).json({ success: false, message: "Deposit not found." });
        if (deposit.status === "Approved") return res.status(400).json({ success: false, message: "Already approved." });
        if (deposit.status === "Rejected") return res.status(400).json({ success: false, message: "Already rejected." });

        const creditMain = await adjustBalance(deposit.user_id, Number(deposit.amount));
        if (!creditMain.ok) return res.status(500).json({ success: false, message: "Could not credit balance." });

        const method = (deposit.payment_method || "BTC").toUpperCase();
        const col = method.includes("ETH") ? "eth_balance"
                  : method.includes("USDT") ? "usdt_balance"
                  : "btc_balance";

        const { error: rpcErr } = await supabase.rpc("increment_asset", {
            p_user_id: deposit.user_id,
            p_column: col,
            p_delta: Number(deposit.amount)
        });
        if (rpcErr) {
            const { data: u } = await supabase
                .from("users").select(col).eq("id", deposit.user_id).single();
            if (u) {
                await supabase.from("users")
                    .update({ [col]: Number(u[col] || 0) + Number(deposit.amount) })
                    .eq("id", deposit.user_id);
            }
        }

        await supabase.from("deposits").update({ status: "Approved" }).eq("id", req.params.id);
        if (deposit.transaction_id) {
            await supabase.from("transactions").update({ status: "Approved" }).eq("id", deposit.transaction_id);
        }

        res.json({ success: true, message: "Deposit approved." });
    } catch (err) {
        return serverError(res, err, "admin/deposits/approve");
    }
});

app.put("/admin/deposits/:id/reject", adminRequired, async (req, res) => {
    try {
        const { data: deposit, error } = await supabase
            .from("deposits").select("*").eq("id", req.params.id).maybeSingle();
        if (error || !deposit) return res.status(404).json({ success: false, message: "Deposit not found." });
        if (deposit.status === "Rejected") return res.status(400).json({ success: false, message: "Already rejected." });
        if (deposit.status === "Approved") return res.status(400).json({ success: false, message: "Already approved — cannot reject." });

        await supabase.from("deposits").update({ status: "Rejected" }).eq("id", req.params.id);
        if (deposit.transaction_id) {
            await supabase.from("transactions").update({ status: "Rejected" }).eq("id", deposit.transaction_id);
        }
        res.json({ success: true, message: "Deposit rejected." });
    } catch (err) {
        return serverError(res, err, "admin/deposits/reject");
    }
});

/* ==========================================================
   ADMIN — NOTIFICATIONS
========================================================== */
app.get("/admin/notifications", adminRequired, async (req, res) => {
    const { count: deposits } = await supabase
        .from("deposits").select("*", { count: "exact", head: true }).eq("status", "Pending");
    const { count: withdrawals } = await supabase
        .from("withdrawals").select("*", { count: "exact", head: true }).eq("status", "Pending");
    const { count: unreadSupport } = await supabase
        .from("support_messages").select("*", { count: "exact", head: true })
        .eq("sender", "user").eq("is_read", false);

    res.json({
        success: true,
        pendingDeposits: deposits || 0,
        pendingWithdrawals: withdrawals || 0,
        unreadSupport: unreadSupport || 0
    });
});

/* ==========================================================
   SUPPORT
========================================================== */
app.get("/support/messages/:userId", selfOrAdmin("userId"), async (req, res) => {
    const { data, error } = await supabase
        .from("support_messages").select("*")
        .eq("user_id", req.params.userId)
        .order("created_at", { ascending: true });
    if (error) return serverError(res, error, "support/messages");
    res.json({ success: true, messages: data });
});

app.post("/support/messages", authRequired, async (req, res) => {
    try {
        const userId = req.user.sub;
        const { message } = req.body;
        if (!message || !String(message).trim()) {
            return res.status(400).json({ success: false, message: "Message is required." });
        }
        const trimmed = String(message).trim().slice(0, 5000);

        const { data, error } = await supabase
            .from("support_messages")
            .insert([{ user_id: userId, sender: "user", message: trimmed }])
            .select().single();
        if (error) return serverError(res, error, "support/messages post");
        res.json({ success: true, message: data });
    } catch (err) {
        return serverError(res, err, "support/messages");
    }
});

/* ==========================================================
   PLATFORM SETTINGS
========================================================== */
app.get("/settings/btc-address", async (req, res) => {
    const { data, error } = await supabase
        .from("platform_settings").select("btc_deposit_address").limit(1).maybeSingle();
    if (error) return serverError(res, error, "settings/btc-address");
    res.json({ success: true, btc_deposit_address: data?.btc_deposit_address || "" });
});

app.put("/admin/settings/btc-address", adminRequired, async (req, res) => {
    try {
        const { btc_deposit_address } = req.body;
        if (!btc_deposit_address || !String(btc_deposit_address).trim()) {
            return res.status(400).json({ success: false, message: "BTC deposit address is required." });
        }
        const address = String(btc_deposit_address).trim().slice(0, 200);

        const { data: existing, error: findError } = await supabase
            .from("platform_settings").select("id").limit(1).maybeSingle();
        if (findError || !existing) return res.status(404).json({ success: false, message: "Platform settings not found." });

        const { data, error } = await supabase
            .from("platform_settings")
            .update({ btc_deposit_address: address, updated_at: new Date().toISOString() })
            .eq("id", existing.id).select().single();
        if (error) return serverError(res, error, "admin/settings/btc-address");
        res.json({ success: true, message: "BTC deposit address updated.", settings: data });
    } catch (err) {
        return serverError(res, err, "admin/settings/btc-address");
    }
});

/* ==========================================================
   ADMIN — SUPPORT CHAT
========================================================== */
app.get("/admin/support/users", adminRequired, async (req, res) => {
    const { data, error } = await supabase
        .from("support_messages").select("user_id")
        .order("created_at", { ascending: false }).limit(500);
    if (error) return serverError(res, error, "admin/support/users");
    res.json({ success: true, users: [...new Set((data || []).map(m => m.user_id))] });
});

app.get("/admin/support/messages/:userId", adminRequired, async (req, res) => {
    const { data, error } = await supabase
        .from("support_messages").select("*")
        .eq("user_id", req.params.userId)
        .order("created_at", { ascending: true });
    if (error) return serverError(res, error, "admin/support/messages");
    res.json({ success: true, messages: data });
});

app.get("/admin/support/unread", adminRequired, async (req, res) => {
    const { count, error } = await supabase
        .from("support_messages").select("*", { count: "exact", head: true })
        .eq("sender", "user").eq("is_read", false);
    if (error) return serverError(res, error, "admin/support/unread");
    res.json({ success: true, unread: count || 0 });
});

app.put("/admin/support/messages/:userId/read", adminRequired, async (req, res) => {
    const { error } = await supabase
        .from("support_messages").update({ is_read: true })
        .eq("user_id", req.params.userId).eq("sender", "user").eq("is_read", false);
    if (error) return serverError(res, error, "admin/support/read");
    res.json({ success: true, message: "Messages marked as read." });
});

app.post("/admin/support/messages", adminRequired, async (req, res) => {
    try {
        const { user_id, message } = req.body;
        if (!user_id || !message || !String(message).trim()) {
            return res.status(400).json({ success: false, message: "User ID and message are required." });
        }
        const trimmed = String(message).trim().slice(0, 5000);

        const { data, error } = await supabase
            .from("support_messages")
            .insert([{ user_id, sender: "admin", message: trimmed, is_read: true }])
            .select().single();
        if (error) return serverError(res, error, "admin/support/messages");

        try {
            const { data: user } = await supabase
                .from("users").select("email, full_name").eq("id", user_id).maybeSingle();
            if (user?.email) {
                const safeFirst = escapeHtml((user.full_name || "there").split(" ")[0]);
                const safeMessage = escapeHtml(trimmed);
                await resend.emails.send({
                    from: "My Investment Support <support@myinvestments.cfd>",
                    to: user.email,
                    subject: "You have a new message from My Investment Support",
                    html: `
                        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f9fafb;">
                            <div style="background:#fff;border-radius:12px;padding:32px;">
                                <h2 style="color:#08090d;margin:0 0 8px;">Hi ${safeFirst},</h2>
                                <p style="color:#5b6473;">You have a new message from My Investment Support:</p>
                                <div style="background:#f3f4f6;border-left:3px solid #ff3b5c;padding:16px;border-radius:8px;">
                                    <p style="color:#08090d;margin:0;white-space:pre-wrap;">${safeMessage}</p>
                                </div>
                                <p style="color:#5b6473;margin-top:24px;">Please log in to your dashboard to reply.</p>
                            </div>
                        </div>
                    `
                });
            }
        } catch (emailErr) {
            console.error("❌ Email send failed:", emailErr);
        }

        res.json({ success: true, message: data });
    } catch (error) {
        return serverError(res, error, "admin/support/messages");
    }
});

app.get("/chat/notification/:userId", selfOrAdmin("userId"), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("support_messages").select("sender, created_at")
            .eq("user_id", req.params.userId)
            .order("created_at", { ascending: false }).limit(1);
        if (error) return serverError(res, error, "chat/notification");
        if (!data || data.length === 0) return res.json({ success: true, unread: false });
        res.json({ success: true, unread: data[0].sender === "admin" });
    } catch (error) {
        return serverError(res, error, "chat/notification");
    }
});

/* ==========================================================
   GLOBAL ERROR HANDLER
========================================================== */
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({ success: false, message: "File too large. Max 5 MB." });
        }
        return res.status(400).json({ success: false, message: err.message });
    }
    console.error("❌ Unhandled error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
});

process.on("unhandledRejection", (reason) => {
    console.error("❌ Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
    console.error("❌ Uncaught exception:", err);
});

/* ==========================================================
   START
========================================================== */
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await checkDB();
});