-- ============================================================================
-- Borderway International — Supabase database schema
-- ============================================================================
-- What this is:
--   Postgres tables + Row Level Security (RLS) for the Borderway dynamic
--   website (USA and Canada immigration services).
--
-- How to run it:
--   Supabase Dashboard -> SQL Editor -> New query -> paste this whole file
--   -> Run. Run it ONCE on a fresh project. It is safe to run again: tables,
--   policies, triggers and indexes are all created with IF NOT EXISTS /
--   DROP IF EXISTS guards, so a second run changes nothing.
--
-- Do NOT run this in plain Postgres. It uses Supabase-only roles
-- (anon, authenticated) and the auth.users table from Supabase Auth.
--
-- Order matters: tables first, then the helper functions that read them,
-- then triggers, indexes and policies.
--
-- Tables:
--   profiles      one row per signed-up user (linked to Supabase Auth)
--   admin_users   which users are admins (the admin panel checks this)
--   leads         appointment / contact / free-assessment submissions
--   assessments   eligibility-analysis submissions and their results
--   admin_notes   internal notes the admin writes on a lead
--   documents     metadata for files uploaded to the storage bucket
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  full_name  text,
  phone      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.profiles is 'One row per signed-up website user.';

create table if not exists public.admin_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  added_by   uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
comment on table public.admin_users is 'Users allowed to open the admin panel and see every submission. The first admin must be added by hand in the SQL Editor (see README step 6).';

create table if not exists public.leads (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users (id) on delete set null,
  name            text not null,
  phone           text not null,
  email           text,
  country         text not null check (country in ('Canada', 'USA')),
  visa_type       text not null check (visa_type in ('Visit', 'Study', 'Work', 'Business', 'Family', 'Super Visa', 'Refusal re-apply')),
  submission_type text not null default 'Free assessment'
                  check (submission_type in ('Appointment', 'Eligibility analysis', 'Free assessment', 'Contact')),
  message         text,
  status          text not null default 'New'
                  check (status in ('New', 'Contacted', 'In progress', 'Closed')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.leads is 'Every appointment / contact / assessment request from the public website. user_id is empty when the visitor did not sign in.';

create table if not exists public.assessments (
  id                    uuid primary key default gen_random_uuid(),
  lead_id               uuid references public.leads (id) on delete cascade,
  user_id               uuid references auth.users (id) on delete set null,
  country               text check (country in ('Canada', 'USA')),
  visa_type             text check (visa_type in ('Visit', 'Study', 'Work', 'Business', 'Family', 'Super Visa', 'Refusal re-apply')),
  age                   integer check (age between 16 and 100),
  education             text,
  work_experience_years integer check (work_experience_years >= 0),
  ielts_score           numeric(3, 1) check (ielts_score between 0 and 9),
  funds_cad             numeric(12, 2) check (funds_cad >= 0),
  travel_history        text,
  refusal_history       text,
  result                text check (result in ('Strong', 'Needs improvement', 'Not eligible yet')),
  analysis_text         text,
  source_links          jsonb not null default '[]'::jsonb,
  checked_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
comment on table public.assessments is 'Eligibility-analysis submissions. result / analysis_text / source_links are filled in by the admin or, later, by the live-analysis Edge Function.';

create table if not exists public.admin_notes (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.leads (id) on delete cascade,
  assessment_id uuid references public.assessments (id) on delete set null,
  admin_id      uuid references auth.users (id) on delete set null,
  note          text not null,
  created_at    timestamptz not null default now()
);
comment on table public.admin_notes is 'Internal notes only the admin can see and write.';

create table if not exists public.documents (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid references public.leads (id) on delete cascade,
  user_id         uuid references auth.users (id) on delete set null,
  file_name       text not null,
  file_path       text not null,
  file_type       text,
  file_size_bytes bigint check (file_size_bytes >= 0),
  uploaded_at     timestamptz not null default now()
);
comment on table public.documents is 'Metadata for files in the documents storage bucket. file_path is the path inside the bucket, for example <user_id>/<lead_id>/passport.pdf.';

-- ----------------------------------------------------------------------------
-- Helper functions (after the tables: Postgres checks the tables a
-- function reads at the time the function is created)
-- ----------------------------------------------------------------------------

-- True when the signed-in user is listed in admin_users.
-- SECURITY DEFINER so it can read admin_users even when RLS is on.
-- The search_path is pinned so nobody can redirect the lookup.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users where user_id = auth.uid()
  );
$$;

grant execute on function public.is_admin() to anon, authenticated;

-- Keeps updated_at fresh on every row change.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Creates a profiles row automatically whenever someone signs up.
-- Reads the full_name and phone the website sends at sign-up time.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, phone)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'phone'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- Triggers
-- ----------------------------------------------------------------------------

-- Auto-create a profile row on sign-up.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep updated_at fresh.
drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists set_leads_updated_at on public.leads;
create trigger set_leads_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

drop trigger if exists set_assessments_updated_at on public.assessments;
create trigger set_assessments_updated_at
  before update on public.assessments
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Indexes (fast lookups for the admin panel)
-- ----------------------------------------------------------------------------

create index if not exists leads_phone_idx        on public.leads (phone);
create index if not exists leads_email_idx        on public.leads (email);
create index if not exists leads_status_idx       on public.leads (status);
create index if not exists leads_created_at_idx   on public.leads (created_at desc);
create index if not exists leads_user_id_idx      on public.leads (user_id);

create index if not exists assessments_lead_id_idx    on public.assessments (lead_id);
create index if not exists assessments_user_id_idx    on public.assessments (user_id);
create index if not exists assessments_created_at_idx on public.assessments (created_at desc);
create index if not exists assessments_result_idx     on public.assessments (result);

create index if not exists admin_notes_lead_id_idx    on public.admin_notes (lead_id);
create index if not exists admin_notes_created_at_idx on public.admin_notes (created_at desc);

create index if not exists documents_lead_id_idx     on public.documents (lead_id);
create index if not exists documents_user_id_idx     on public.documents (user_id);
create index if not exists documents_uploaded_at_idx on public.documents (uploaded_at desc);

create index if not exists profiles_email_idx on public.profiles (email);

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
-- Rules in plain words:
--   * Anyone (signed in or not) may SUBMIT a lead or an assessment.
--   * A signed-in user may only READ their own leads, assessments,
--     profile and documents.
--   * Only admins may see everything, change a lead status, write the
--     analysis result, or read/write admin notes.
--   * The service_role key (used only by the Edge Function on the server)
--     bypasses RLS completely, so it is never needed in the browser.
--   * INSERT ... RETURNING only returns rows the caller may also SELECT.
--     Anonymous submissions therefore must NOT ask for the row back
--     (see website/supabase-config.example.js); they just confirm success.
-- ----------------------------------------------------------------------------

alter table public.profiles     enable row level security;
alter table public.admin_users  enable row level security;
alter table public.leads        enable row level security;
alter table public.assessments  enable row level security;
alter table public.admin_notes  enable row level security;
alter table public.documents    enable row level security;

-- Table privileges: RLS policies decide *which* rows a caller may touch,
-- but Postgres also needs table-level privileges first. Without these,
-- every query fails with "permission denied for table" (42501) even when
-- a policy would allow it. Grant broadly to both roles and let RLS restrict.
grant select, insert, update, delete on public.profiles     to anon, authenticated;
grant select, insert, update, delete on public.admin_users  to anon, authenticated;
grant select, insert, update, delete on public.leads        to anon, authenticated;
grant select, insert, update, delete on public.assessments  to anon, authenticated;
grant select, insert, update, delete on public.admin_notes  to anon, authenticated;
grant select, insert, update, delete on public.documents    to anon, authenticated;

-- profiles: a user reads and edits only their own row; admins read all.
drop policy if exists "Users read own profile" on public.profiles;
create policy "Users read own profile"
  on public.profiles for select to authenticated
  using (auth.uid() = id or public.is_admin());

drop policy if exists "Users create own profile" on public.profiles;
create policy "Users create own profile"
  on public.profiles for insert to authenticated
  with check (auth.uid() = id);

drop policy if exists "Users update own profile" on public.profiles;
create policy "Users update own profile"
  on public.profiles for update to authenticated
  using (auth.uid() = id or public.is_admin())
  with check (auth.uid() = id or public.is_admin());

drop policy if exists "Admins delete profiles" on public.profiles;
create policy "Admins delete profiles"
  on public.profiles for delete to authenticated
  using (public.is_admin());

-- admin_users: only admins may read or change the admin list.
-- (The first admin is added by hand in the SQL Editor, which bypasses RLS.)
drop policy if exists "Admins read admin list" on public.admin_users;
create policy "Admins read admin list"
  on public.admin_users for select to authenticated
  using (public.is_admin());

drop policy if exists "Admins manage admin list" on public.admin_users;
create policy "Admins manage admin list"
  on public.admin_users for insert to authenticated
  with check (public.is_admin());

drop policy if exists "Admins remove admins" on public.admin_users;
create policy "Admins remove admins"
  on public.admin_users for delete to authenticated
  using (public.is_admin());

-- leads: anyone may submit; owners and admins may read; admins may change.
drop policy if exists "Anyone can submit a lead" on public.leads;
create policy "Anyone can submit a lead"
  on public.leads for insert to anon, authenticated
  with check (true);

drop policy if exists "Owners and admins read leads" on public.leads;
create policy "Owners and admins read leads"
  on public.leads for select to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists "Admins update leads" on public.leads;
create policy "Admins update leads"
  on public.leads for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Admins delete leads" on public.leads;
create policy "Admins delete leads"
  on public.leads for delete to authenticated
  using (public.is_admin());

-- assessments: anyone may submit; owners and admins may read; admins may change.
drop policy if exists "Anyone can submit an assessment" on public.assessments;
create policy "Anyone can submit an assessment"
  on public.assessments for insert to anon, authenticated
  with check (true);

drop policy if exists "Owners and admins read assessments" on public.assessments;
create policy "Owners and admins read assessments"
  on public.assessments for select to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists "Admins update assessments" on public.assessments;
create policy "Admins update assessments"
  on public.assessments for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Admins delete assessments" on public.assessments;
create policy "Admins delete assessments"
  on public.assessments for delete to authenticated
  using (public.is_admin());

-- admin_notes: admins only, for every action.
drop policy if exists "Admins read notes" on public.admin_notes;
create policy "Admins read notes"
  on public.admin_notes for select to authenticated
  using (public.is_admin());

drop policy if exists "Admins write notes" on public.admin_notes;
create policy "Admins write notes"
  on public.admin_notes for insert to authenticated
  with check (public.is_admin());

drop policy if exists "Admins update notes" on public.admin_notes;
create policy "Admins update notes"
  on public.admin_notes for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Admins delete notes" on public.admin_notes;
create policy "Admins delete notes"
  on public.admin_notes for delete to authenticated
  using (public.is_admin());

-- documents: only signed-in users may register a file, and only for
-- themselves. Owners and admins may read; owners and admins may delete.
drop policy if exists "Users register own documents" on public.documents;
create policy "Users register own documents"
  on public.documents for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Owners and admins read documents" on public.documents;
create policy "Owners and admins read documents"
  on public.documents for select to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists "Owners and admins update documents" on public.documents;
create policy "Owners and admins update documents"
  on public.documents for update to authenticated
  using (auth.uid() = user_id or public.is_admin())
  with check (auth.uid() = user_id or public.is_admin());

drop policy if exists "Owners and admins delete documents" on public.documents;
create policy "Owners and admins delete documents"
  on public.documents for delete to authenticated
  using (auth.uid() = user_id or public.is_admin());

-- ----------------------------------------------------------------------------
-- Done. Quick checks (run these by hand in the SQL Editor if you like):
--
--   select count(*) from public.leads;          -- 0 on a fresh project
--   select count(*) from public.assessments;    -- 0 on a fresh project
--   select * from public.admin_users;           -- your admin row, after step 6
-- ----------------------------------------------------------------------------
