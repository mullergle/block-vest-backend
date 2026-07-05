require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Resend } = require("resend");
const crypto = require("crypto");

const supabase = require("./supabase");

const resend = new Resend(process.env.RESEND_API_KEY);

// Temporary storage for verification codes
const verificationCodes = {};
const verifiedEmails = {};
const CODE_EXPIRY = 10 * 60 * 1000; // 10 minutes

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

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

    // Check if email already exists
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

    // Wrong email or password
    if (error || !data) {
        return res.status(401).json({
            success: false,
            message: "Invalid email or password."
        });
    }

    // 🚫 Block suspended accounts
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

    // Generate 6-digit code
    const code = crypto.randomInt(100000, 999999).toString();

    // Save code temporarily
    verificationCodes[email] = {
    code: code,
    expires: Date.now() + CODE_EXPIRY
};

    try {

        await resend.emails.send({
            from: "Block Vest <onboarding@resend.dev>",
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

// Mark this email as verified
verifiedEmails[email] = true;

// Remove the verification code so it can't be used again
delete verificationCodes[email];

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

    // Remove verification after password reset
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

/* ---------------- GET SINGLE USER ---------------- */
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

    return res.json({
        success: true,
        user: data
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
    balance,
    total_trade,
    assets,
    active_assets,
    btc_balance,
    eth_balance,
    usdt_balance,
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
            btc_balance,
            eth_balance,
            usdt_balance
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

    res.json({
        success: true,
        users: data
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

    // get user
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

    // check old password
    if (user.password !== old_password) {
        return res.status(401).json({
            success: false,
            message: "Old password is incorrect"
        });
    }

    // update password
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
app.post("/deposit", async (req, res) => {

    const { user_id, amount, receipt_url } = req.body;

    if (!user_id || !amount || !receipt_url) {
        return res.status(400).json({
            success: false,
            message: "All fields are required."
        });
    }

    const { data, error } = await supabase
        .from("deposits")
        .insert([{
            user_id,
            amount,
            receipt_url,
            status: "Pending"
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
        message: "Deposit submitted successfully.",
        deposit: data
    });

});
/* ---------------- START SERVER ---------------- */
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);

    await checkDB();
});