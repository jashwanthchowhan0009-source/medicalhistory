-- Medical History · 004 · Aadhaar becomes optional (a private app must not make Aadhaar mandatory).
-- Safe to run more than once. The last-4 format check still applies when a value is given.
alter table public.hh_patients alter column aadhaar_last4 drop not null;
