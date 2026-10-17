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
const upload = multer({
    storage: multer.memoryStorage()
});

// Middlewares
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

/* ---------------- HOME ---------------- */
app.get("/", (req, res) => {
    res.json({ success: true, message: "🚀 Backend is running" });
});

async function checkDB() {
    const { error } = await supabase.from("users").select("id").limit(1);
    if (error) console.log("❌ Database NOT connected:", error.message);
    else console.log("✅ Database connected successfully");
}

/* ---------------- TEST ---------------- */
app.get("/test", async (req, res) => {
    const { data, error } = await supabase.from("users").select("*");
    if (error) return res.json({ success: false, error: error.message });
    res.json({ success: true, data });
});

/* ---------------- SIGNUP: SEND CODE ---------------- */
app.post("/signup/send-code", async (req, res) => {
    const { fullName, phone, country, email, password } = req.body;

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
            is_verified: false 
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
        .update({ is_verified: true })
        .eq("email", email);

    if (updateError) {
        return res.status(500).json({ success: false, message: "Failed to verify user." });
    }

    // DO NOT DELETE THE CODE YET! 
    // We need it for the reset password step to confirm they actually verified.

    res.json({ success: true, message: "Email verified successfully." });
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
        .insert([{ full_name: fullName, phone, country, email, password, is_verified: true }]) 
        .select();

    if (error) {
        return res.status(500).json({ success: false, message: error.message });
    }

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

    if (data.is_verified === false) {
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
   ★ FORGOT PASSWORD (DATABASE STORAGE FIX)
========================================================== */
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

/* ---------------- VERIFY CODE (For Forgot Password) ---------------- */
app.post("/verify-code", async (req, res) => {
    const { email, code } = req.body;

    if (!email || !code) {
        return res.status(400).json({ success: false, message: "Email and code are required." });
    }

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

    // WE DO NOT DELETE THE CODE HERE. 
    // It stays in the database so the /reset-password route can verify it exists.

    res.json({ success: true, message: "Verification successful." });
});

/* ---------------- RESET PASSWORD (SECURE & DATABASE CHECK) ---------------- */
app.post("/reset-password", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    // 1. Check if there is a valid code in the database for this email (Proof they verified)
    const { data: resetData, error: codeErr } = await supabase
        .from("password_resets")
        .select("*")
        .eq("email", email)
        .single();

    if (codeErr || !resetData) {
        return res.status(403).json({ success: false, message: "Please verify your email first. Code expired or missing." });
    }

    if (new Date() > new Date(resetData.expires_at)) {
        await supabase.from("password_resets").delete().eq("email", email);
        return res.status(403).json({ success: false, message: "Verification session expired. Please request a new code." });
    }

    // 2. Update the password
    const { error: updateError } = await supabase
        .from("users")
        .update({ password: password })
        .eq("email", email);

    if (updateError) {
        return res.status(500).json({ success: false, message: updateError.message });
    }

    // 3. Delete the code from database now that password is changed
    await supabase.from("password_resets").delete().eq("email", email);

    res.json({ success: true, message: "Password reset successfully." });
});

/* ---------------- WITHDRAW: SEND CODE ---------------- */
app.post("/withdraw/send-code", async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ success: false, message: "Email is required." });
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

/* ---------------- CREATE WITHDRAWAL ---------------- */
app.post("/withdraw/create", async (req, res) => {
    const { user_id, email, code, method, wallet_address, amount } = req.body;

    if (!user_id || !email || !code || !method || !wallet_address || !amount) {
        return res.status(400).json({ success: false, message: "All fields are required." });
    }

    const numericAmount = Number(String(amount).replace(/,/g, "").trim());
    if (isNaN(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({ success: false, message: "Invalid withdrawal amount." });
    }

    const { data: balanceCheck, error: balErr } = await supabase
        .from("users")
        .select("balance")
        .eq("id", user_id)
        .single();

    if (balErr || !balanceCheck) {
        return res.status(404).json({ success: false, message: "User not found." });
    }

    const userBalance = Number(balanceCheck.balance || 0);
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

/* ---------------- ADMIN STATS ---------------- */
app.get("/admin/stats", async (req, res) => {
    const { count: totalUsers } = await supabase
        .from("users")
        .select("*", { count: "exact", head: true });

    res.json({ totalUsers: totalUsers || 0, totalBalance: 0, deposits: 0, withdrawals: 0 });
});

/* ---------------- ADMIN WITHDRAWALS ---------------- */
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

/* ---------------- ADMIN UNREAD WITHDRAWALS ---------------- */
app.get("/admin/unread-withdrawals", async (req, res) => {
    const { count, error } = await supabase
        .from("withdrawals")
        .select("*", { count: "exact", head: true })
        .eq("status", "Pending");

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, count: count || 0 });
});

/* ---------------- ADMIN GET SINGLE USER ---------------- */
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
    const { balance, total_trade, assets, active_assets, btc_balance, eth_balance, usdt_balance, is_suspended } = req.body;

    const { data: existingUser, error: fetchError } = await supabase
        .from("users")
        .select("balance")
        .eq("id", userId)
        .single();

    if (fetchError || !existingUser) {
        return res.status(404).json({ success: false, message: "User not found." });
    }

    const oldBalance = Number(existingUser.balance || 0);
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

/* ---------------- ADMIN UPDATE USER ASSETS ---------------- */
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

/* ---------------- ADMIN GET ALL USERS ---------------- */
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

/* ---------------- CHANGE PASSWORD ---------------- */
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

/* ---------------- CREATE DEPOSIT ---------------- */
app.post("/deposit", upload.single("receipt"), async (req, res) => {
    const { user_id, amount } = req.body;

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

    const { data: txnData, error: transactionError } = await supabase
        .from("transactions")
        .insert([{
            user_id,
            type: "Deposit",
            amount: cleanAmount,
            status: "Pending",
            description: "Bitcoin Deposit"
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
            transaction_id: transactionId
        }])
        .select();

    if (error) return res.status(500).json({ success: false, message: error.message });

    res.json({ success: true, message: "Deposit submitted successfully.", deposit: data });
});

/* ---------------- USER TRANSACTIONS ---------------- */
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

/* ---------------- ADMIN APPROVE WITHDRAWAL ---------------- */
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
        .select("balance")
        .eq("id", withdrawal.user_id)
        .single();

    const newBalance = Number(user.balance) - Number(withdrawal.amount);

    await supabase.from("users").update({ balance: newBalance }).eq("id", withdrawal.user_id);
    await supabase.from("withdrawals").update({ status: "Approved" }).eq("id", req.params.id);

    if (withdrawal.transaction_id) {
        await supabase.from("transactions").update({ status: "Approved" }).eq("id", withdrawal.transaction_id);
    }

    res.json({ success: true, message: "Withdrawal approved." });
});

/* ---------------- ADMIN REJECT WITHDRAWAL ---------------- */
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

    res.json({ success: true, message: "Withdrawal rejected." });
});

/* ---------------- ADMIN DELETE WITHDRAWAL ---------------- */
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

/* ---------------- ADMIN DEPOSITS ---------------- */
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

/* ---------------- ADMIN APPROVE DEPOSIT ---------------- */
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
        .select("balance, btc_balance")
        .eq("id", deposit.user_id)
        .single();

    const newBalance = Number(user.balance) + Number(deposit.amount);
    const newBtcBalance = Number(user.btc_balance) + Number(deposit.amount);

    await supabase.from("users").update({ balance: newBalance, btc_balance: newBtcBalance }).eq("id", deposit.user_id);
    await supabase.from("deposits").update({ status: "Approved" }).eq("id", req.params.id);

    if (deposit.transaction_id) {
        await supabase.from("transactions").update({ status: "Approved" }).eq("id", deposit.transaction_id);
    }

    res.json({ success: true, message: "Deposit approved." });
});

/* ---------------- ADMIN REJECT DEPOSIT ---------------- */
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

    res.json({ success: true, message: "Deposit rejected." });
});

/* ---------------- ADMIN NOTIFICATIONS ---------------- */
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

/* ---------------- BTC ADDRESS ---------------- */
app.get("/settings/btc-address", async (req, res) => {
    const { data, error } = await supabase
        .from("platform_settings")
        .select("btc_deposit_address")
        .limit(1)
        .single();

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, btc_deposit_address: data.btc_deposit_address || "" });
});

app.put("/admin/settings/btc-address", async (req, res) => {
    const { btc_deposit_address } = req.body;

    if (!btc_deposit_address || !btc_deposit_address.trim()) {
        return res.status(400).json({ success: false, message: "BTC deposit address is required." });
    }

    const { data: existing, error: findError } = await supabase
        .from("platform_settings")
        .select("id")
        .limit(1)
        .single();

    if (findError || !existing) return res.status(404).json({ success: false, message: "Platform settings not found." });

    const { data, error } = await supabase
        .from("platform_settings")
        .update({
            btc_deposit_address: btc_deposit_address.trim(),
            updated_at: new Date().toISOString()
        })
        .eq("id", existing.id)
        .select()
        .single();

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, message: "BTC deposit address updated.", settings: data });
});

/* ---------------- ADMIN CHAT ---------------- */
app.get("/admin/support/users", async (req, res) => {
    const { data, error } = await supabase
        .from("support_messages")
        .select("user_id")
        .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, users: [...new Set(data.map(m => m.user_id))] });
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

/* ---------------- START SERVER ---------------- */
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await checkDB();
});