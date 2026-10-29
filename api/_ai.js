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

  const call = (extra) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0, maxOutputTokens: maxTokens, responseMimeType: 'application/json', ...extra },
    }),
  });
  // careful reading: enough thinking to double-check digits, and full-detail images for small print
  let res = await call({ thinkingConfig: { thinkingBudget: 4096 }, mediaResolution: 'MEDIA_RESOLUTION_HIGH' });
  if (res.status === 400) res = await call({ thinkingConfig: { thinkingBudget: 2048 } }); // older model/API: drop optional settings
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `AI error (${res.status})`;
    throw Object.assign(new Error(res.status === 429 ? 'AI is busy (rate limit). Try again in a minute.' : msg), { status: 502 });
  }
  const cand = data.candidates?.[0] || {};
  const text = (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  if (cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT') {
    throw Object.assign(new Error('The AI refused to read this file.'), { status: 422 });
  }
  if (!text) throw Object.assign(new Error('AI returned an empty answer — the file may be unreadable.'), { status: 502 });
  try {
    return parseJSON(text);
  } catch (e) {
    const truncated = cand.finishReason === 'MAX_TOKENS';
    throw Object.assign(new Error(truncated ? 'Too much to read in one go.' : 'AI returned an unreadable answer'), { status: 502, code: truncated ? 'TOO_LONG' : 'BAD_JSON' });
  }
}

// Plain-text answer grounded in Google Search. Returns { text, sources: [{ title, url }] }.
export async function askAIWeb({ system, content, maxTokens = 2048 }) {
  const key = process.env.API_KEYS_FOR_MEDH || process.env.GEMINI_API_KEY;
  if (!key) throw Object.assign(new Error('Server is missing API_KEYS_FOR_MEDH.'), { status: 500 });
  const parts = content.map((c) => (c.type === 'text' ? { text: c.text } : { inline_data: { mime_type: c.source.media_type, data: c.source.data } }));
  const call = (withSearch) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      ...(withSearch ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 1024 } },
    }),
  });
  let res = await call(true);
  if (res.status === 400) res = await call(false);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(res.status === 429 ? 'AI is busy (rate limit). Try again in a minute.' : data?.error?.message || `AI error (${res.status})`), { status: 502 });
  }
  const cand = data.candidates?.[0] || {};
  const text = (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
  const seen = new Set();
  const sources = [];
  for (const ch of cand.groundingMetadata?.groundingChunks || []) {
    const url = ch.web?.uri, title = ch.web?.title || ch.web?.domain || '';
    if (url && !seen.has(url)) { seen.add(url); sources.push({ title: title || url, url }); }
  }
  if (!text) throw Object.assign(new Error('No answer found. Try asking differently.'), { status: 502 });
  return { text, sources: sources.slice(0, 6) };
}

export function parseJSON(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('no JSON object');
  const body = cleaned.slice(start);
  const end = body.lastIndexOf('}');
  const attempts = [
    end === -1 ? body : body.slice(0, end + 1),
    stripComments(end === -1 ? body : body.slice(0, end + 1)),
    closeTruncated(stripComments(body)),
  ];
  for (const a of attempts) { try { return JSON.parse(a); } catch { /* next */ } }
  throw new Error('unparseable JSON');
}

// remove // comments and trailing commas that models sometimes add
function stripComments(s) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

// best-effort repair of a cut-off answer: drop the unfinished tail and close open brackets
function closeTruncated(s) {
  const stack = []; let inStr = false, esc = false, lastSafe = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') { stack.pop(); lastSafe = i + 1; }
    else if (c === ',') lastSafe = i;
  }
  let head = s.slice(0, lastSafe).replace(/,\s*$/, '');
  const st = []; inStr = false; esc = false;
  for (const c of head) {
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{' || c === '[') st.push(c === '{' ? '}' : ']'); else if (c === '}' || c === ']') st.pop();
  }
  return head + st.reverse().join('');
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
