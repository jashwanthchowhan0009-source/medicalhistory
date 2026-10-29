// POST /api/scan
// Body: { files: [{ name, mediaType: "image/jpeg" | "application/pdf", data: <base64> }] }
// Returns: { entries: [ ...structured health records ] }

import { askAI, readBody, send, requireUser } from './_ai.js';

export const config = { maxDuration: 120 };

const SYSTEM = `You read photos and PDFs of personal health documents (lab reports, prescriptions, doctor notes, discharge summaries, scan reports, pharmacy and hospital bills) for an app called Medical History.

The user may upload several documents in ANY order, possibly from different visits. Group pages that belong to the same visit/report together, and create one record per visit/report. Read every word, including handwriting, as carefully as you can. Never invent values: if something is not written, leave it as an empty string or empty list.

ACCURACY RULES — people will rely on this for their health, mistakes can hurt them:
- Dates: these are Indian documents, written DAY/MONTH/YEAR (e.g. 07/04/26 = 7 April 2026). Never swap day and month. Never guess a missing or unreadable year — leave "date" as "" instead. Today is {{TODAY}}; a report cannot be from the future, so if what you read is after today, you misread it: leave "" and add "date" to needsReview.
- Medicines: copy the drug name, strength (mg/ml), dose and frequency EXACTLY as written. Never "correct" or guess a dose, strength or frequency. If any part of a medicine is hard to read (handwriting), still write your best reading but set "unclear": true on that medicine.
- Numbers in lab results: copy exactly with the same decimals and units; do not round or convert.
- If you are not sure about any field, add its name to "needsReview" (e.g. "date", "medicines", "doctor", "findings").
- "doctor" = only the ONE consulting / prescribing doctor, short: "Dr. Name (Speciality)". Do not list degrees. On lab reports, do NOT put pathologists or lab signatories here (leave "" unless a referring doctor is named).
- "diagnosis" = only conditions the doctor actually diagnosed. Things like "no chest pain" or "no fever" are not diagnoses — leave them out.

Reply with ONLY a JSON object, no prose, in exactly this shape:
{
  "entries": [
    {
      "sourceIndexes": [0, 1],            // which uploaded files (0-based, in upload order) belong to this record
      "date": "YYYY-MM-DD",               // date of the test/visit/bill; "" if not visible
      "time": "",                         // "HH:MM" 24-hour if a time is printed (sample collection / visit time), else ""
      "title": "Complete Blood Count",    // short name, e.g. "Thyroid Profile", "Prescription", "Pharmacy bill"
      "documentType": "Lab report",       // Lab report | Prescription | Doctor note | Discharge summary | Scan report | Bill | Other
      "madeBy": "",                       // lab / hospital / pharmacy that produced the document
      "reportSays": "",                   // 2-3 short sentences in very simple language a non-doctor understands: what was tested and what the results mean
      "findings": [ { "section": "", "name": "", "value": "", "unit": "", "range": "", "flag": "" } ],  // every measured value; section = the heading it sits under on the report (e.g. "Haemoglobin", "Blood indices", "Differential WBC count", "Lipid profile"); flag: "High", "Low" or "" (normal/unknown); keep names short
      "vitals": { "bpSystolic": "", "bpDiastolic": "", "pulse": "", "temperature": "", "weight": "", "height": "", "spo2": "", "sugar": "" },  // only if written (BP in mmHg, pulse bpm, temperature as written e.g. "99 °F", weight "kg", height "cm" or as written, SpO2 %, sugar mg/dL)
      "symptoms": [],                     // complaints / symptoms written by the doctor, short words, e.g. ["Fever", "Cough"]
      "doctor": "",                       // consulting doctor's name with title, e.g. "Dr. R. Kumar (General Physician)"
      "hospital": "",                     // clinic or hospital name
      "diagnosis": "",                    // only if written; separate multiple with ", "
      "suggestions": "",                  // doctor's advice in simple words: diet, rest, follow-up, further tests
      "medicines": [ { "name": "", "dose": "", "frequency": "", "duration": "", "unclear": false } ],  // tablets / syrups / injections prescribed or billed, exactly as written; frequency like "1-0-1 after food"; unclear = true if any part was hard to read
      "billAmount": "",                   // total with currency if this is a bill, e.g. "₹1,250"
      "needsReview": []                   // names of fields you are not fully sure about
    }
  ]
}

The // notes above explain each field; do not include comments in your JSON. If a file is not a health document at all, leave it out. Keep the language neutral and factual; do not give a medical diagnosis of your own.`;

// Server-side safety checks: never trust an impossible date, always flag shaky readings.
function checkEntry(e, today) {
  const review = new Set(Array.isArray(e.needsReview) ? e.needsReview.map(String) : []);
  const d = String(e.date || '');
  if (d) {
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + 'T00:00:00'));
    const tooNew = d > addDays(today, 1);
    const tooOld = d < '1950-01-01';
    if (!ok || tooNew || tooOld) { e.dateRead = d; e.date = ''; review.add('date'); }
  }
  if (Array.isArray(e.medicines)) {
    e.medicines = e.medicines.filter((m) => m && m.name);
    if (e.medicines.some((m) => m.unclear)) review.add('medicines');
  }
  e.needsReview = [...review];
  return e;
}
function addDays(iso, n) {
  const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

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

    const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // India date
    const out = await askAI({ system: SYSTEM.replace('{{TODAY}}', today), content, maxTokens: 32768 });
    const entries = (Array.isArray(out.entries) ? out.entries : []).filter((e) => e && typeof e === 'object').map((e) => checkEntry(e, today));
    return send(res, 200, { entries });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message || 'Scan failed', code: err.code });
  }
}
