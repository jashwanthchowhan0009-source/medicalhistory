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

## Stack

```
Browser (index.html + app.js + config.js)         Vercel serverless (api/)
  ├─ Supabase Auth (email + password)              /api/scan    → Claude reads images/PDFs → structured records
  ├─ Postgres: hh_patients, hh_records (RLS)       /api/summary → Claude → complete health report
  └─ Storage: hh-reports (private, per-user)       both require a logged-in user
```

Schema: `supabase/schema.sql`. Each user can only read/write their own patients, records and files.

## Deploy

1. Vercel → import this repo (preset **Other**, no build command).
2. Vercel → Settings → Environment Variables → `ANTHROPIC_API_KEY` → redeploy.
3. Supabase → Authentication → URL Configuration → **Site URL** = your Vercel URL (and add it under Redirect URLs) so confirmation / reset emails open the app.

## Brand

`assets/logo-primary.png` (green tile) — header, login, app icon. `assets/logo-mark-green.png` — small marks (footer, empty states).

> Medical History organises records. It is not medical advice.
