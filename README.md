# Medical History

One place for your whole family’s medical reports, prescriptions and bills.
Log in with one email, add up to **6 patients** (you, parents, spouse, kids), upload documents **in any order** — AI reads them and builds each person’s timeline.

Green, white & black, classic and minimal, light + dark mode, works on mobile and desktop.

## Pages

| Page | What it does |
|---|---|
| **Login** | Email + password: log in, create account, forgot / reset password. |
| **Add patient** | Required after sign-up. Name, relation, DOB, sex, **Aadhaar (mandatory, checksum-validated — only last 4 digits stored)**, blood group, mobile, emergency contact, health card (ABHA, PM-JAY, Aarogyasri, CGHS, ESIC, insurance), height/weight, allergies, conditions. |
| **Home** | Upload for the selected patient — *Take photo* or *Gallery / Files* (images & PDFs, drag-and-drop on desktop). |
| **History** | Patient’s timeline: **Health Report \| Made by**, what it says in simple words (tests table, High/Low flagged), **Consulted doctor \| Hospital**, advice and tablets, **TL;DR**, **Sources** (original photos). Search. |
| **Profile** | Account email, all patients (switch / edit / add), patient details, AI **complete health report** (print / PDF), export backup, log out. |

Patient switcher in the top bar changes whose records you’re viewing.

### Family, doctors & tablets
- **Patient ID** (`MH-XXXX-XXXX`) on top of History. **Share with doctor** makes a one-time 6-digit code (10 min). A *verified* doctor enters ID + code → 24 h read-only access. Patient sees every access and can stop it.
- **Emergency card**: QR on a lock-screen wallpaper / wallet card → `/e/<secret>` shows only what the patient ticks (blood group, allergies, conditions, daily tablets, family contact). Every scan is logged. No face data is stored.
- **Doctor tools** (`#doctor`): register with council registration no. + certificate → admin approves → Emergency (scan QR) and General checkup (ID + code).
- **Daily Tablets** per patient: M / A / E / N, BF / AF, reminders (app notifications + phone-calendar `.ics`). Add from a prescription (“+ Daily”) or by scanning a tablet.
- **Tablet pictures**: tap the pill icon on any medicine to add a strip photo or see Google images.
- **Health & insurance cards**: upload a photo, AI fills the details. **Aadhaar is read on the phone only** (never uploaded); only the last 4 digits are stored.
- **Scan a tablet** + **Look it up** box on Home: web-sourced information with links, never personal advice.

## Stack

```
Browser (index.html + app.js + config.js)         Vercel serverless (api/)
  ├─ Supabase Auth (email + password)              /api/scan    → Gemini reads images/PDFs → structured records
  ├─ Postgres: hh_patients, hh_records (RLS)       /api/summary → Gemini → complete health report
  └─ Storage: hh-reports (private, per-user)       both require a logged-in user
```

Schema: `supabase/schema.sql`, then `supabase/002_family_doctor_emergency.sql` (run both in the SQL Editor). Admin emails live in `hh_admins`. Each user can only read/write their own patients, records and files.

## Deploy

1. Vercel → import this repo (preset **Other**, no build command).
2. Vercel → Settings → Environment Variables → `API_KEYS_FOR_MEDH` (Gemini API key) → redeploy.
3. Supabase → Authentication → URL Configuration → **Site URL** = your Vercel URL (and add it under Redirect URLs) so confirmation / reset emails open the app.

## Brand

`assets/logo-primary.png` (green tile) — header, login, app icon. `assets/logo-mark-green.png` — small marks (footer, empty states).

> Medical History organises records. It is not medical advice.
