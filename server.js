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
/* ---------------- START SERVER ---------------- */
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);

    await checkDB();
});