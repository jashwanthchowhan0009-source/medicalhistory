// POST /api/tldr
// Body: { record: { ...one scanned record, without files } }
// Returns: { tldr } — a short plain-language explanation, made only when the user asks for it.

import { askAI, readBody, send, requireUser } from './_ai.js';

export const config = { maxDuration: 30 };

const SYSTEM = `You explain one medical record to a patient or their family in the Medical History app.

Write a TL;DR in very simple English that anyone can understand:
- 2 to 3 short sentences, under 60 words in total.
- Say what the report or visit was for, what stands out (mention values that are high or low by name), and what the doctor asked them to do or take, if written.
- Use ONLY the information given. Do not invent anything, do not diagnose, do not add advice of your own.

Reply with ONLY a JSON object: {"tldr": "..."}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    await requireUser(req);
    const { record } = readBody(req);
    if (!record || typeof record !== 'object') return send(res, 400, { error: 'No record received' });
    const payload = JSON.stringify(record).slice(0, 40000);
    const out = await askAI({ system: SYSTEM, content: [{ type: 'text', text: `Record:\n${payload}` }], maxTokens: 2048 });
    const tldr = String(out.tldr || '').trim();
    if (!tldr) return send(res, 502, { error: 'Could not summarise this record.' });
    return send(res, 200, { tldr });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message || 'Summary failed' });
  }
}
