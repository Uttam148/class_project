
// db.js — Supabase database connection

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
    throw new Error(
        'Missing SUPABASE_URL or SUPABASE_SECRET_KEY environment variable'
    );
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;