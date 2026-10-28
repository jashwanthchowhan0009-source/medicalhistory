// Shared helpers for the AI endpoints — Google Gemini API.
// Files starting with "_" inside /api are not exposed as routes on Vercel.

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// content: [{ type:'text', text } | { type:'image'|'document', source:{ media_type, data(base64) } }]
export async function askAI({ system, content, maxTokens = 8192 }) {
  const key = process.env.API_KEYS_FOR_MEDH || process.env.GEMINI_API_KEY;
  if (!key) {
    throw Object.assign(new Error('Server is missing API_KEYS_FOR_MEDH. Add it in Vercel → Settings → Environment Variables, then redeploy.'), { status: 500 });
  }
  const parts = content.map((c) =>
    c.type === 'text'
      ? { text: c.text }
      : { inline_data: { mime_type: c.source.media_type, data: c.source.data } });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `AI error (${res.status})`;
    throw Object.assign(new Error(res.status === 429 ? 'AI is busy (rate limit). Try again in a minute.' : msg), { status: 502 });
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw Object.assign(new Error('AI returned an empty answer — the file may be unreadable.'), { status: 502 });
  return parseJSON(text);
}

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

// Only signed-in users may call the AI endpoints (protects the API quota).
export async function requireUser(req) {
  const url = process.env.SUPABASE_URL || 'https://zjbkhtwgfjdvidurzstl.supabase.co';
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_EJZwPW5JGCrWUHasLCsksQ_lnJVSH9W';
  const auth = req.headers.authorization || '';
  const tokenValue = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!tokenValue) throw Object.assign(new Error('Please log in again.'), { status: 401 });
  const res = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${tokenValue}` } });
  if (!res.ok) throw Object.assign(new Error('Session expired — please log in again.'), { status: 401 });
  return res.json();
}
