-- Health History — database + storage setup (Supabase).
-- One login (email) → up to 6 patient profiles → each patient has their own records.
-- Every row and file is locked to its owner with Row Level Security.

-- Patients under one account
create table if not exists public.hh_patients (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data          jsonb not null default '{}'::jsonb,   -- name, relation, dob, sex, blood, health card, allergies …
  aadhaar_last4 text not null check (aadhaar_last4 ~ '^[0-9]{4}$'),  -- only last 4 digits are stored
  full_report   jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists hh_patients_user_idx on public.hh_patients (user_id, created_at);

-- Records: one row per report / visit / bill, belonging to a patient
create table if not exists public.hh_records (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  patient_id  uuid not null references public.hh_patients (id) on delete cascade,
  record_date date,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists hh_records_patient_date_idx on public.hh_records (patient_id, record_date desc);
create index if not exists hh_records_user_idx on public.hh_records (user_id);

create or replace function public.hh_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end; $$;

drop trigger if exists hh_patients_touch on public.hh_patients;
create trigger hh_patients_touch before update on public.hh_patients
  for each row execute function public.hh_touch_updated_at();
drop trigger if exists hh_records_touch on public.hh_records;
create trigger hh_records_touch before update on public.hh_records
  for each row execute function public.hh_touch_updated_at();

-- Max 6 patients per account
create or replace function public.hh_patient_limit()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.hh_patients where user_id = new.user_id) >= 6 then
    raise exception 'An account can hold up to 6 patients';
  end if;
  return new;
end; $$;
drop trigger if exists hh_patients_limit on public.hh_patients;
create trigger hh_patients_limit before insert on public.hh_patients
  for each row execute function public.hh_patient_limit();

alter table public.hh_patients enable row level security;
alter table public.hh_records  enable row level security;

drop policy if exists "own patients" on public.hh_patients;
create policy "own patients" on public.hh_patients
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- a record must belong to the user AND to one of the user's patients
drop policy if exists "own records" on public.hh_records;
create policy "own records" on public.hh_records
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.hh_patients p where p.id = patient_id and p.user_id = (select auth.uid()))
  );

-- Private bucket for report photos/PDFs. Path: <user_id>/<patient_id>/<record_id>/<file>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hh-reports', 'hh-reports', false, 10485760, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

drop policy if exists "hh read own files" on storage.objects;
create policy "hh read own files" on storage.objects for select to authenticated
  using (bucket_id = 'hh-reports' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "hh upload own files" on storage.objects;
create policy "hh upload own files" on storage.objects for insert to authenticated
  with check (bucket_id = 'hh-reports' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "hh update own files" on storage.objects;
create policy "hh update own files" on storage.objects for update to authenticated
  using (bucket_id = 'hh-reports' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "hh delete own files" on storage.objects;
create policy "hh delete own files" on storage.objects for delete to authenticated
  using (bucket_id = 'hh-reports' and (storage.foldername(name))[1] = (select auth.uid())::text);
