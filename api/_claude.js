// Shared helper for calling the Claude API (Anthropic Messages API).
// Files starting with "_" inside /api are not exposed as routes on Vercel.

const API_URL = 'https://api.anthropic.com/v1/messages';

export async function askClaude({ system, content, maxTokens = 4096 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const err = new Error('Server is missing ANTHROPIC_API_KEY. Add it in Vercel → Project → Settings → Environment Variables.');
    err.status = 500;
    throw err;
  }
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Claude API error (${res.status})`);
    err.status = 502;
    throw err;
  }
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseJSON(text);
}

// Pull the first JSON object out of the model's reply.
export function parseJSON(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw Object.assign(new Error('AI returned an unreadable answer'), { status: 502 });
  return JSON.parse(cleaned.slice(start, end + 1));
}

export function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export function send(res, status, obj) {
  res.status(status).setHeader('content-type', 'application/json').send(JSON.stringify(obj));
}

// Only signed-in users may call the AI endpoints (protects API credits).
// Verifies the Supabase access token sent as "Authorization: Bearer <token>".
export async function requireUser(req) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw Object.assign(new Error('Server is missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY.'), { status: 500 });
  }
  const auth = req.headers.authorization || '';
  const tokenValue = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!tokenValue) throw Object.assign(new Error('Please log in again.'), { status: 401 });
  const res = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${tokenValue}` } });
  if (!res.ok) throw Object.assign(new Error('Session expired — please log in again.'), { status: 401 });
  return res.json();
}
