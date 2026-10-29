// POST /api/card  { image: { mediaType, data } }
// Reads a health / insurance / scheme card photo and returns its details so the user doesn't type.
// Aadhaar is never processed here (it is read on the phone); if one slips through, only the last 4 digits come back.

import { askAI, readBody, send, requireUser } from './_ai.js';

export const config = { maxDuration: 60 };

const SYSTEM = `You read ONE photo of an Indian health-related card for the Medical History app: health insurance card, ABHA (Ayushman Bharat Health Account) card, PM-JAY / Ayushman card, Aarogyasri, CGHS, ESIC, employer TPA card, or similar.
Copy text EXACTLY as printed. Never guess digits; leave a field "" if it is not clearly readable.
If the card is an Aadhaar card, set "cardType" to "Aadhaar" and put ONLY the last 4 digits in "number".
Reply with ONLY JSON:
{"cardType":"","holderName":"","number":"","abha":"","abhaAddress":"","insurer":"","scheme":"","policyNo":"","validFrom":"","validTill":"","dob":"","sex":"","relation":"","tpa":"","helpline":"","notSure":[]}
Dates as YYYY-MM-DD (Indian day-first). "notSure" lists fields you could not read with confidence.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    await requireUser(req);
    const { image } = readBody(req);
    if (!image || typeof image.data !== 'string' || !/^image\/(jpeg|png|webp)$/.test(image.mediaType || '')) {
      return send(res, 400, { error: 'Send one card photo (JPG/PNG).' });
    }
    if (image.data.length > 4.2e6) return send(res, 413, { error: 'Photo too large.' });
    const out = await askAI({
      system: SYSTEM,
      content: [{ type: 'image', source: { media_type: image.mediaType, data: image.data } }, { type: 'text', text: 'Read this card.' }],
      maxTokens: 4096,
    });
    const card = {};
    for (const k of ['cardType', 'holderName', 'number', 'abha', 'abhaAddress', 'insurer', 'scheme', 'policyNo', 'validFrom', 'validTill', 'dob', 'sex', 'relation', 'tpa', 'helpline']) {
      card[k] = String(out[k] ?? '').trim().slice(0, 200);
    }
    // hard privacy rule: never return a full Aadhaar number
    const digits = (s) => String(s).replace(/\D/g, '');
    if (/aadhaar|aadhar|uidai/i.test(card.cardType) || digits(card.number).length === 12) {
      card.cardType = /aadhaar|aadhar|uidai/i.test(card.cardType) ? 'Aadhaar' : card.cardType;
      card.number = digits(card.number).slice(-4);
      card.aadhaarLast4 = card.number;
    }
    if (digits(card.abha).length && digits(card.abha).length !== 14) (out.notSure ||= []).push('abha');
    card.notSure = Array.isArray(out.notSure) ? out.notSure.map(String).slice(0, 10) : [];
    return send(res, 200, { card });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message || 'Could not read the card' });
  }
}
