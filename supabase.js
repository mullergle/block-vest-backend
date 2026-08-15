const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_KEY;

console.log("SUPABASE_URL exists:", !!url);
console.log("SUPABASE_KEY exists:", !!key);

if (!url) {
    throw new Error("SUPABASE_URL is missing");
}

if (!key) {
    throw new Error("SUPABASE_KEY is missing");
}

try {
    console.log("Supabase host:", new URL(url).hostname);
} catch (error) {
    throw new Error("SUPABASE_URL is not a valid URL");
}

const supabase = createClient(url, key, {
    auth: {
        persistSession: false,
        autoRefreshToken: false
    }
});

module.exports = supabase;