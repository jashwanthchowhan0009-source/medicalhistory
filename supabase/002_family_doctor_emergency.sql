-- Medical History — migration 002
-- Patient ID + share codes (general checkup), Emergency card, verified doctors, Daily tablets, access log.
-- Safe to run more than once. Paste the whole file into Supabase → SQL Editor → Run.

-- ───────────────────────── helpers ─────────────────────────
-- readable random code, no look-alike characters (0/O, 1/I/L)
create or replace function public.hh_rand_code(n int)
returns text language sql volatile set search_path = '' as $$
  select string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 1 + floor(random() * 31)::int, 1), '')
  from generate_series(1, n);
$$;

-- ─────────────────── patients: public ID + emergency ───────────────────
alter table public.hh_patients add column if not exists public_code text;
alter table public.hh_patients add column if not exists emergency_token text;
alter table public.hh_patients add column if not exists emergency_enabled boolean not null default false;
alter table public.hh_patients add column if not exists emergency_fields jsonb not null
  default '{"blood":true,"allergies":true,"conditions":true,"tablets":true,"contact":true,"age":true}'::jsonb;

update public.hh_patients set public_code = 'MH-' || public.hh_rand_code(4) || '-' || public.hh_rand_code(4) where public_code is null;
update public.hh_patients set emergency_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') where emergency_token is null;
alter table public.hh_patients alter column public_code set default ('MH-' || public.hh_rand_code(4) || '-' || public.hh_rand_code(4));
alter table public.hh_patients alter column emergency_token set default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));
alter table public.hh_patients alter column public_code set not null;
alter table public.hh_patients alter column emergency_token set not null;
create unique index if not exists hh_patients_public_code_key on public.hh_patients (public_code);
create unique index if not exists hh_patients_emergency_token_key on public.hh_patients (emergency_token);

-- ───────────────────── daily tablets ─────────────────────
create table if not exists public.hh_meds (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  patient_id  uuid not null references public.hh_patients (id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,   -- name, dose, slots [M,A,E,N], food BF/AF, start, end, photo, note
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists hh_meds_patient_idx on public.hh_meds (patient_id);
drop trigger if exists hh_meds_touch on public.hh_meds;
create trigger hh_meds_touch before update on public.hh_meds for each row execute function public.hh_touch_updated_at();
alter table public.hh_meds enable row level security;
drop policy if exists "own meds" on public.hh_meds;
create policy "own meds" on public.hh_meds for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id
    and exists (select 1 from public.hh_patients p where p.id = patient_id and p.user_id = (select auth.uid())));

-- ───────────────────── admins & doctors ─────────────────────
create table if not exists public.hh_admins (email text primary key);
alter table public.hh_admins enable row level security;          -- no policies: only definer functions read it
insert into public.hh_admins (email) values ('jashwanthchowhan0009@gmail.com'), ('jashwanthchowhan0004@gmail.com') on conflict do nothing;

create or replace function public.hh_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.hh_admins a where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

create table if not exists public.hh_doctors (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  full_name   text not null,
  reg_no      text not null,                      -- NMC / State Medical Council registration number
  council     text not null default '',
  speciality  text not null default '',
  hospital    text not null default '',
  phone       text not null default '',
  id_path     text,                               -- ID proof in private bucket hh-doctor-ids
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  note        text not null default '',
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz
);
alter table public.hh_doctors enable row level security;
drop policy if exists "doctor reads own" on public.hh_doctors;
create policy "doctor reads own" on public.hh_doctors for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "doctor applies" on public.hh_doctors;
create policy "doctor applies" on public.hh_doctors for insert to authenticated
  with check ((select auth.uid()) = user_id and status = 'pending');
drop policy if exists "doctor edits pending" on public.hh_doctors;
create policy "doctor edits pending" on public.hh_doctors for update to authenticated
  using ((select auth.uid()) = user_id and status <> 'approved')
  with check ((select auth.uid()) = user_id and status = 'pending');

create or replace function public.hh_is_doctor()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.hh_doctors d where d.user_id = auth.uid() and d.status = 'approved');
$$;

create or replace function public.admin_list_doctors()
returns setof public.hh_doctors language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.hh_is_admin() then raise exception 'not allowed'; end if;
  return query select * from public.hh_doctors order by (status = 'pending') desc, created_at desc;
end; $$;

create or replace function public.admin_set_doctor(p_user uuid, p_status text, p_note text default '')
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.hh_is_admin() then raise exception 'not allowed'; end if;
  if p_status not in ('approved', 'rejected', 'pending') then raise exception 'bad status'; end if;
  update public.hh_doctors set status = p_status, note = coalesce(p_note, ''), reviewed_at = now() where user_id = p_user;
end; $$;

-- ───────────────────── share codes, grants, access log ─────────────────────
create table if not exists public.hh_share_codes (
  patient_id  uuid primary key references public.hh_patients (id) on delete cascade,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    int not null default 0
);
alter table public.hh_share_codes enable row level security;    -- definer functions only

create table if not exists public.hh_grants (
  id          uuid primary key default gen_random_uuid(),
  doctor_id   uuid not null references auth.users (id) on delete cascade,
  patient_id  uuid not null references public.hh_patients (id) on delete cascade,
  purpose     text not null default 'checkup',
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists hh_grants_lookup on public.hh_grants (doctor_id, patient_id, expires_at);
alter table public.hh_grants enable row level security;
drop policy if exists "doctor sees own grants" on public.hh_grants;
create policy "doctor sees own grants" on public.hh_grants for select to authenticated using ((select auth.uid()) = doctor_id);
drop policy if exists "owner sees grants" on public.hh_grants;
create policy "owner sees grants" on public.hh_grants for select to authenticated
  using (exists (select 1 from public.hh_patients p where p.id = patient_id and p.user_id = (select auth.uid())));
drop policy if exists "owner revokes grants" on public.hh_grants;
create policy "owner revokes grants" on public.hh_grants for delete to authenticated
  using (exists (select 1 from public.hh_patients p where p.id = patient_id and p.user_id = (select auth.uid())));

create table if not exists public.hh_access_log (
  id          bigint generated always as identity primary key,
  patient_id  uuid not null references public.hh_patients (id) on delete cascade,
  kind        text not null,                 -- emergency | checkup | share_code
  actor_id    uuid,                          -- doctor (null for emergency card views)
  actor_name  text not null default '',
  at          timestamptz not null default now()
);
create index if not exists hh_access_log_patient on public.hh_access_log (patient_id, at desc);
alter table public.hh_access_log enable row level security;
drop policy if exists "owner reads log" on public.hh_access_log;
create policy "owner reads log" on public.hh_access_log for select to authenticated
  using (exists (select 1 from public.hh_patients p where p.id = patient_id and p.user_id = (select auth.uid())));

-- patient (owner) creates a one-time 6-digit code, valid 10 minutes
create or replace function public.create_share_code(p_patient uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_code text;
begin
  if not exists (select 1 from public.hh_patients p where p.id = p_patient and p.user_id = auth.uid()) then
    raise exception 'not allowed';
  end if;
  v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
  insert into public.hh_share_codes (patient_id, code_hash, expires_at, attempts)
  values (p_patient, encode(sha256(convert_to(p_patient::text || ':' || v_code, 'UTF8')), 'hex'), now() + interval '10 minutes', 0)
  on conflict (patient_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0;
  return v_code;
end; $$;

-- verified doctor redeems Patient ID + code → 24 h read access. Returns patient id, or null with no detail.
create or replace function public.doctor_open_checkup(p_public_code text, p_code text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_pid uuid; v_row public.hh_share_codes; v_name text;
begin
  if not public.hh_is_doctor() then raise exception 'Only verified doctors can do this'; end if;
  select id into v_pid from public.hh_patients where public_code = upper(trim(p_public_code));
  if v_pid is null then return null; end if;
  select * into v_row from public.hh_share_codes where patient_id = v_pid;
  if v_row.patient_id is null or v_row.expires_at < now() or v_row.attempts >= 5 then return null; end if;
  if v_row.code_hash <> encode(sha256(convert_to(v_pid::text || ':' || trim(p_code), 'UTF8')), 'hex') then
    update public.hh_share_codes set attempts = attempts + 1 where patient_id = v_pid;   -- 5 wrong tries → code dead
    return null;
  end if;
  delete from public.hh_share_codes where patient_id = v_pid;                         -- one-time
  insert into public.hh_grants (doctor_id, patient_id, purpose, expires_at) values (auth.uid(), v_pid, 'checkup', now() + interval '24 hours');
  select full_name into v_name from public.hh_doctors where user_id = auth.uid();
  insert into public.hh_access_log (patient_id, kind, actor_id, actor_name) values (v_pid, 'checkup', auth.uid(), coalesce(v_name, ''));
  return v_pid;
end; $$;

-- doctor with an active grant reads the patient's medical data (no Aadhaar, no account details)
create or replace function public.doctor_patient_bundle(p_patient uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  if not public.hh_is_doctor() then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.hh_grants g where g.doctor_id = auth.uid() and g.patient_id = p_patient and g.expires_at > now()) then
    raise exception 'Access expired — ask the patient for a new code';
  end if;
  select jsonb_build_object(
    'patient', jsonb_build_object('id', p.id, 'public_code', p.public_code,
       'data', (p.data - 'phone' - 'cards') ),
    'records', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'data', r.data, 'created_at', r.created_at) order by r.record_date desc nulls last, r.created_at desc)
                         from public.hh_records r where r.patient_id = p.id), '[]'::jsonb),
    'meds', coalesce((select jsonb_agg(m.data) from public.hh_meds m where m.patient_id = p.id and m.active), '[]'::jsonb),
    'expires_at', (select max(expires_at) from public.hh_grants g where g.doctor_id = auth.uid() and g.patient_id = p.id)
  ) into v from public.hh_patients p where p.id = p_patient;
  return v;
end; $$;

-- Emergency card: anyone holding the secret QR link sees ONLY the fields the patient switched on.
create or replace function public.get_emergency(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p public.hh_patients; f jsonb; d jsonb; v jsonb; v_age int;
begin
  if p_token is null or length(p_token) < 32 then return null; end if;
  select * into p from public.hh_patients where emergency_token = p_token and emergency_enabled;
  if p.id is null then return null; end if;
  f := p.emergency_fields; d := p.data;
  if (d ->> 'dob') ~ '^\d{4}-\d{2}-\d{2}$' then v_age := date_part('year', age(current_date, (d ->> 'dob')::date)); end if;
  v := jsonb_build_object('name', d ->> 'name', 'sex', d ->> 'sex', 'public_code', p.public_code);
  if coalesce((f ->> 'age')::boolean, true) and v_age is not null then v := v || jsonb_build_object('age', v_age); end if;
  if coalesce((f ->> 'blood')::boolean, true) then v := v || jsonb_build_object('blood', d ->> 'blood'); end if;
  if coalesce((f ->> 'allergies')::boolean, true) then v := v || jsonb_build_object('allergies', d ->> 'allergies'); end if;
  if coalesce((f ->> 'conditions')::boolean, true) then v := v || jsonb_build_object('conditions', d ->> 'conditions'); end if;
  if coalesce((f ->> 'contact')::boolean, true) then v := v || jsonb_build_object('emergency', d ->> 'emergency'); end if;
  if coalesce((f ->> 'tablets')::boolean, true) then
    v := v || jsonb_build_object('tablets', coalesce((select jsonb_agg(jsonb_build_object('name', m.data ->> 'name', 'dose', m.data ->> 'dose', 'slots', m.data -> 'slots'))
                                                    from public.hh_meds m where m.patient_id = p.id and m.active), '[]'::jsonb));
  end if;
  insert into public.hh_access_log (patient_id, kind, actor_id, actor_name)
  values (p.id, 'emergency',
          case when public.hh_is_doctor() then auth.uid() end,
          coalesce((select dr.full_name from public.hh_doctors dr where dr.user_id = auth.uid() and dr.status = 'approved'), ''));
  return v;
end; $$;

-- owner: make a brand-new emergency link (old QR stops working)
create or replace function public.rotate_emergency_token(p_patient uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare t text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  update public.hh_patients set emergency_token = t where id = p_patient and user_id = auth.uid();
  if not found then raise exception 'not allowed'; end if;
  return t;
end; $$;

-- who may call what
revoke all on function public.create_share_code(uuid) from public, anon;
revoke all on function public.doctor_open_checkup(text, text) from public, anon;
revoke all on function public.doctor_patient_bundle(uuid) from public, anon;
revoke all on function public.admin_list_doctors() from public, anon;
revoke all on function public.admin_set_doctor(uuid, text, text) from public, anon;
revoke all on function public.rotate_emergency_token(uuid) from public, anon;
grant execute on function public.create_share_code(uuid) to authenticated;
grant execute on function public.doctor_open_checkup(text, text) to authenticated;
grant execute on function public.doctor_patient_bundle(uuid) to authenticated;
grant execute on function public.admin_list_doctors() to authenticated;
grant execute on function public.admin_set_doctor(uuid, text, text) to authenticated;
grant execute on function public.rotate_emergency_token(uuid) to authenticated;
grant execute on function public.get_emergency(text) to anon, authenticated;
grant execute on function public.hh_is_admin() to authenticated;
grant execute on function public.hh_is_doctor() to authenticated;

-- ───────────────────── storage ─────────────────────
-- doctors with an active grant may view that patient's report files (path: <owner>/<patient>/...)
drop policy if exists "hh doctor reads granted files" on storage.objects;
create policy "hh doctor reads granted files" on storage.objects for select to authenticated
  using (bucket_id = 'hh-reports' and exists (
    select 1 from public.hh_grants g
    where g.doctor_id = (select auth.uid()) and g.expires_at > now()
      and g.patient_id::text = (storage.foldername(name))[2]));

-- doctor ID proofs: private bucket, owner uploads own, admin can view
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hh-doctor-ids', 'hh-doctor-ids', false, 8388608, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;
drop policy if exists "hh doctor id upload" on storage.objects;
create policy "hh doctor id upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'hh-doctor-ids' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "hh doctor id update" on storage.objects;
create policy "hh doctor id update" on storage.objects for update to authenticated
  using (bucket_id = 'hh-doctor-ids' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "hh doctor id read" on storage.objects;
create policy "hh doctor id read" on storage.objects for select to authenticated
  using (bucket_id = 'hh-doctor-ids' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.hh_is_admin()));
