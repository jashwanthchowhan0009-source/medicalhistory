-- Medical History · 003 · make jashwanthchowhan0004@gmail.com an admin AND an approved test doctor.
-- Run AFTER 002, and after that email has signed up once in the app (so it exists in auth.users).
-- Safe to run more than once.

insert into public.hh_admins (email) values ('jashwanthchowhan0004@gmail.com') on conflict do nothing;

insert into public.hh_doctors (user_id, full_name, reg_no, council, speciality, hospital, status, note, reviewed_at)
select u.id, 'Dr. Test (Jashwanth)', 'TEST-0004', 'Testing only — not a real registration', 'General', 'Medical History QA', 'approved', 'Test account', now()
from auth.users u
where lower(u.email) = 'jashwanthchowhan0004@gmail.com'
on conflict (user_id) do update set status = 'approved', note = 'Test account', reviewed_at = now();

-- check: should return one row with status = approved and is_admin = true
select u.email, d.status, exists (select 1 from public.hh_admins a where lower(a.email) = lower(u.email)) as is_admin
from auth.users u left join public.hh_doctors d on d.user_id = u.id
where lower(u.email) = 'jashwanthchowhan0004@gmail.com';
