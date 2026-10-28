-- Health History — database + storage setup (Supabase).
-- Every row and file is locked to its owner with Row Level Security.

-- Records: one row per report / visit / bill
create table if not exists public.hh_records (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  record_date date,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists hh_records_user_date_idx on public.hh_records (user_id, record_date desc);

-- Profile: personal details + latest AI "complete health report"
create table if not exists public.hh_profiles (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  full_report jsonb,
  updated_at  timestamptz not null default now()
);

create or replace function public.hh_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end; $$;

drop trigger if exists hh_records_touch on public.hh_records;
create trigger hh_records_touch before update on public.hh_records
  for each row execute function public.hh_touch_updated_at();
drop trigger if exists hh_profiles_touch on public.hh_profiles;
create trigger hh_profiles_touch before update on public.hh_profiles
  for each row execute function public.hh_touch_updated_at();

alter table public.hh_records  enable row level security;
alter table public.hh_profiles enable row level security;

drop policy if exists "own records" on public.hh_records;
create policy "own records" on public.hh_records
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "own profile" on public.hh_profiles;
create policy "own profile" on public.hh_profiles
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Private bucket for report photos/PDFs. Path: <user_id>/<record_id>/<file>
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
