// GET /api/keepalive — called once a day by Vercel Cron (see vercel.json).
// Supabase pauses free projects after ~7 days without activity; a paused project makes
// every login fail. One tiny read a day counts as activity and keeps it awake.
// It reads nothing private: row-level security returns no rows to an anonymous key.
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    res.statusCode = 401; return res.end('unauthorized');
  }
  const url = process.env.SUPABASE_URL || 'https://zjbkhtwgfjdvidurzstl.supabase.co';
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_EJZwPW5JGCrWUHasLCsksQ_lnJVSH9W';
  const started = Date.now();
  try {
    const r = await fetch(`${url}/rest/v1/hh_patients?select=id&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = r.ok ? 200 : 502;
    res.end(JSON.stringify({ ok: r.ok, status: r.status, ms: Date.now() - started }));
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  }
}
