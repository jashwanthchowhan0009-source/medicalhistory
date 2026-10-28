// POST /api/summary
// Body: { profile: {...}, records: [ ...scanned records without files ] }
// Returns the patient's complete health report built from all records.

import { askClaude, readBody, send } from './_claude.js';

export const config = { maxDuration: 60 };

const SYSTEM = `You write a "complete health report" for the Health History app, combining all of a person's stored records into one summary they can show a new doctor.

Use ONLY the information given. Do not invent anything and do not add your own diagnosis. Use simple, clear language. Mention dates (e.g. "Jan 2020") where they help.

Reply with ONLY a JSON object, no prose, no comments:
{
  "overview": "3-5 sentence plain-language summary of this person's health history",
  "conditions": ["condition or diagnosis — when first seen"],
  "medicines": ["medicine, dose, frequency — prescribed by / when (most recent first)"],
  "allergies": ["allergy"],
  "keyResults": ["test name: value trend over time with dates, note if high/low"],
  "careTeam": ["Doctor name — speciality/hospital — last seen date"],
  "watchouts": ["values that were out of range or advice that needs follow-up"]
}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    const { profile = {}, records } = readBody(req);
    if (!Array.isArray(records) || !records.length) return send(res, 400, { error: 'No records to summarise' });
    const payload = JSON.stringify({ profile, records }).slice(0, 180000);
    const out = await askClaude({
      system: SYSTEM,
      content: [{ type: 'text', text: `Here is the person's data as JSON:\n${payload}` }],
      maxTokens: 4000,
    });
    return send(res, 200, out);
  } catch (err) {
    return send(res, err.status || 500, { error: err.message || 'Summary failed' });
  }
}
