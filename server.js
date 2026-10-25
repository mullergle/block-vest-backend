require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Resend } = require("resend");
const crypto = require("crypto");

const supabase = require("./supabase");

const resend = new Resend(process.env.RESEND_API_KEY);

const CODE_EXPIRY = 10 * 60 * 1000; // 10 minutes

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Temporary in-memory store for reset tokens
const inMemoryTokens = {};

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

app.use(cors());
app.use(express.json());

/* ---------------- HELPERS ---------------- */
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

/* ---------------- EMAIL TEMPLATES ---------------- */
async function sendWelcomeEmail({ to, fullName }) {
    const firstName = (fullName || "there").trim().split(" ")[0];

    const html = `
    <div style="font-family:Arial,sans-serif;background:#f9fafb;padding:32px 16px;">
        <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
            <div style="background:#08090d;padding:28px 32px;">
                <h1 style="color:#ffffff;font-size:20px;margin:0;">My Investment</h1>
            </div>
            <div style="padding:32px;">
                <h2 style="color:#08090d;font-size:22px;margin:0 0 16px;">Welcome, ${firstName}!</h2>
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
                <p style="color:#5b6473;font-size:15px;line-height:1.6;margin:0 0 8px;">
                    If you have any questions, our support team is here to assist you at any time.
                </p>
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

        if (error) console.error("❌ Welcome email failed:", error);
    } catch (err) {
        console.error("❌ Welcome email exception:", err);
    }
}

async function sendNotificationEmail({ to, fullName, title, message, amount = null, status = null, isError = false }) {
    const firstName = (fullName || "there").trim().split(" ")[0];
    const accentColor = isError ? "#f23645" : "#1ebba3";

    const html = `
    <div style="font-family:Arial,sans-serif;background:#f9fafb;padding:32px 16px;">
        <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
            <div style="background:#08090d;padding:28px 32px;">
                <h1 style="color:#ffffff;font-size:20px;margin:0;">My Investment</h1>
            </div>
            <div style="padding:32px;">
                <h2 style="color:#08090d;font-size:22px;margin:0 0 16px;">${title}</h2>
                <p style="color:#5b6473;font-size:15px;line-height:1.6;margin:0 0 16px;">
                    Hi ${firstName},
                </p>
                <p style="color:#5b6473;font-size:15px;line-height:1.6;margin:0 0 16px;">
                    ${message}
                </p>
                
                ${amount ? `
                <div style="background:#f3f4f6;border-left:4px solid ${accentColor};padding:16px;border-radius:8px;margin:24px 0;">
                    <p style="color:#5b6473;font-size:13px;margin:0 0 4px;text-transform:uppercase;font-weight:600;">Amount</p>
                    <p style="color:#08090d;font-size:24px;margin:0;font-weight:700;">$${formatMoney(amount)}</p>
                    ${status ? `<p style="color:${accentColor};font-size:14px;margin:8px 0 0;font-weight:600;">Status: ${status}</p>` : ''}
                </div>
                ` : ''}

                <div style="text-align:center;margin:28px 0;">
                    <a href="https://myinvestments.cfd" style="background:${accentColor};color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;display:inline-block;">
                        Go to Dashboard
                    </a>
                </div>
                <p style="color:#5b6473;font-size:15px;line-height:1.6;margin:0;">
                    Best regards,<br/>
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
            subject: title,
            html
        });
        if (error) console.error("❌ Notification email failed:", error);
    } catch (err) {
        console.error("❌ Notification email exception:", err);
    }
}

/* ---------------- HOME ---------------- */
app.get("/", (req, res) => {
    res.json({ success: true, message: "🚀 Backend is running" });
});

async function checkDB() {
    const { error } = await supabase.from("users").select("id").limit(1);
    if (error) console.log("❌ Database NOT connected:", error.message);
    else console.log("✅ Database connected successfully");
}

app.get("/test", async (req, res) => {
    const { data, error } = await supabase.from("users").select("*");
    if (error) return res.json({ success: false, error: error.message });
    res.json({ success: true, data });
});

/* ---------------- SIGNUP: SEND CODE ---------------- */
app.post("/signup/send-code", async (req, res) => {
    const { fullName, phone, country, email, password, referred_by } = req.body;

    if (!email) {
        return res.status(400).json({ success: false, message: "Email is required." });
    }

    const { data: existingUser } = await supabase
        .from("users")
        .select("id")
        .eq("email", email)
        .single();

    if (existingUser) {
        return res.json({ success: false, message: "Email already exists." });
    }

    const { error: dbError } = await supabase
        .from("users")
        .insert([{ 
            full_name: fullName, 
            phone, 
            country, 
            email, 
            password,
            is_verified: false,
            email_verified: false,
            referred_by: referred_by || null
        }]);

    if (dbError) {
        console.error("❌ DB INSERT ERROR:", dbError);
        return res.status(500).json({ success: false, message: "Database error: " + dbError.message });
    }

    const code = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + CODE_EXPIRY).toISOString();
    
    await supabase.from("password_resets").upsert([{ 
        email: email, 
        code: code, 
        expires_at: expiresAt
    }], { onConflict: 'email' });

    try {
        const { data, error } = await resend.emails.send({
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
            return res.status(500).json({ success: false, message: error.message || "Unable to send code." });
        }

        res.json({ success: true, message: "Verification code sent." });
    } catch (err) {
        console.log("❌ CATCH ERROR:", err);
        res.status(500).json({ success: false, message: "Unable to send code." });
    }
});

/* ---------------- SIGNUP: VERIFY ---------------- */
app.post("/signup/verify", async (req, res) => {
    const { email, code } = req.body;

    const { data: resetData, error } = await supabase
        .from("password_resets")
        .select("*")
        .eq("email", email)
        .single();

    if (error || !resetData) {
        return res.status(401).json({ success: false, message: "Verification code not found or expired." });
    }

    if (new Date() > new Date(resetData.expires_at)) {
        await supabase.from("password_resets").delete().eq("email", email);
        return res.status(401).json({ success: false, message: "Verification code has expired." });
    }

    if (resetData.code !== code) {
        return res.status(401).json({ success: false, message: "Invalid verification code." });
    }

    const { error: updateError } = await supabase
        .from("users")
        .update({ email_verified: true })
        .eq("email", email);

    if (updateError) {
        return res.status(500).json({ success: false, message: "Failed to verify email." });
    }

    const { data: verifiedUser } = await supabase
        .from("users")
        .select("full_name")
        .eq("email", email)
        .single();

    await sendWelcomeEmail({
        to: email,
        fullName: verifiedUser?.full_name
    });

    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await supabase
        .from("password_resets")
        .update({ 
            token: resetToken,
            token_expires_at: tokenExpiresAt 
        })
        .eq("email", email);

    res.json({ 
        success: true, 
        message: "Email verified successfully.",
        reset_token: resetToken
    });
});

/* ---------------- SIGNUP (DIRECT) ---------------- */
app.post("/signup", async (req, res) => {
    const { fullName, phone, country, email, password } = req.body;

    if (!fullName || !phone || !country || !email || !password) {
        return res.status(400).json({ success: false, message: "All fields are required." });
    }

    const { data: existingUser } = await supabase
        .from("users")
        .select("id")
        .eq("email", email)
        .single();

    if (existingUser) {
        return res.status(400).json({ success: false, message: "Email already exists." });
    }

    const { data, error } = await supabase
        .from("users")
        .insert([{ 
            full_name: fullName, 
            phone, 
            country, 
            email, 
            password, 
            is_verified: false,
            email_verified: true
        }]) 
        .select();

    if (error) {
        return res.status(500).json({ success: false, message: error.message });
    }

    await sendWelcomeEmail({ to: email, fullName });

    res.json({ success: true, message: "Account created.", user: data });
});

/* ---------------- LOGIN ---------------- */
app.post("/login", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: "Email and password required." });
    }

    const { data, error } = await supabase
        .from("users")
        .select("*")
        .eq("email", email)
        .eq("password", password)
        .single();

    if (error || !data) {
        return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    if (data.email_verified === false) {
        return res.status(403).json({ success: false, message: "Please verify your email address before logging in." });
    }

    if (data.is_suspended) {
        return res.status(403).json({ success: false, message: "Account suspended." });
    }

    res.json({
        success: true,
        message: "Login successful.",
        is_admin: data.is_admin,
        user: data
    });
});

/* ---------------- GET USER ---------------- */
app.get("/user/:id", async (req, res) => {
    const { data, error } = await supabase
        .from("users")
        .select("*")
        .eq("id", req.params.id)
        .single();

    if (error || !data) {
        return res.status(404).json({ success: false, message: "User not found." });
    }

    // ✅ GENERATE A CLEAN REFERRAL CODE IF MISSING
    let refCode = data.referral_code;
    if (!refCode) {
        refCode = String(data.id).split('-')[0].toUpperCase();
        await supabase.from("users").update({ referral_code: refCode }).eq("id", data.id);
    }

    const { count: referralCount } = await supabase
        .from("users")
        .select("*", { count: "exact", head: true })
        .eq("referred_by", refCode);

    const { data: txns } = await supabase
        .from("transactions")
        .select("type, amount, status")
        .eq("user_id", req.params.id);

    let totalDeposit = 0;
    let totalWithdrawal = 0;

    if (txns) {
        txns.forEach(t => {
            if (t.status === 'Approved') {
                if (t.type === 'Deposit') totalDeposit += Number(t.amount || 0);
                if (t.type === 'Withdrawal') totalWithdrawal += Number(t.amount || 0);
            }
        });
    }

    res.json({
        success: true,
        user: {
            ...data,
            referral_code: refCode,
            referral_count: referralCount || 0,
            total_earned_display: formatMoney(data.total_earned || 0),
            balance_display: formatMoney(data.balance),
            total_trade_display: formatMoney(data.total_trade),
            total_deposit_display: formatMoney(totalDeposit),
            total_withdrawal_display: formatMoney(totalWithdrawal),
            btc_balance_display: formatMoney(data.btc_balance),
            eth_balance_display: formatMoney(data.eth_balance),
            usdt_balance_display: formatMoney(data.usdt_balance)
        }
    });
});

/* ---------------- FORGOT PASSWORD ---------------- */
app.post("/forgot-password", async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ success: false, message: "Please enter your email address." });
    }

    const { data: user, error } = await supabase
        .from("users")
        .select("id,email")
        .eq("email", email)
        .single();

    if (error || !user) {
        return res.json({ success: false, message: "No account was found with that email address." });
    }

    const code = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + CODE_EXPIRY).toISOString(); 

    const { error: dbError } = await supabase
        .from("password_resets")
        .upsert([{ 
            email: email, 
            code: code, 
            expires_at: expiresAt
        }], { onConflict: 'email' });

    if (dbError) {
        console.log("DB Error:", dbError);
        return res.status(500).json({ success: false, message: "Database error." });
    }

    try {
        const { data, error } = await resend.emails.send({
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
            return res.status(500).json({ success: false, message: error.message || "Unable to send code." });
        }

        res.json({ success: true, message: "Verification code sent successfully." });
    } catch (err) {
        console.log("❌ CATCH ERROR:", err);
        res.status(500).json({ success: false, message: "Unable to send code." });
    }
});

/* ---------------- VERIFY CODE ---------------- */
app.post("/verify-code", async (req, res) => {
    let { email, code } = req.body;

    if (!email || !code) {
        return res.status(400).json({ success: false, message: "Email and code are required." });
    }

    email = email.trim().toLowerCase();

    const { data: resetData, error } = await supabase
        .from("password_resets")
        .select("*")
        .eq("email", email)
        .single();

    if (error || !resetData) {
        return res.status(401).json({ success: false, message: "No reset request found for this email." });
    }

    if (new Date() > new Date(resetData.expires_at)) {
        await supabase.from("password_resets").delete().eq("email", email);
        return res.status(401).json({ success: false, message: "Verification code expired. Request a new one." });
    }

    if (resetData.code !== code) {
        return res.status(401).json({ success: false, message: "Invalid verification code." });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    
    inMemoryTokens[email] = {
        token: resetToken,
        expires: Date.now() + 15 * 60 * 1000
    };

    await supabase
        .from("password_resets")
        .update({ 
            token: resetToken,
            token_expires_at: new Date(inMemoryTokens[email].expires).toISOString()
        })
        .eq("email", email);

    res.json({ 
        success: true, 
        message: "Verification successful.",
        reset_token: resetToken
    });
});

/* ---------------- RESET PASSWORD ---------------- */
app.post("/reset-password", async (req, res) => {
    let { email, password, token } = req.body;

    if (!email || !password || !token) {
        return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    email = email.trim().toLowerCase();

    try {
        const session = inMemoryTokens[email];

        if (!session) {
            console.log("No session found in memory for:", email);
            return res.status(403).json({ success: false, message: "Invalid session. Please request a new code." });
        }

        if (session.token !== token) {
            console.log("Token mismatch in memory.");
            return res.status(403).json({ success: false, message: "Invalid session. Please request a new code." });
        }

        if (Date.now() > session.expires) {
            delete inMemoryTokens[email];
            return res.status(403).json({ success: false, message: "Session expired. Please request a new code." });
        }

        const { error: updateError } = await supabase
            .from("users")
            .update({ password: password })
            .eq("email", email);

        if (updateError) {
            return res.status(500).json({ success: false, message: updateError.message });
        }

        delete inMemoryTokens[email];
        await supabase.from("password_resets").delete().eq("email", email);

        res.json({ success: true, message: "Password reset successfully." });

    } catch (error) {
        console.error("RESET PASSWORD ERROR:", error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});

/* ---------------- WITHDRAW ---------------- */
app.post("/withdraw/send-code", async (req, res) => {
    const { email, user_id } = req.body;

    if (!email) {
        return res.status(400).json({ success: false, message: "Email is required." });
    }

    // ✅ KYC Check: Block unverified users from requesting a withdrawal code
    if (user_id) {
        const { data: user } = await supabase
            .from("users")
            .select("is_verified, full_name")
            .eq("id", user_id)
            .single();

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        if (user.is_verified === false) {
            return res.status(403).json({ 
                success: false, 
                message: "Please complete your KYC verification before requesting a withdrawal." 
            });
        }
    }

    const code = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + CODE_EXPIRY).toISOString();
    
    await supabase.from("password_resets").upsert([{ 
        email: email, 
        code: code, 
        expires_at: expiresAt
    }], { onConflict: 'email' });

    try {
        const { data, error } = await resend.emails.send({
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
            return res.status(500).json({ success: false, message: error.message || "Unable to send code." });
        }

        res.json({ success: true, message: "Verification code sent successfully." });
    } catch (err) {
        console.log("❌ CATCH ERROR:", err);
        res.status(500).json({ success: false, message: "Unable to send code." });
    }
});

app.post("/withdraw/create", async (req, res) => {
    const { user_id, email, code, method, wallet_address, amount } = req.body;

    if (!user_id || !email || !code || !method || !wallet_address || !amount) {
        return res.status(400).json({ success: false, message: "All fields are required." });
    }

    const numericAmount = Number(String(amount).replace(/,/g, "").trim());
    if (isNaN(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({ success: false, message: "Invalid withdrawal amount." });
    }

    // ✅ KYC Check: Block unverified users from creating withdrawals
    const { data: userCheck, error: userCheckErr } = await supabase
        .from("users")
        .select("is_verified, balance")
        .eq("id", user_id)
        .single();

    if (userCheckErr || !userCheck) {
        return res.status(404).json({ success: false, message: "User not found." });
    }

    if (userCheck.is_verified === false) {
        return res.status(403).json({ 
            success: false, 
            message: "Please complete your KYC verification before requesting a withdrawal." 
        });
    }

    const userBalance = Number(userCheck.balance || 0);
    if (numericAmount > userBalance) {
        return res.status(400).json({
            success: false,
            message: `Insufficient balance. Available: $${userBalance.toFixed(2)}`
        });
    }

    const { data: resetData, error: codeErr } = await supabase
        .from("password_resets")
        .select("*")
        .eq("email", email)
        .single();

    if (codeErr || !resetData) {
        return res.status(401).json({ success: false, message: "Verification code not found." });
    }

    if (new Date() > new Date(resetData.expires_at)) {
        await supabase.from("password_resets").delete().eq("email", email);
        return res.status(401).json({ success: false, message: "Verification code expired." });
    }

    if (resetData.code !== code) {
        return res.status(401).json({ success: false, message: "Invalid verification code." });
    }

    const cleanAmount = numericAmount;

    const { data: txnData, error: txnError } = await supabase
        .from("transactions")
        .insert([{
            user_id,
            type: "Withdrawal",
            amount: cleanAmount,
            status: "Pending",
            description: "Bitcoin Withdrawal"
        }])
        .select();

    if (txnError) {
        console.log("Transaction create error:", txnError);
        return res.status(500).json({ success: false, message: "Could not create withdrawal transaction." });
    }

    const transactionId = txnData && txnData[0] ? txnData[0].id : null;

    const { data, error } = await supabase
        .from("withdrawals")
        .insert([{
            user_id,
            method,
            wallet_address,
            amount: cleanAmount,
            status: "Pending",
            transaction_id: transactionId
        }])
        .select();

    if (error) {
        return res.status(500).json({ success: false, message: error.message });
    }

    await supabase.from("password_resets").delete().eq("email", email);

    res.json({
        success: true,
        message: "Withdrawal request submitted successfully.",
        withdrawal: data
    });
});

/* ---------------- ADMIN ---------------- */
app.get("/admin/stats", async (req, res) => {
    const { count: totalUsers } = await supabase
        .from("users")
        .select("*", { count: "exact", head: true })
        .eq("is_admin", false);

    res.json({ totalUsers: totalUsers || 0, totalBalance: 0, deposits: 0, withdrawals: 0 });
});

app.get("/admin/withdrawals", async (req, res) => {
    const { data, error } = await supabase
        .from("withdrawals")
        .select(`*, users (full_name, email)`)
        .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ success: false, message: error.message });

    res.json({
        success: true,
        withdrawals: (data || []).map(w => ({ ...w, amount_display: formatMoney(w.amount) }))
    });
});

app.get("/admin/unread-withdrawals", async (req, res) => {
    const { count, error } = await supabase
        .from("withdrawals")
        .select("*", { count: "exact", head: true })
        .eq("status", "Pending");

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, count: count || 0 });
});

app.get("/admin/user/:id", async (req, res) => {
    const { data, error } = await supabase
        .from("users")
        .select(`id, full_name, email, balance, total_trade, assets, active_assets, btc_balance, eth_balance, usdt_balance, is_suspended`)
        .eq("id", req.params.id)
        .single();

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

/* ---------------- ADMIN UPDATE USER ---------------- */
app.put("/admin/user/:id", async (req, res) => {
    const userId = req.params.id;
    const { full_name, phone, balance, total_trade, assets, active_assets, btc_balance, eth_balance, usdt_balance, is_suspended } = req.body;

    const { data: existingUser, error: fetchError } = await supabase
        .from("users")
        .select("balance, full_name, phone")
        .eq("id", userId)
        .single();

    if (fetchError || !existingUser) {
        return res.status(404).json({ success: false, message: "User not found." });
    }

    const oldBalance = Number(existingUser.balance || 0);
    const newBalance = balance !== undefined ? cleanNumber(balance) : oldBalance;
    const difference = Number(newBalance || 0) - oldBalance;

    const updatePayload = {
        balance: newBalance,
        total_trade: cleanNumber(total_trade),
        assets: cleanNumber(assets),
        active_assets: cleanNumber(active_assets),
        btc_balance: cleanNumber(btc_balance),
        eth_balance: cleanNumber(eth_balance),
        usdt_balance: cleanNumber(usdt_balance),
        is_suspended
    };

    if (full_name !== undefined && full_name !== null && String(full_name).trim() !== "") {
        updatePayload.full_name = String(full_name).trim();
    }
    if (phone !== undefined && phone !== null) {
        updatePayload.phone = String(phone).trim();
    }

    const { data, error } = await supabase
        .from("users")
        .update(updatePayload)
        .eq("id", userId)
        .select();

    if (error) return res.status(500).json({ success: false, message: error.message });

    if (difference !== 0) {
        const isCredit = difference > 0;
        const absoluteAmount = Math.abs(difference);
        const { error: txnError } = await supabase
            .from("transactions")
            .insert([{
                user_id: userId,
                type: isCredit ? "Deposit" : "Withdrawal",
                amount: absoluteAmount,
                status: "Approved",
                description: isCredit ? "Credit by My Investment" : "Account adjustment by My Investment"
            }]);
        if (txnError) console.log("Transaction log error:", txnError);
    }

    res.json({ success: true, message: "User updated successfully", user: data });
});

app.put("/admin/user-assets/:id", async (req, res) => {
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

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, message: "Assets updated successfully", user: data });
});

app.get("/admin/users", async (req, res) => {
    const { data, error } = await supabase
        .from("users")
        .select("*")
        .eq("is_admin", false)
        .order("id", { ascending: false });

    if (error) return res.status(500).json({ success: false, message: error.message });

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

app.put("/change-password/:id", async (req, res) => {
    const { old_password, new_password } = req.body;

    if (!old_password || !new_password) {
        return res.status(400).json({ success: false, message: "All fields are required" });
    }

    const { data: user, error } = await supabase
        .from("users")
        .select("*")
        .eq("id", req.params.id)
        .single();

    if (error || !user) return res.status(404).json({ success: false, message: "User not found" });
    if (user.password !== old_password) return res.status(401).json({ success: false, message: "Old password incorrect" });

    const { error: updateError } = await supabase
        .from("users")
        .update({ password: new_password })
        .eq("id", req.params.id);

    if (updateError) return res.status(500).json({ success: false, message: updateError.message });
    res.json({ success: true, message: "Password updated successfully" });
});

/* ---------------- DEPOSIT ---------------- */
app.post("/deposit", upload.single("receipt"), async (req, res) => {
    const { user_id, amount, payment_method } = req.body;

    if (!req.file) return res.status(400).json({ success: false, message: "Receipt is required." });

    const numericAmount = Number(String(amount || "").replace(/,/g, "").trim());
    if (isNaN(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({ success: false, message: "Invalid deposit amount." });
    }

    const fileName = `${Date.now()}-${req.file.originalname}`;

    const { error: uploadError } = await supabase.storage
        .from("receipts")
        .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

    if (uploadError) return res.status(500).json({ success: false, message: uploadError.message });

    const { data: publicUrl } = supabase.storage.from("receipts").getPublicUrl(fileName);
    const receipt_url = publicUrl.publicUrl;

    if (!user_id || !amount || !receipt_url) {
        return res.status(400).json({ success: false, message: "All fields are required." });
    }

    const cleanAmount = numericAmount;
    const description = `${payment_method || 'Crypto'} Deposit`;

    const { data: txnData, error: transactionError } = await supabase
        .from("transactions")
        .insert([{
            user_id,
            type: "Deposit",
            amount: cleanAmount,
            status: "Pending",
            description: description 
        }])
        .select();

    if (transactionError) {
        return res.status(500).json({ success: false, message: "Could not create deposit transaction." });
    }

    const transactionId = txnData && txnData[0] ? txnData[0].id : null;

    const { data, error } = await supabase
        .from("deposits")
        .insert([{
            user_id,
            amount: cleanAmount,
            receipt_url,
            status: "Pending",
            transaction_id: transactionId,
            payment_method: payment_method 
        }])
        .select();

    if (error) return res.status(500).json({ success: false, message: error.message });

    res.json({ success: true, message: "Deposit submitted successfully.", deposit: data });
});

app.get("/transactions/:userId", async (req, res) => {
    const { data, error } = await supabase
        .from("transactions")
        .select("*")
        .eq("user_id", req.params.userId)
        .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ success: false, message: error.message });

    res.json({
        success: true,
        transactions: (data || []).map(t => ({ ...t, amount_display: formatMoney(t.amount) }))
    });
});

/* ---------------- ADMIN APPROVE/REJECT ---------------- */
app.put("/admin/withdrawals/:id/approve", async (req, res) => {
    const { data: withdrawal, error } = await supabase
        .from("withdrawals")
        .select("*")
        .eq("id", req.params.id)
        .single();

    if (error || !withdrawal) return res.status(404).json({ success: false, message: "Withdrawal not found." });
    if (withdrawal.status === "Approved") return res.status(400).json({ success: false, message: "Already approved." });

    const { data: user } = await supabase
        .from("users")
        .select("balance, full_name, email")
        .eq("id", withdrawal.user_id)
        .single();

    const newBalance = Number(user.balance) - Number(withdrawal.amount);

    await supabase.from("users").update({ balance: newBalance }).eq("id", withdrawal.user_id);
    await supabase.from("withdrawals").update({ status: "Approved" }).eq("id", req.params.id);

    if (withdrawal.transaction_id) {
        await supabase.from("transactions").update({ status: "Approved" }).eq("id", withdrawal.transaction_id);
    }

    if (user && user.email) {
        await sendNotificationEmail({
            to: user.email,
            fullName: user.full_name,
            title: "Withdrawal Approved",
            message: "Your withdrawal request has been successfully processed and sent to your wallet.",
            amount: withdrawal.amount,
            status: "Approved",
            isError: false
        });
    }

    res.json({ success: true, message: "Withdrawal approved." });
});

app.put("/admin/withdrawals/:id/reject", async (req, res) => {
    const { data: withdrawal, error } = await supabase
        .from("withdrawals")
        .select("*")
        .eq("id", req.params.id)
        .single();

    if (error || !withdrawal) return res.status(404).json({ success: false, message: "Withdrawal not found." });
    if (withdrawal.status === "Rejected") return res.status(400).json({ success: false, message: "Already rejected." });

    await supabase.from("withdrawals").update({ status: "Rejected" }).eq("id", req.params.id);

    if (withdrawal.transaction_id) {
        await supabase.from("transactions").update({
            status: "Rejected",
            description: "Withdrawal rejected. Please contact support."
        }).eq("id", withdrawal.transaction_id);
    }

    const { data: user } = await supabase
        .from("users")
        .select("full_name, email")
        .eq("id", withdrawal.user_id)
        .single();

    if (user && user.email) {
        await sendNotificationEmail({
            to: user.email,
            fullName: user.full_name,
            title: "Withdrawal Rejected",
            message: "Your recent withdrawal request was rejected. Please contact support for more information. Your funds have not been deducted.",
            amount: withdrawal.amount,
            status: "Rejected",
            isError: true
        });
    }

    res.json({ success: true, message: "Withdrawal rejected." });
});

app.delete("/admin/withdrawals/:id", async (req, res) => {
    const { data: withdrawal, error } = await supabase
        .from("withdrawals")
        .select("*")
        .eq("id", req.params.id)
        .single();

    if (error || !withdrawal) return res.status(404).json({ success: false, message: "Withdrawal not found." });

    const { error: deleteError } = await supabase.from("withdrawals").delete().eq("id", req.params.id);

    if (deleteError) return res.status(500).json({ success: false, message: deleteError.message });
    res.json({ success: true, message: "Withdrawal deleted successfully." });
});

app.get("/admin/deposits", async (req, res) => {
    const { data: deposits, error } = await supabase
        .from("deposits")
        .select("*")
        .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ success: false, message: error.message });

    for (const deposit of deposits) {
        const { data: user } = await supabase
            .from("users")
            .select("full_name,email")
            .eq("id", deposit.user_id)
            .single();
        deposit.users = user;
        deposit.amount_display = formatMoney(deposit.amount);
    }

    res.json({ success: true, deposits });
});

app.put("/admin/deposits/:id/approve", async (req, res) => {
    const { data: deposit, error } = await supabase
        .from("deposits")
        .select("*")
        .eq("id", req.params.id)
        .single();

    if (error || !deposit) return res.status(404).json({ success: false, message: "Deposit not found." });
    if (deposit.status === "Approved") return res.status(400).json({ success: false, message: "Already approved." });

    const { data: user } = await supabase
        .from("users")
        .select("balance, btc_balance, full_name, email")
        .eq("id", deposit.user_id)
        .single();

    const newBalance = Number(user.balance) + Number(deposit.amount);
    const newBtcBalance = Number(user.btc_balance) + Number(deposit.amount);

    await supabase.from("users").update({ balance: newBalance, btc_balance: newBtcBalance }).eq("id", deposit.user_id);
    await supabase.from("deposits").update({ status: "Approved" }).eq("id", req.params.id);

    if (deposit.transaction_id) {
        await supabase.from("transactions").update({ status: "Approved" }).eq("id", deposit.transaction_id);
    }

    if (user && user.email) {
        await sendNotificationEmail({
            to: user.email,
            fullName: user.full_name,
            title: "Deposit Approved",
            message: "Great news! Your deposit has been verified and the funds are now available in your account.",
            amount: deposit.amount,
            status: "Approved",
            isError: false
        });
    }

    res.json({ success: true, message: "Deposit approved." });
});

app.put("/admin/deposits/:id/reject", async (req, res) => {
    const { data: deposit, error } = await supabase
        .from("deposits")
        .select("*")
        .eq("id", req.params.id)
        .single();

    if (error || !deposit) return res.status(404).json({ success: false, message: "Deposit not found." });
    if (deposit.status === "Rejected") return res.status(400).json({ success: false, message: "Already rejected." });

    await supabase.from("deposits").update({ status: "Rejected" }).eq("id", req.params.id);

    if (deposit.transaction_id) {
        await supabase.from("transactions").update({ status: "Rejected" }).eq("id", deposit.transaction_id);
    }

    const { data: user } = await supabase
        .from("users")
        .select("full_name, email")
        .eq("id", deposit.user_id)
        .single();

    if (user && user.email) {
        await sendNotificationEmail({
            to: user.email,
            fullName: user.full_name,
            title: "Deposit Rejected",
            message: "Your deposit request was rejected. This usually happens if the payment receipt is invalid or the funds were not received. Please contact support.",
            amount: deposit.amount,
            status: "Rejected",
            isError: true
        });
    }

    res.json({ success: true, message: "Deposit rejected." });
});

app.get("/admin/notifications", async (req, res) => {
    const { count: deposits } = await supabase
        .from("deposits")
        .select("*", { count: "exact", head: true })
        .eq("status", "Pending");

    const { count: withdrawals } = await supabase
        .from("withdrawals")
        .select("*", { count: "exact", head: true })
        .eq("status", "Pending");

    res.json({
        success: true,
        pendingDeposits: deposits || 0,
        pendingWithdrawals: withdrawals || 0
    });
});

/* ---------------- SUPPORT ---------------- */
app.get("/support/messages/:userId", async (req, res) => {
    const { data, error } = await supabase
        .from("support_messages")
        .select("*")
        .eq("user_id", req.params.userId)
        .order("created_at", { ascending: true });

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, messages: data });
});

app.post("/support/messages", async (req, res) => {
    const { user_id, message } = req.body;

    if (!user_id || !message) {
        return res.status(400).json({ success: false, message: "User ID and message are required." });
    }

    const { data, error } = await supabase
        .from("support_messages")
        .insert([{ user_id, sender: "user", message }])
        .select()
        .single();

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, message: data });
});

/* ---------------- DEPOSIT ADDRESSES ---------------- */
app.get("/settings/deposit-addresses", async (req, res) => {
    const { data, error } = await supabase
        .from("platform_settings")
        .select("*")
        .limit(1)
        .single();

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, addresses: data });
});

app.put("/admin/settings/deposit-addresses", async (req, res) => {
    const {
        btc_deposit_address,
        eth_deposit_address,
        usdt_deposit_address,
        trx_deposit_address,
        sol_deposit_address
    } = req.body;

    const { data: existing, error: findError } = await supabase
        .from("platform_settings")
        .select("id")
        .limit(1)
        .single();

    if (findError || !existing) {
        return res.status(404).json({ success: false, message: "Platform settings row not found." });
    }

    const updatePayload = { updated_at: new Date().toISOString() };

    if (btc_deposit_address !== undefined) updatePayload.btc_deposit_address = btc_deposit_address;
    if (eth_deposit_address !== undefined) updatePayload.eth_deposit_address = eth_deposit_address;
    if (usdt_deposit_address !== undefined) updatePayload.usdt_deposit_address = usdt_deposit_address;
    if (trx_deposit_address !== undefined) updatePayload.trx_deposit_address = trx_deposit_address;
    if (sol_deposit_address !== undefined) updatePayload.sol_deposit_address = sol_deposit_address;

    const { data, error } = await supabase
        .from("platform_settings")
        .update(updatePayload)
        .eq("id", existing.id)
        .select()
        .single();

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, message: "Deposit addresses updated successfully.", addresses: data });
});

/* ---------------- USER KYC SUBMISSION ---------------- */
app.post("/kyc", upload.fields([
    { name: 'front_image', maxCount: 1 },
    { name: 'back_image', maxCount: 1 }
]), async (req, res) => {
    try {
        const { user_id, document_type, document_number } = req.body;

        if (!user_id || !document_type || !document_number || !req.files['front_image']) {
            return res.status(400).json({ success: false, message: "All required fields must be provided." });
        }

        const { data: existingKyc } = await supabase
            .from("kyc_requests")
            .select("id, status")
            .eq("user_id", user_id)
            .in("status", ["Pending", "Approved"])
            .single();

        if (existingKyc) {
            return res.status(400).json({ 
                success: false, 
                message: `You already have a ${existingKyc.status.toLowerCase()} KYC request.` 
            });
        }

        const frontFile = req.files['front_image'][0];
        const frontFileName = `kyc-${user_id}-${Date.now()}-front.${frontFile.originalname.split('.').pop()}`;
        
        const { error: frontErr } = await supabase.storage
            .from("kyc_documents")
            .upload(frontFileName, frontFile.buffer, { contentType: frontFile.mimetype });

        if (frontErr) throw new Error("Failed to upload front image: " + frontErr.message);

        const { data: frontUrlData } = supabase.storage.from("kyc_documents").getPublicUrl(frontFileName);

        let back_image_url = null;
        if (req.files['back_image']) {
            const backFile = req.files['back_image'][0];
            const backFileName = `kyc-${user_id}-${Date.now()}-back.${backFile.originalname.split('.').pop()}`;
            
            const { error: backErr } = await supabase.storage
                .from("kyc_documents")
                .upload(backFileName, backFile.buffer, { contentType: backFile.mimetype });

            if (backErr) throw new Error("Failed to upload back image: " + backErr.message);

            const { data: backUrlData } = supabase.storage.from("kyc_documents").getPublicUrl(backFileName);
            back_image_url = backUrlData.publicUrl;
        }

        const { data, error } = await supabase
            .from("kyc_requests")
            .insert([{
                user_id,
                document_type,
                document_number,
                front_image_url: frontUrlData.publicUrl,
                back_image_url: back_image_url,
                status: "Pending"
            }])
            .select();

        if (error) throw error;

        res.json({ success: true, message: "KYC submitted successfully.", kyc: data[0] });

    } catch (error) {
        console.error("KYC SUBMIT ERROR:", error);
        res.status(500).json({ success: false, message: error.message || "Failed to submit KYC." });
    }
});

app.get("/kyc/status/:userId", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("kyc_requests")
            .select("*")
            .eq("user_id", req.params.userId)
            .order("created_at", { ascending: false })
            .limit(1)
            .single();

        if (error && error.code === 'PGRST116') {
            return res.json({ success: true, kyc: null });
        }

        if (error) throw error;

        res.json({ 
            success: true, 
            kyc: {
                status: data.status,
                document_type: data.document_type,
                submitted_at: data.created_at,
                rejection_reason: data.rejection_reason || null
            } 
        });

    } catch (error) {
        console.error("KYC STATUS ERROR:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/* ---------------- ADMIN KYC ---------------- */
app.get("/admin/kyc", async (req, res) => {
    const { data, error } = await supabase
        .from("kyc_requests")
        .select("*")
        .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ success: false, message: error.message });

    const enriched = [];
    for (const k of (data || [])) {
        const { data: user } = await supabase
            .from("users")
            .select("full_name, email")
            .eq("id", k.user_id)
            .single();

        enriched.push({
            ...k,
            full_name: user?.full_name || "Unknown",
            email: user?.email || "N/A"
        });
    }

    res.json({ success: true, requests: enriched });
});

app.put("/admin/kyc/:id/approve", async (req, res) => {
    const { data: kyc, error } = await supabase
        .from("kyc_requests")
        .select("*")
        .eq("id", req.params.id)
        .single();

    if (error || !kyc) return res.status(404).json({ success: false, message: "KYC request not found." });
    if (kyc.status === "Approved") return res.status(400).json({ success: false, message: "Already approved." });

    const { error: updateKycError } = await supabase
        .from("kyc_requests")
        .update({ status: "Approved" })
        .eq("id", req.params.id);

    if (updateKycError) return res.status(500).json({ success: false, message: updateKycError.message });

    await supabase
        .from("users")
        .update({ is_verified: true })
        .eq("id", kyc.user_id);

    const { data: user } = await supabase
        .from("users")
        .select("full_name, email")
        .eq("id", kyc.user_id)
        .single();

    if (user && user.email) {
        await sendNotificationEmail({
            to: user.email,
            fullName: user.full_name,
            title: "KYC Verification Approved",
            message: "Congratulations! Your identity has been successfully verified. Your account now has full access to all platform features and higher withdrawal limits.",
            isError: false
        });
    }

    res.json({ success: true, message: "KYC approved successfully." });
});

app.put("/admin/kyc/:id/reject", async (req, res) => {
    const { rejection_reason } = req.body;

    const { data: kyc, error } = await supabase
        .from("kyc_requests")
        .select("*")
        .eq("id", req.params.id)
        .single();

    if (error || !kyc) return res.status(404).json({ success: false, message: "KYC request not found." });
    if (kyc.status === "Rejected") return res.status(400).json({ success: false, message: "Already rejected." });

    await supabase
        .from("kyc_requests")
        .update({ 
            status: "Rejected",
            rejection_reason: rejection_reason || "Document unclear or invalid."
        })
        .eq("id", req.params.id);

    await supabase
        .from("users")
        .update({ is_verified: false })
        .eq("id", kyc.user_id);

    const { data: user } = await supabase
        .from("users")
        .select("full_name, email")
        .eq("id", kyc.user_id)
        .single();

    if (user && user.email) {
        const reason = rejection_reason || "Document unclear or invalid.";
        await sendNotificationEmail({
            to: user.email,
            fullName: user.full_name,
            title: "KYC Verification Rejected",
            message: `Unfortunately, we could not verify your identity. Reason: ${reason}. Please log in to your dashboard and resubmit valid documents.`,
            isError: true
        });
    }

    res.json({ success: true, message: "KYC rejected." });
});

/* ---------------- ADMIN CHAT ---------------- */
app.get("/admin/support/users", async (req, res) => {
    try {
        const { data: messages, error } = await supabase
            .from("support_messages")
            .select("user_id")
            .order("created_at", { ascending: false });

        if (error) throw error;

        const uniqueUserIds = [...new Set(messages.map(m => m.user_id))];
        const usersList = [];

        for (const id of uniqueUserIds) {
            const { data: user } = await supabase
                .from("users")
                .select("id, full_name, email")
                .eq("id", id)
                .single();
            
            if (user) {
                usersList.push(user);
            } else {
                usersList.push({ id, full_name: "Unknown User", email: "N/A" });
            }
        }

        res.json({ success: true, users: usersList });
    } catch (error) {
        console.error("FETCH SUPPORT USERS ERROR:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get("/admin/support/messages/:userId", async (req, res) => {
    const { data, error } = await supabase
        .from("support_messages")
        .select("*")
        .eq("user_id", req.params.userId)
        .order("created_at", { ascending: true });

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, messages: data });
});

app.get("/admin/support/unread", async (req, res) => {
    const { count, error } = await supabase
        .from("support_messages")
        .select("*", { count: "exact", head: true })
        .eq("sender", "user")
        .eq("is_read", false);

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, unread: count || 0 });
});

/* ---------------- ADMIN: PER-USER SUPPORT STATUS (NEW) ---------------- */
app.get("/admin/support/user-status", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("support_messages")
            .select("user_id, sender, is_read");
        if (error) throw error;

        const statusMap = {};
        (data || []).forEach(m => {
            const entry = statusMap[m.user_id] || { has_messages: false, unread: 0 };
            entry.has_messages = true;
            if (m.sender === "user" && m.is_read === false) entry.unread += 1;
            statusMap[m.user_id] = entry;
        });

        res.json({ success: true, status: statusMap });
    } catch (err) {
        console.error("SUPPORT STATUS ERROR:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put("/admin/support/messages/:userId/read", async (req, res) => {
    const { error } = await supabase
        .from("support_messages")
        .update({ is_read: true })
        .eq("user_id", req.params.userId)
        .eq("sender", "user")
        .eq("is_read", false);

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, message: "Messages marked as read." });
});

app.post("/admin/support/messages", async (req, res) => {
    try {
        const { user_id, message } = req.body;

        if (!user_id || !message) {
            return res.status(400).json({ success: false, message: "User ID and message are required." });
        }

        const { data, error } = await supabase
            .from("support_messages")
            .insert([{ user_id, sender: "admin", message, is_read: true }])
            .select()
            .single();

        if (error) return res.status(500).json({ success: false, message: error.message });

        try {
            const { data: user } = await supabase
                .from("users")
                .select("email, full_name")
                .eq("id", user_id)
                .single();

            if (user && user.email) {
                await resend.emails.send({
                    from: "My Investment Support <support@myinvestments.cfd>",
                    to: user.email,
                    subject: "You have a new message from My Investment Support",
                    html: `
                        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f9fafb;">
                            <div style="background:#fff;border-radius:12px;padding:32px;">
                                <h2 style="color:#08090d;margin:0 0 8px;">Hi ${(user.full_name || "there").split(" ")[0]},</h2>
                                <p style="color:#5b6473;">You have a new message from My Investment Support:</p>
                                <div style="background:#f3f4f6;border-left:3px solid #ff3b5c;padding:16px;border-radius:8px;">
                                    <p style="color:#08090d;margin:0;white-space:pre-wrap;">${message}</p>
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
        console.error("ADMIN SUPPORT ERROR:", error);
        res.status(500).json({ success: false, message: "Unable to send support message." });
    }
});

app.get("/chat/notification/:userId", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("support_messages")
            .select("sender, created_at")
            .eq("user_id", req.params.userId)
            .order("created_at", { ascending: false })
            .limit(1);

        if (error) return res.status(500).json({ success: false, message: error.message });
        if (!data || data.length === 0) return res.json({ success: true, unread: false });
        res.json({ success: true, unread: data[0].sender === "admin" });
    } catch (error) {
        console.error("CHAT NOTIFICATION ERROR:", error);
        res.status(500).json({ success: false, message: "Unable to check chat notification." });
    }
});

/* ---------------- EXECUTE TRADE ---------------- */
app.post("/trade", async (req, res) => {
    const { user_id, trade_type, pair, action, amount, lot_size, stop_loss } = req.body;

    if (!user_id || !trade_type || !pair || !action || !amount) {
        return res.status(400).json({ success: false, message: "Missing required trade details." });
    }

    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({ success: false, message: "Invalid trade amount." });
    }

    try {
        const { data: user, error: userErr } = await supabase
            .from("users")
            .select("balance")
            .eq("id", user_id)
            .single();

        if (userErr || !user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        const currentBalance = Number(user.balance || 0);
        if (numericAmount > currentBalance) {
            return res.status(400).json({ 
                success: false, 
                message: `Insufficient balance. Available: $${currentBalance.toFixed(2)}` 
            });
        }

        const newBalance = currentBalance - numericAmount;
        await supabase.from("users").update({ balance: newBalance }).eq("id", user_id);

        const description = `${action} ${pair} (${lot_size} lots)${stop_loss ? ` | SL: ${stop_loss}` : ''}`;
        
        const { data: txnData, error: txnError } = await supabase
            .from("transactions")
            .insert([{
                user_id,
                type: trade_type,
                amount: numericAmount,
                status: "Approved",
                description: description
            }])
            .select();

        if (txnError) {
            await supabase.from("users").update({ balance: currentBalance }).eq("id", user_id);
            console.error("Trade log error:", txnError);
            return res.status(500).json({ success: false, message: "Failed to log trade." });
        }

        res.json({ 
            success: true, 
            message: `${action} order for ${pair} executed successfully!`,
            new_balance: newBalance,
            trade: txnData[0]
        });

    } catch (error) {
        console.error("TRADE ERROR:", error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});

/* ================================================================ */
/* ============= COPY TRADING WITH P&L SIMULATION ================= */
/* ================================================================ */

/* ---- 1. Execute a copy trade (deducts money, creates position) ---- */
app.post("/copy-trade/execute", async (req, res) => {
    try {
        const { user_id, trader_name, trader_badge, amount } = req.body;
        
        if (!user_id || !trader_name || !amount) {
            return res.status(400).json({ success: false, message: "User ID, trader name, and amount are required." });
        }

        const numericAmount = Number(amount);
        if (isNaN(numericAmount) || numericAmount <= 0) {
            return res.status(400).json({ success: false, message: "Invalid copy amount." });
        }

        const { data: user, error: userErr } = await supabase
            .from("users")
            .select("balance, full_name, email")
            .eq("id", user_id)
            .single();

        if (userErr || !user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        const userBalance = Number(user.balance || 0);
        if (numericAmount > userBalance) {
            return res.status(400).json({ 
                success: false, 
                message: `Insufficient balance. Available: $${userBalance.toFixed(2)}` 
            });
        }

        const { data: existing } = await supabase
            .from("copy_trades")
            .select("id")
            .eq("user_id", user_id)
            .eq("trader_name", trader_name)
            .single();

        if (existing) {
            return res.status(400).json({ success: false, message: "You are already copying this trader." });
        }

        const newBalance = userBalance - numericAmount;
        await supabase.from("users").update({ balance: newBalance }).eq("id", user_id);

        const { data: copy, error: copyErr } = await supabase
            .from("copy_trades")
            .insert([{
                user_id,
                trader_name,
                trader_badge: trader_badge || 'Expert',
                amount: numericAmount,
                current_value: numericAmount,
                last_pnl_update: new Date().toISOString()
            }])
            .select()
            .single();

        if (copyErr) {
            await supabase.from("users").update({ balance: userBalance }).eq("id", user_id);
            throw copyErr;
        }

        await supabase.from("transactions").insert([{
            user_id,
            type: "Copy Trade",
            amount: numericAmount,
            status: "Approved",
            description: `Started copying ${trader_name}`
        }]);

        res.json({ 
            success: true, 
            message: `You are now copying ${trader_name} with $${numericAmount.toFixed(2)}.`,
            copy: copy,
            new_balance: newBalance
        });
    } catch (err) {
        console.error("COPY EXECUTE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to execute copy trade." });
    }
});

/* ---- 2. Unfollow (returns current value to balance) ---- */
app.delete("/copy-trade/unfollow/:trader_name", async (req, res) => {
    try {
        const { user_id } = req.query;
        const traderName = decodeURIComponent(req.params.trader_name);
        
        if (!user_id) return res.status(400).json({ success: false, message: "User ID is required." });

        const { data: copy, error: copyErr } = await supabase
            .from("copy_trades")
            .select("*")
            .eq("user_id", user_id)
            .eq("trader_name", traderName)
            .single();

        if (copyErr || !copy) {
            return res.status(404).json({ success: false, message: "Copy trade not found." });
        }

        const returnAmount = Number(copy.current_value || copy.amount || 0);

        const { data: user } = await supabase
            .from("users")
            .select("balance")
            .eq("id", user_id)
            .single();

        const newBalance = Number(user.balance || 0) + returnAmount;
        await supabase.from("users").update({ balance: newBalance }).eq("id", user_id);

        await supabase.from("copy_trades").delete().eq("id", copy.id);

        await supabase.from("transactions").insert([{
            user_id,
            type: "Copy Trade",
            amount: returnAmount,
            status: "Approved",
            description: `Stopped copying ${traderName} — returned $${returnAmount.toFixed(2)}`
        }]);

        const profit = returnAmount - Number(copy.amount || 0);

        res.json({ 
            success: true, 
            message: `You stopped copying ${traderName}. $${returnAmount.toFixed(2)} returned to your balance.`,
            returned: returnAmount,
            profit: profit,
            new_balance: newBalance
        });
    } catch (err) {
        console.error("COPY UNFOLLOW ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to unfollow trader." });
    }
});

/* ---- 3. Get user's active copy trades ---- */
app.get("/copy-trade/mine/:user_id", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("copy_trades")
            .select("*")
            .eq("user_id", req.params.user_id)
            .order("created_at", { ascending: false });

        if (error) throw error;
        res.json({ success: true, trades: data || [] });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to load copy trades." });
    }
});

/* ---- 4. Hourly P&L simulation job ---- */
setInterval(async () => {
    try {
        console.log("⏰ Running hourly P&L simulation...");

        const { data: activeCopies, error } = await supabase
            .from("copy_trades")
            .select("id, amount, current_value");

        if (error || !activeCopies || activeCopies.length === 0) {
            console.log("No active copies to update.");
            return;
        }

        for (const copy of activeCopies) {
            const changePercent = (Math.random() * 4 - 2);
            const currentValue = Number(copy.current_value || copy.amount);
            const newValue = Math.max(0, currentValue * (1 + changePercent / 100));

            await supabase
                .from("copy_trades")
                .update({ 
                    current_value: parseFloat(newValue.toFixed(2)),
                    last_pnl_update: new Date().toISOString()
                })
                .eq("id", copy.id);
        }

        console.log(`✅ Updated ${activeCopies.length} copy trades.`);
    } catch (err) {
        console.error("P&L SIMULATION ERROR:", err);
    }
}, 60 * 60 * 1000);

/* ---------------- START SERVER ---------------- */
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await checkDB();
});