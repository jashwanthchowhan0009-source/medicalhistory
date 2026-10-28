// Public config — the Supabase URL and publishable key are safe to ship to the browser.
// Data is protected by Row Level Security: each user can only read/write their own rows and files.
window.HH_CONFIG = {
  supabaseUrl: '__SUPABASE_URL__',
  supabaseKey: '__SUPABASE_PUBLISHABLE_KEY__',
};
