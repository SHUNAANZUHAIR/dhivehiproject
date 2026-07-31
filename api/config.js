// Returns only public, browser-safe config. SUPABASE_ANON_KEY is designed
// by Supabase to be embedded in client-side code (access is enforced by
// Row Level Security / the Auth service, not by hiding this key).
export default function handler(req, res) {
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    dailyTokenLimit: parseInt(process.env.DAILY_TOKEN_LIMIT, 10) || 100000
  });
}
