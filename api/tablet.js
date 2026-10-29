// POST /api/tablet  { images: [{ mediaType, data }] }  (front/back of a strip or box)
// Step 1: read the pack exactly. Step 2: look up what it is used for (Google Search, with sources). Information only.

import { askAI, askAIWeb, readBody, send, requireUser } from './_ai.js';

export const config = { maxDuration: 60 };

const READ = `You read photos of a medicine pack (tablet strip, bottle, box) for the Medical History app.
Copy EXACTLY what is printed. Never guess. Reply with ONLY JSON:
{"brand":"","generic":"","strength":"","form":"","manufacturer":"","batch":"","mfgDate":"","expiry":"","mrp":"","rxOnly":false,"readable":true,"notSure":[]}
generic = salt / composition as printed (e.g. "Metformin Hydrochloride 500 mg"). Set readable=false if you cannot read a medicine name.`;

const INFO = `You give general, factual information about a medicine for the Medical History app, like a well-sourced encyclopedia entry.
Use Google Search. Indian brand names are common.
Write in short plain English, under 170 words, with these headings exactly:
**What it is** — salt/composition and drug class, in one line.
**Commonly used for** — bullet points.
**Common side effects** — bullet points.
**Important cautions** — bullet points (e.g. who should avoid it, interactions, alcohol).
Rules: information only. Do NOT tell the reader how much to take, whether to start or stop, or that it suits them. End with: "Take it only as your doctor prescribed."`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    await requireUser(req);
    const { images } = readBody(req);
    const imgs = (Array.isArray(images) ? images : []).filter((i) => i && typeof i.data === 'string' && /^image\//.test(i.mediaType || '')).slice(0, 3);
    if (!imgs.length) return send(res, 400, { error: 'Send a photo of the tablet strip or box.' });
    if (imgs.reduce((n, i) => n + i.data.length, 0) > 4.2e6) return send(res, 413, { error: 'Photos too large.' });

    const pack = await askAI({
      system: READ,
      content: [...imgs.map((i) => ({ type: 'image', source: { media_type: i.mediaType, data: i.data } })), { type: 'text', text: 'Read this medicine pack.' }],
      maxTokens: 4096,
    });
    if (pack.readable === false || !(pack.brand || pack.generic)) {
      return send(res, 200, { pack, info: null, error: 'Could not read the medicine name. Take a clear photo of the side that shows the name.' });
    }
    const name = [pack.brand, pack.generic && `(${pack.generic})`, pack.strength].filter(Boolean).join(' ');
    const info = await askAIWeb({ system: INFO, content: [{ type: 'text', text: `Medicine: ${name}. Manufacturer: ${pack.manufacturer || 'unknown'}.` }], maxTokens: 2048 });
    return send(res, 200, { pack, info });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message || 'Could not read the medicine' });
  }
}
