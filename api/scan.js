// POST /api/scan
// Body: { files: [{ name, mediaType: "image/jpeg" | "application/pdf", data: <base64> }] }
// Returns: { entries: [ ...structured health records ] }

import { askAI, readBody, send, requireUser } from './_ai.js';

export const config = { maxDuration: 120 };

const SYSTEM = `You read photos and PDFs of personal health documents (lab reports, prescriptions, doctor notes, discharge summaries, scan reports, pharmacy and hospital bills) for an app called Medical History.

The user may upload several documents in ANY order, possibly from different visits. Group pages that belong to the same visit/report together, and create one record per visit/report. Read every word, including handwriting, as carefully as you can. Never invent values: if something is not written, leave it as an empty string or empty list.

Reply with ONLY a JSON object, no prose, in exactly this shape:
{
  "entries": [
    {
      "sourceIndexes": [0, 1],            // which uploaded files (0-based, in upload order) belong to this record
      "date": "YYYY-MM-DD",               // date of the test/visit/bill; "" if not visible
      "title": "Complete Blood Count",    // short name, e.g. "Thyroid Profile", "Prescription", "Pharmacy bill"
      "documentType": "Lab report",       // Lab report | Prescription | Doctor note | Discharge summary | Scan report | Bill | Other
      "madeBy": "",                       // lab / hospital / pharmacy that produced the document
      "reportSays": "",                   // 2-3 short sentences in very simple language a non-doctor understands: what was tested and what the results mean
      "findings": [ { "name": "", "value": "", "unit": "", "range": "", "flag": "" } ],  // flag: "High", "Low" or "" (normal/unknown); include every measured value, keep names short
      "doctor": "",                       // consulting doctor's name with title, e.g. "Dr. R. Kumar (General Physician)"
      "hospital": "",                     // clinic or hospital name
      "diagnosis": "",                    // only if written
      "suggestions": "",                  // doctor's advice in simple words: diet, rest, follow-up, further tests
      "medicines": [ { "name": "", "dose": "", "frequency": "", "duration": "" } ],  // tablets / syrups / injections prescribed or billed; frequency like "1-0-1 after food"
      "billAmount": ""                    // total with currency if this is a bill, e.g. "₹1,250"
    }
  ]
}

The // notes above explain each field; do not include comments in your JSON. If a file is not a health document at all, leave it out. Keep the language neutral and factual; do not give a medical diagnosis of your own.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    await requireUser(req);
    const { files } = readBody(req);
    if (!Array.isArray(files) || !files.length) return send(res, 400, { error: 'No files received' });
    if (files.length > 10) return send(res, 400, { error: 'Up to 10 files per scan' });

    const content = [];
    files.forEach((f, i) => {
      if (!f || typeof f.data !== 'string') return;
      content.push({ type: 'text', text: `File ${i}: ${String(f.name || 'upload').slice(0, 120)}` });
      if (f.mediaType === 'application/pdf') {
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } });
      } else if (/^image\/(jpeg|png|webp|gif)$/.test(f.mediaType)) {
        content.push({ type: 'image', source: { type: 'base64', media_type: f.mediaType, data: f.data } });
      }
    });
    content.push({ type: 'text', text: 'Read all files above and return the JSON.' });

    const out = await askAI({ system: SYSTEM, content, maxTokens: 32768 });
    const entries = (Array.isArray(out.entries) ? out.entries : []).filter((e) => e && typeof e === 'object');
    return send(res, 200, { entries });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message || 'Scan failed', code: err.code });
  }
}
