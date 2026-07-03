require("dotenv").config();
const express = require("express");
const cors = require("cors");

const supabase = require("./supabase");

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

    if (error || !data) {
        return res.status(401).json({
            success: false,
            message: "Invalid email or password."
        });
    }

    res.json({
        success: true,
        message: "Login successful.",
        is_admin: data.is_admin,
        user: data
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

    const { data, error } = await supabase
        .from("users")
        .select("*")
        .eq("id", req.params.id)
        .single();

    if (error) {
        return res.status(404).json({
            success: false,
            message: error.message
        });
    }

    res.json({
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

/* ---------------- START SERVER ---------------- */
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);

    await checkDB();
});