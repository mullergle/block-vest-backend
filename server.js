require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Resend } = require("resend");
const crypto = require("crypto");

const supabase = require("./supabase");

const resend = new Resend(process.env.RESEND_API_KEY);

// Temporary storage for verification codes
const verificationCodes = {};
const verifiedEmails = {};
const pendingSignups = {};

const CODE_EXPIRY = 10 * 60 * 1000; // 10 minutes

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({
    storage: multer.memoryStorage()
});

// Middlewares
app.use(cors());
app.use(express.json());

/* ---------------- NUMBER FORMATTER HELPER ---------------- */
function formatMoney(value) {
    const num = Number(value || 0);
    if (isNaN(num)) return "0.00";
    return num.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

/* ---------------- SAFE NUMBER CLEANER (strip commas) ---------------- */
function cleanNumber(v) {
    if (v === undefined || v === null || v === "") return v;
    const n = Number(String(v).replace(/,/g, "").trim());
    return isNaN(n) ? v : n;
}

/* ---------------- HOME ROUTE ---------------- */
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "🚀 Backend is running"
    });
});

/* ---------------- SUPABASE CHECK FUNCTION ---------------- */
async function checkDB() {
    const { error } = await supabase
        .from("users")
        .select("id")
        .limit(1);

    if (error) {
        console.log("❌ Database NOT connected:", error.message);
    } else {
        console.log("✅ Database connected successfully");
    }
}

/* ---------------- TEST ROUTE ---------------- */
app.get("/test", async (req, res) => {
    const { data, error } = await supabase
        .from("users")
        .select("*");

    if (error) {
        return res.json({
            success: false,
            error: error.message
        });
    }

    res.json({
        success: true,
        data
    });
});

/* ---------------- SEND SIGNUP VERIFICATION CODE ---------------- */

app.post("/signup/send-code", async (req, res) => {

    const {
        fullName,
        phone,
        country,
        email,
        password
    } = req.body;

    if (!email) {
        return res.status(400).json({
            success: false,
            message: "Email is required."
        });
    }

    const { data: existingUser } = await supabase
        .from("users")
        .select("id")
        .eq("email", email)
        .single();

    if (existingUser) {
        return res.json({
            success: false,
            message: "Email already exists."
        });
    }

    pendingSignups[email] = {
        fullName,
        phone,
        country,
        email,
        password
    };

    const code = crypto.randomInt(100000, 999999).toString();

    verificationCodes[email] = {
        code,
        expires: Date.now() + CODE_EXPIRY
    };

    try {

        await resend.emails.send({
            from: "Block Vest <noreply@blockvest.sbs>",
            to: email,
            subject: "Verify your Block Vest account",
            html: `
                <h2>Welcome to Block Vest</h2>
                <p>Your verification code is:</p>
                <h1>${code}</h1>
                <p>This code expires in 10 minutes.</p>
            `
        });

        res.json({
            success: true,
            message: "Verification code sent."
        });

    } catch (err) {

        console.log(err);

        res.status(500).json({
            success: false,
            message: "Unable to send verification code."
        });

    }

});

/* ---------------- VERIFY SIGNUP CODE ---------------- */

app.post("/signup/verify", async (req, res) => {

    const { email, code } = req.body;

    const savedCode = verificationCodes[email];

    if (!savedCode) {
        return res.status(401).json({
            success: false,
            message: "Verification code not found."
        });
    }

    if (Date.now() > savedCode.expires) {
        delete verificationCodes[email];

        return res.status(401).json({
            success: false,
            message: "Verification code has expired."
        });
    }

    if (savedCode.code !== code) {
        return res.status(401).json({
            success: false,
            message: "Invalid verification code."
        });
    }

    const signupInfo = pendingSignups[email];

    if (!signupInfo) {
        return res.status(400).json({
            success: false,
            message: "Signup information not found."
        });
    }

    const { data, error } = await supabase
        .from("users")
        .insert([{
            full_name: signupInfo.fullName,
            phone: signupInfo.phone,
            country: signupInfo.country,
            email: signupInfo.email,
            password: signupInfo.password
        }])
        .select();

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    delete pendingSignups[email];
    delete verificationCodes[email];

    res.json({
        success: true
    });

});

/* ---------------- SIGNUP ROUTE ---------------- */
app.post("/signup", async (req, res) => {
    const {
        fullName,
        phone,
        country,
        email,
        password
    } = req.body;

    if (!fullName || !phone || !country || !email || !password) {
        return res.status(400).json({
            success: false,
            message: "All fields are required."
        });
    }

    const { data: existingUser } = await supabase
        .from("users")
        .select("id")
        .eq("email", email)
        .single();

    if (existingUser) {
        return res.status(400).json({
            success: false,
            message: "Email already exists."
        });
    }

    const { data, error } = await supabase
        .from("users")
        .insert([{
            full_name: fullName,
            phone,
            country,
            email,
            password
        }])
        .select();

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    res.json({
        success: true,
        message: "Account created successfully.",
        user: data
    });
});

/* ---------------- LOGIN ROUTE ---------------- */
app.post("/login", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            success: false,
            message: "Email and password are required."
        });
    }

    const { data, error } = await supabase
        .from("users")
        .select("*")
        .eq("email", email)
        .eq("password", password)
        .single();

    if (error || !data) {
        return res.status(401).json({
            success: false,
            message: "Invalid email or password."
        });
    }

    if (data.is_suspended) {
        return res.status(403).json({
            success: false,
            message: "Your account has been suspended. Please contact support."
        });
    }

    console.log("Total Trade:", data.total_trade);
    console.log("Active Trade:", data.active_assets);
    console.log(data);

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
        return res.status(404).json({
            success: false,
            message: "User not found."
        });
    }

    // ✅ Raw values preserved, formatted values added separately
    const formattedUser = {
        ...data,
        balance_display:       formatMoney(data.balance),
        total_trade_display:   formatMoney(data.total_trade),
        assets_display:        formatMoney(data.assets),
        active_assets_display: formatMoney(data.active_assets),
        btc_balance_display:   formatMoney(data.btc_balance),
        eth_balance_display:   formatMoney(data.eth_balance),
        usdt_balance_display:  formatMoney(data.usdt_balance)
    };

    res.json({
        success: true,
        user: formattedUser
    });

});

/* ---------------- FORGET CODE ---------------- */

app.post("/forgot-password", async (req, res) => {

    const { email } = req.body;

    if (!email) {
        return res.status(400).json({
            success: false,
            message: "Please enter your email address."
        });
    }

    const { data: user, error } = await supabase
        .from("users")
        .select("id,email")
        .eq("email", email)
        .single();

    if (error || !user) {
        return res.json({
            success: false,
            message: "No account was found with that email address."
        });
    }

    const code = crypto.randomInt(100000, 999999).toString();

    verificationCodes[email] = {
        code: code,
        expires: Date.now() + CODE_EXPIRY
    };

    try {

        await resend.emails.send({
            from: "Block Vest <noreply@blockvest.sbs>",
            to: email,
            subject: "Block Vest Password Reset Code",
            html: `
                <h2>Block Vest Verification</h2>
                <p>Your verification code is:</p>
                <h1>${code}</h1>
                <p>This code expires soon. If you didn't request this, ignore this email.</p>
            `
        });

        res.json({
            success: true,
            message: "Verification code sent successfully."
        });

    } catch (err) {

        console.log(err);

        res.status(500).json({
            success: false,
            message: "Unable to send verification code."
        });

    }

});

/* ---------------- SEND WITHDRAWAL VERIFICATION CODE ---------------- */

app.post("/withdraw/send-code", async (req, res) => {

    const { email } = req.body;

    if (!email) {
        return res.status(400).json({
            success: false,
            message: "Email is required."
        });
    }

    const code = crypto.randomInt(100000, 999999).toString();

    verificationCodes[email] = {
        code,
        expires: Date.now() + CODE_EXPIRY
    };

    try {

        await resend.emails.send({
            from: "Block Vest <noreply@blockvest.sbs>",
            to: email,
            subject: "Block Vest Withdrawal Verification",
            html: `
                <h2>Withdrawal Verification</h2>

                <p>Your withdrawal verification code is:</p>

                <h1>${code}</h1>

                <p>This code expires in 10 minutes.</p>
            `
        });

        res.json({
            success: true,
            message: "Verification code sent successfully."
        });

    } catch (err) {

        console.log(err);

        res.status(500).json({
            success: false,
            message: "Unable to send verification code."
        });

    }

});

/* ---------------- CREATE WITHDRAWAL ---------------- */

app.post("/withdraw/create", async (req, res) => {

    const {
        user_id,
        email,
        code,
        method,
        wallet_address,
        amount
    } = req.body;

    if (!user_id || !email || !code || !method || !wallet_address || !amount) {
        return res.status(400).json({
            success: false,
            message: "All fields are required."
        });
    }

    const savedCode = verificationCodes[email];

    if (!savedCode) {
        return res.status(401).json({
            success: false,
            message: "Verification code not found."
        });
    }

    if (Date.now() > savedCode.expires) {
        delete verificationCodes[email];

        return res.status(401).json({
            success: false,
            message: "Verification code has expired."
        });
    }

    if (savedCode.code !== code) {
        return res.status(401).json({
            success: false,
            message: "Invalid verification code."
        });
    }

    const cleanAmount = cleanNumber(amount);

    const { data, error } = await supabase
        .from("withdrawals")
        .insert([{
            user_id,
            method,
            wallet_address,
            amount: cleanAmount,
            status: "Pending"
        }])
        .select();

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    await supabase
        .from("transactions")
        .insert([{
            user_id,
            type: "Withdrawal",
            amount: cleanAmount,
            status: "Pending",
            description: "Bitcoin Withdrawal"
        }]);

    res.json({
        success: true,
        message: "Withdrawal request submitted successfully.",
        withdrawal: data
    });

});

/* ---------------- VERIFY CODE ---------------- */
app.post("/verify-code", (req, res) => {

    const { email, code } = req.body;

    if (!email || !code) {
        return res.status(400).json({
            success: false,
            message: "Email and verification code are required."
        });
    }

    const savedCode = verificationCodes[email];

    if (!savedCode) {
        return res.status(401).json({
            success: false,
            message: "No verification code found."
        });
    }

    if (Date.now() > savedCode.expires) {
        delete verificationCodes[email];

        return res.status(401).json({
            success: false,
            message: "Verification code has expired. Please request a new one."
        });
    }

    if (savedCode.code !== code) {
        return res.status(401).json({
            success: false,
            message: "Invalid verification code."
        });
    }

    delete verificationCodes[email];

    verifiedEmails[email] = true;

    res.json({
        success: true,
        message: "Verification successful."
    });

});

/* ---------------- RESET PASSWORD ---------------- */
app.post("/reset-password", async (req, res) => {

    const { email, password } = req.body;

    if (!verifiedEmails[email]) {
        return res.status(403).json({
            success: false,
            message: "Please verify your email first."
        });
    }

    if (!email || !password) {
        return res.status(400).json({
            success: false,
            message: "Email and password are required."
        });
    }

    const { data: user, error } = await supabase
        .from("users")
        .select("id")
        .eq("email", email)
        .single();

    if (error || !user) {
        return res.status(404).json({
            success: false,
            message: "User not found."
        });
    }

    const { error: updateError } = await supabase
        .from("users")
        .update({
            password: password
        })
        .eq("email", email);

    if (updateError) {
        return res.status(500).json({
            success: false,
            message: updateError.message
        });
    }

    delete verifiedEmails[email];

    res.json({
        success: true,
        message: "Password reset successfully."
    });

});

/* ---------------- ADMIN STATS ---------------- */
app.get("/admin/stats", async (req, res) => {

    const { count: totalUsers } = await supabase
        .from("users")
        .select("*", { count: "exact", head: true });

    res.json({
        totalUsers: totalUsers || 0,
        totalBalance: 0,
        deposits: 0,
        withdrawals: 0
    });

});

/* ---------------- ADMIN GET ALL WITHDRAWALS ---------------- */

app.get("/admin/withdrawals", async (req, res) => {

    const { data, error } = await supabase
        .from("withdrawals")
        .select(`
            *,
            users (
                full_name,
                email
            )
        `)
        .order("created_at", { ascending: false });

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    // Keep raw amount, add display field
    const formatted = (data || []).map(w => ({
        ...w,
        amount_display: formatMoney(w.amount)
    }));

    res.json({
        success: true,
        withdrawals: formatted
    });

});

/* ---------------- UNREAD WITHDRAWALS ---------------- */

app.get("/admin/unread-withdrawals", async (req, res) => {

    const { count, error } = await supabase
        .from("withdrawals")
        .select("*", { count: "exact", head: true })
        .eq("status", "Pending");

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    res.json({
        success: true,
        count: count || 0
    });

});

/* ---------------- GET SINGLE USER (ADMIN) ---------------- */
app.get("/admin/user/:id", async (req, res) => {

    const userId = req.params.id;

    const { data, error } = await supabase
        .from("users")
        .select(`
            id,
            full_name,
            email,
            balance,
            total_trade,
            assets,
            active_assets,
            btc_balance,
            eth_balance,
            usdt_balance,
            is_suspended
        `)
        .eq("id", userId)
        .single();

    if (error || !data) {
        return res.status(404).json({
            success: false,
            message: "User not found"
        });
    }

    // Keep raw values, add display fields
    const formattedUser = {
        ...data,
        balance_display:       formatMoney(data.balance),
        total_trade_display:   formatMoney(data.total_trade),
        assets_display:        formatMoney(data.assets),
        active_assets_display: formatMoney(data.active_assets),
        btc_balance_display:   formatMoney(data.btc_balance),
        eth_balance_display:   formatMoney(data.eth_balance),
        usdt_balance_display:  formatMoney(data.usdt_balance)
    };

    return res.json({
        success: true,
        user: formattedUser
    });
});

/* ---------------- UPDATE USER (ADMIN CONTROL) ---------------- */
app.put("/admin/user/:id", async (req, res) => {

    const userId = req.params.id;

    const {
        balance,
        total_trade,
        assets,
        active_assets,
        btc_balance,
        eth_balance,
        usdt_balance,
        is_suspended
    } = req.body;

    console.log("BTC received:", btc_balance);

    const { data, error } = await supabase
        .from("users")
        .update({
            balance:       cleanNumber(balance),
            total_trade:   cleanNumber(total_trade),
            assets:        cleanNumber(assets),
            active_assets: cleanNumber(active_assets),
            btc_balance:   cleanNumber(btc_balance),
            eth_balance:   cleanNumber(eth_balance),
            usdt_balance:  cleanNumber(usdt_balance),
            is_suspended
        })
        .eq("id", userId)
        .select();

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    res.json({
        success: true,
        message: "User updated successfully",
        user: data
    });
});

/* ---------------- UPDATE USER ASSETS (ADMIN CONTROL) ---------------- */
app.put("/admin/user-assets/:id", async (req, res) => {

    const userId = req.params.id;

    const {
        btc_balance,
        eth_balance,
        usdt_balance
    } = req.body;

    const { data, error } = await supabase
        .from("users")
        .update({
            btc_balance:  cleanNumber(btc_balance),
            eth_balance:  cleanNumber(eth_balance),
            usdt_balance: cleanNumber(usdt_balance)
        })
        .eq("id", userId)
        .select();

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    res.json({
        success: true,
        message: "Assets updated successfully",
        user: data
    });
});

/* ---------------- GET ALL USERS (ADMIN) ---------------- */
app.get("/admin/users", async (req, res) => {

    const { data, error } = await supabase
        .from("users")
        .select("*")
        .eq("is_admin", false)
        .order("id", { ascending: false });

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    // Keep raw values, add display fields
    const usersWithDisplay = (data || []).map(u => ({
        ...u,
        balance_display:       formatMoney(u.balance),
        total_trade_display:   formatMoney(u.total_trade),
        assets_display:        formatMoney(u.assets),
        active_assets_display: formatMoney(u.active_assets),
        btc_balance_display:   formatMoney(u.btc_balance),
        eth_balance_display:   formatMoney(u.eth_balance),
        usdt_balance_display:  formatMoney(u.usdt_balance)
    }));

    res.json({
        success: true,
        users: usersWithDisplay
    });

});

/* ---------------- CHANGE PASSWORD ---------------- */
app.put("/change-password/:id", async (req, res) => {

    const userId = req.params.id;
    const { old_password, new_password } = req.body;

    if (!old_password || !new_password) {
        return res.status(400).json({
            success: false,
            message: "All fields are required"
        });
    }

    const { data: user, error } = await supabase
        .from("users")
        .select("*")
        .eq("id", userId)
        .single();

    if (error || !user) {
        return res.status(404).json({
            success: false,
            message: "User not found"
        });
    }

    if (user.password !== old_password) {
        return res.status(401).json({
            success: false,
            message: "Old password is incorrect"
        });
    }

    const { error: updateError } = await supabase
        .from("users")
        .update({ password: new_password })
        .eq("id", userId);

    if (updateError) {
        return res.status(500).json({
            success: false,
            message: updateError.message
        });
    }

    res.json({
        success: true,
        message: "Password updated successfully"
    });
});

/* ---------------- CREATE DEPOSIT ---------------- */
app.post("/deposit", upload.single("receipt"), async (req, res) => {
    console.log("Deposit request received");
    console.log("Body:", req.body);
    console.log("File:", req.file);

    const { user_id, amount } = req.body;

    if (!req.file) {
        return res.status(400).json({
            success: false,
            message: "Receipt is required."
        });
    }

    const fileName = `${Date.now()}-${req.file.originalname}`;

    const { error: uploadError } = await supabase.storage
        .from("receipts")
        .upload(fileName, req.file.buffer, {
            contentType: req.file.mimetype
        });

    console.log("Upload Error:", uploadError);

    if (uploadError) {
        return res.status(500).json({
            success: false,
            message: uploadError.message
        });
    }

    const { data: publicUrl } = supabase.storage
        .from("receipts")
        .getPublicUrl(fileName);

    console.log("Receipt URL:", publicUrl.publicUrl);

    const receipt_url = publicUrl.publicUrl;

    if (!user_id || !amount || !receipt_url) {
        return res.status(400).json({
            success: false,
            message: "All fields are required."
        });
    }

    const cleanAmount = cleanNumber(amount);

    const { data, error } = await supabase
        .from("deposits")
        .insert([{
            user_id,
            amount: cleanAmount,
            receipt_url,
            status: "Pending"
        }])
        .select();

    if (error) {
        console.log("Deposit Error:", error);
    }

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    const { error: transactionError } = await supabase
        .from("transactions")
        .insert([{
            user_id,
            type: "Deposit",
            amount: cleanAmount,
            status: "Pending",
            description: "Bitcoin Deposit"
        }]);

    if (transactionError) {
        console.log("Transaction Error:", transactionError);
    }

    res.json({
        success: true,
        message: "Deposit submitted successfully.",
        deposit: data
    });

});

/* ---------------- USER TRANSACTION HISTORY ---------------- */
app.get("/transactions/:userId", async (req, res) => {

    const userId = req.params.userId;

    const { data, error } = await supabase
        .from("transactions")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    // Keep raw amount, add display field
    const formatted = (data || []).map(t => ({
        ...t,
        amount_display: formatMoney(t.amount)
    }));

    res.json({
        success: true,
        transactions: formatted
    });

});

/* ---------------- APPROVE WITHDRAWAL ---------------- */

app.put("/admin/withdrawals/:id/approve", async (req, res) => {

    const withdrawalId = req.params.id;

    const { data: withdrawal, error } = await supabase
        .from("withdrawals")
        .select("*")
        .eq("id", withdrawalId)
        .single();

    if (error || !withdrawal) {
        return res.status(404).json({
            success: false,
            message: "Withdrawal not found."
        });
    }

    const { data: user } = await supabase
        .from("users")
        .select("balance")
        .eq("id", withdrawal.user_id)
        .single();

    const newBalance =
        Number(user.balance) - Number(withdrawal.amount);

    await supabase
        .from("users")
        .update({
            balance: newBalance
        })
        .eq("id", withdrawal.user_id);

    await supabase
        .from("withdrawals")
        .update({
            status: "Approved"
        })
        .eq("id", withdrawalId);

    await supabase
        .from("transactions")
        .update({
            status: "Approved"
        })
        .eq("user_id", withdrawal.user_id)
        .eq("type", "Withdrawal")
        .eq("status", "Pending");

    res.json({
        success: true,
        message: "Withdrawal approved."
    });

});

/* ---------------- REJECT WITHDRAWAL ---------------- */

app.put("/admin/withdrawals/:id/reject", async (req, res) => {

    const withdrawalId = req.params.id;

    const { data: withdrawal, error } = await supabase
        .from("withdrawals")
        .select("*")
        .eq("id", withdrawalId)
        .single();

    if (error || !withdrawal) {
        return res.status(404).json({
            success: false,
            message: "Withdrawal not found."
        });
    }

    await supabase
        .from("withdrawals")
        .update({
            status: "Rejected"
        })
        .eq("id", withdrawalId);

    await supabase
        .from("transactions")
        .update({
            status: "Rejected",
            description: "Withdrawal rejected. Please contact support service."
        })
        .eq("user_id", withdrawal.user_id)
        .eq("type", "Withdrawal")
        .eq("status", "Pending");

    res.json({
        success: true,
        message: "Withdrawal rejected."
    });

});

/* ---------------- DELETE WITHDRAWAL MESSAGE ---------------- */

app.delete("/admin/withdrawals/:id", async (req, res) => {

    const withdrawalId = req.params.id;

    const { data: withdrawal, error } = await supabase
        .from("withdrawals")
        .select("*")
        .eq("id", withdrawalId)
        .single();

    if (error || !withdrawal) {
        return res.status(404).json({
            success: false,
            message: "Withdrawal not found."
        });
    }

    const { error: deleteError } = await supabase
        .from("withdrawals")
        .delete()
        .eq("id", withdrawalId);

    if (deleteError) {
        return res.status(500).json({
            success: false,
            message: deleteError.message
        });
    }

    res.json({
        success: true,
        message: "Withdrawal deleted successfully."
    });

});

/* ---------------- ADMIN GET ALL DEPOSITS ---------------- */

app.get("/admin/deposits", async (req, res) => {

    const { data: deposits, error } = await supabase
        .from("deposits")
        .select("*")
        .order("created_at", { ascending: false });

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    for (const deposit of deposits) {

        const { data: user } = await supabase
            .from("users")
            .select("full_name,email")
            .eq("id", deposit.user_id)
            .single();

        deposit.users = user;
        deposit.amount_display = formatMoney(deposit.amount);

    }

    res.json({
        success: true,
        deposits
    });

});

/* ---------------- APPROVE DEPOSIT ---------------- */

app.put("/admin/deposits/:id/approve", async (req, res) => {

    const depositId = req.params.id;

    const { data: deposit, error } = await supabase
        .from("deposits")
        .select("*")
        .eq("id", depositId)
        .single();

    if (error || !deposit) {
        return res.status(404).json({
            success: false,
            message: "Deposit not found."
        });
    }

    if (deposit.status === "Approved") {
        return res.status(400).json({
            success: false,
            message: "Deposit has already been approved."
        });
    }

    const { data: user } = await supabase
        .from("users")
        .select("balance, btc_balance")
        .eq("id", deposit.user_id)
        .single();

    const newBalance =
        Number(user.balance) + Number(deposit.amount);

    const newBtcBalance =
        Number(user.btc_balance) + Number(deposit.amount);

    await supabase
        .from("users")
        .update({
            balance: newBalance,
            btc_balance: newBtcBalance
        })
        .eq("id", deposit.user_id);

    await supabase
        .from("deposits")
        .update({
            status: "Approved"
        })
        .eq("id", depositId);

    await supabase
        .from("transactions")
        .update({
            status: "Approved"
        })
        .eq("user_id", deposit.user_id)
        .eq("type", "Deposit")
        .eq("status", "Pending");

    res.json({
        success: true,
        message: "Deposit approved successfully."
    });

});

/* ---------------- REJECT DEPOSIT ---------------- */

app.put("/admin/deposits/:id/reject", async (req, res) => {

    const depositId = req.params.id;

    const { data: deposit, error } = await supabase
        .from("deposits")
        .select("*")
        .eq("id", depositId)
        .single();

    if (error || !deposit) {
        return res.status(404).json({
            success: false,
            message: "Deposit not found."
        });
    }

    if (deposit.status === "Rejected") {
        return res.status(400).json({
            success: false,
            message: "Deposit has already been rejected."
        });
    }

    await supabase
        .from("deposits")
        .update({
            status: "Rejected"
        })
        .eq("id", depositId);

    await supabase
        .from("transactions")
        .update({
            status: "Rejected"
        })
        .eq("user_id", deposit.user_id)
        .eq("type", "Deposit")
        .eq("status", "Pending");

    res.json({
        success: true,
        message: "Deposit rejected successfully."
    });

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

/* ---------------- SUPPORT CHAT ---------------- */

// Get messages for a user
app.get("/support/messages/:userId", async (req, res) => {

    const { userId } = req.params;

    const { data, error } = await supabase
        .from("support_messages")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    res.json({
        success: true,
        messages: data
    });

});

// Send a support message
app.post("/support/messages", async (req, res) => {

    const {
        user_id,
        message
    } = req.body;

    if (!user_id || !message) {
        return res.status(400).json({
            success: false,
            message: "User ID and message are required."
        });
    }

    const { data, error } = await supabase
        .from("support_messages")
        .insert([{
            user_id,
            sender: "user",
            message
        }])
        .select()
        .single();

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    res.json({
        success: true,
        message: data
    });

});

/* ---------------- BTC DEPOSIT ADDRESS ---------------- */

// Get current BTC deposit address
app.get("/settings/btc-address", async (req, res) => {

    const { data, error } = await supabase
        .from("platform_settings")
        .select("btc_deposit_address")
        .limit(1)
        .single();

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    res.json({
        success: true,
        btc_deposit_address: data.btc_deposit_address || ""
    });

});

// Admin update BTC deposit address
app.put("/admin/settings/btc-address", async (req, res) => {

    const { btc_deposit_address } = req.body;

    if (!btc_deposit_address || !btc_deposit_address.trim()) {
        return res.status(400).json({
            success: false,
            message: "BTC deposit address is required."
        });
    }

    const { data: existing, error: findError } = await supabase
        .from("platform_settings")
        .select("id")
        .limit(1)
        .single();

    if (findError || !existing) {
        return res.status(404).json({
            success: false,
            message: "Platform settings not found."
        });
    }

    const { data, error } = await supabase
        .from("platform_settings")
        .update({
            btc_deposit_address: btc_deposit_address.trim(),
            updated_at: new Date().toISOString()
        })
        .eq("id", existing.id)
        .select()
        .single();

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    res.json({
        success: true,
        message: "BTC deposit address updated successfully.",
        settings: data
    });

});

/* ---------------- ADMIN GET ALL CHAT USERS ---------------- */

app.get("/admin/support/users", async (req, res) => {

    const { data, error } = await supabase
        .from("support_messages")
        .select(`
            user_id,
            sender,
            message,
            created_at
        `)
        .order("created_at", { ascending: false });

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    const uniqueUsers = [];

    for (const msg of data) {

        if (!uniqueUsers.includes(msg.user_id)) {
            uniqueUsers.push(msg.user_id);
        }

    }

    res.json({
        success: true,
        users: uniqueUsers
    });

});

/* ---------------- ADMIN GET USER CHAT ---------------- */

app.get("/admin/support/messages/:userId", async (req, res) => {

    const { userId } = req.params;

    const { data, error } = await supabase
        .from("support_messages")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    res.json({
        success: true,
        messages: data
    });

});

/* ---------------- ADMIN UNREAD CHAT COUNT ---------------- */

app.get("/admin/support/unread", async (req, res) => {

    const { count, error } = await supabase
        .from("support_messages")
        .select("*", {
            count: "exact",
            head: true
        })
        .eq("sender", "user")
        .eq("is_read", false);

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    res.json({
        success: true,
        unread: count || 0
    });

});

/* ---------------- MARK USER MESSAGES AS READ ---------------- */

app.put("/admin/support/messages/:userId/read", async (req, res) => {

    const { userId } = req.params;

    const { error } = await supabase
        .from("support_messages")
        .update({
            is_read: true
        })
        .eq("user_id", userId)
        .eq("sender", "user")
        .eq("is_read", false);

    if (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

    res.json({
        success: true,
        message: "Messages marked as read."
    });

});

// ==========================================
// ADMIN - GET USERS WITH SUPPORT MESSAGES
// ==========================================

app.get("/admin/support/messages", async (req, res) => {

    try {

        const { data, error } = await supabase
            .from("support_messages")
            .select("user_id")
            .order("created_at", {
                ascending: false
            });

        if (error) {

            console.error(
                "SUPPORT USERS ERROR:",
                error
            );

            return res.status(500).json({
                success: false,
                message: error.message
            });

        }

        const userIds = [
            ...new Set(
                (data || []).map(
                    message => message.user_id
                )
            )
        ];

        res.json({
            success: true,
            users: userIds
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            message: "Unable to load support conversations"
        });

    }

});

/* ---------------- ADMIN SEND SUPPORT MESSAGE ---------------- */

app.post("/admin/support/messages", async (req, res) => {

    try {

        const {
            user_id,
            message
        } = req.body;

        if (!user_id || !message) {
            return res.status(400).json({
                success: false,
                message: "User ID and message are required."
            });
        }

        const { data, error } = await supabase
            .from("support_messages")
            .insert([{
                user_id,
                sender: "admin",
                message,
                is_read: true
            }])
            .select()
            .single();

        if (error) {

            console.error("ADMIN SUPPORT SEND ERROR:", error);

            return res.status(500).json({
                success: false,
                message: error.message
            });
        }

        res.json({
            success: true,
            message: data
        });

    } catch (error) {

        console.error("ADMIN SUPPORT ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to send support message."
        });

    }

});

/* ---------------- USER CHAT NOTIFICATION ---------------- */

app.get("/chat/notification/:userId", async (req, res) => {

    const { userId } = req.params;

    try {

        const { data, error } = await supabase
            .from("support_messages")
            .select("sender, created_at")
            .eq("user_id", userId)
            .order("created_at", {
                ascending: false
            })
            .limit(1);

        if (error) {

            console.error(
                "CHAT NOTIFICATION ERROR:",
                error
            );

            return res.status(500).json({
                success: false,
                message: error.message
            });
        }

        if (!data || data.length === 0) {

            return res.json({
                success: true,
                unread: false
            });

        }

        const latestMessage = data[0];

        if (latestMessage.sender === "admin") {

            return res.json({
                success: true,
                unread: true
            });

        }

        return res.json({
            success: true,
            unread: false
        });

    } catch (error) {

        console.error(
            "CHAT NOTIFICATION ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to check chat notification."
        });

    }

});

/* ---------------- START SERVER ---------------- */
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);

    await checkDB();
});