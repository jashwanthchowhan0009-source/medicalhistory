// POST /api/ask  { question, history?: [{ role: 'user'|'ai', text }] }
// Small "look it up" box: factual medical information from the web, with sources. Never personal advice.

import { askAIWeb, readBody, send, requireUser } from './_ai.js';

export const config = { maxDuration: 45 };

const SYSTEM = `You are the "Look it up" box inside the Medical History app. You answer like a careful search engine summary.
- Use Google Search and give factual, general information about medicines, tests, lab values, conditions, procedures and medical words.
- Keep it short: under 120 words, simple language. Reply in the same language/style as the question (English, Hindi, Telugu or Hinglish).
- Information only: do NOT diagnose the user, do NOT recommend or change any medicine or dose, do NOT say what they personally should do. If they ask for that, say a doctor must decide and give the general facts only.
- If the question describes an emergency (chest pain, can't breathe, unconscious, heavy bleeding, poisoning, suicidal thoughts), first say: "Call 108 (ambulance) or go to the nearest hospital now." For suicidal thoughts also give Tele-MANAS 14416.
- Never invent facts. If unsure, say so.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    await requireUser(req);
    const { question, history } = readBody(req);
    const q = String(question || '').trim().slice(0, 600);
    if (q.length < 2) return send(res, 400, { error: 'Type a question.' });
    const past = (Array.isArray(history) ? history : []).slice(-4)
      .map((h) => `${h.role === 'ai' ? 'Answer' : 'Question'}: ${String(h.text || '').slice(0, 600)}`).join('\n');
    const out = await askAIWeb({
      system: SYSTEM,
      content: [{ type: 'text', text: (past ? `Earlier in this chat:\n${past}\n\n` : '') + `Question: ${q}` }],
      maxTokens: 1500,
    });
    return send(res, 200, { answer: out.text, sources: out.sources });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message || 'Could not answer right now' });
  }
}
