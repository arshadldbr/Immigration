# Borderway International — backend setup checklist

This pack gives the Borderway website a real database, user accounts,
and a place for documents. It does **not** create any accounts and it
contains **no passwords or keys**. You will create one free account
and paste two values. That is all. Allow about 20 minutes.

## What is in this pack

| File | What it is |
|---|---|
| `supabase/schema.sql` | All database tables + security rules. You run it once. |
| `supabase/storage.md` | Plan + ready SQL for the private documents bucket. |
| `supabase/edge-function-outline.md` | Outline for the later live-analysis feature. Nothing to do now. |
| `website/supabase-config.example.js` | Website code (example). Copy it, fill in 2 values. |
| `README.md` | This file. |

## Before you start

- A Supabase account (free). Go to **supabase.com** → Sign up with
  your email. The free plan includes a 500 MB database, 1 GB of file
  storage, and 50,000 user logins per month. That is enough to start.
- Note: a free project **pauses after 1 week with no activity**.
  Opening the project once a week keeps it awake. You can upgrade
  later if the business grows.

## Step 1 — Create the project

1. Log in at supabase.com → **New project**.
2. Name: `Borderway`.
3. Database password: Supabase makes one for you — save it somewhere
   safe (a password manager). You will almost never need it.
4. Region: pick the closest to Pakistan (for example **Singapore** or
   **Mumbai**).
5. Click **Create new project** and wait about 2 minutes.

## Step 2 — Create the tables (run schema.sql)

1. In the left menu, open **SQL Editor** → **New query**.
2. Open the file `supabase/schema.sql` from this pack, copy **all** of it,
   paste it into the query box.
3. Click **Run**. You should see "Success. No rows returned."
4. That is it. Your tables now exist: `leads`, `assessments`,
   `profiles`, `admin_users`, `admin_notes`, `documents`.

## Step 3 — Turn on email sign-in

1. Left menu → **Authentication** → **Providers**.
2. Find **Email** and switch it **on**.
3. Keep **Confirm email** switched **on** (recommended): new users get
   a confirmation link before they can sign in.
4. Click **Save**.

## Step 4 — Create the documents bucket

1. Left menu → **SQL Editor** → **New query**.
2. Open `supabase/storage.md` and copy the SQL from **Step 1** (create
   the bucket). Paste and **Run**.
3. In a second new query, copy the SQL from **Step 2** (access rules).
   Paste and **Run**.
4. Check: left menu → **Storage** → you should see a bucket called
   `documents` with a lock icon (private).

## Step 5 — Connect the website

1. Left menu → **Settings** (gear icon) → **API**.
2. Copy two values:
   - **Project URL** (looks like `https://abcdefghijklm.supabase.co`)
   - **anon public** key (a very long code starting with `eyJ...`)
3. In this pack, copy `website/supabase-config.example.js` to a new
   file called `supabase-config.js`.
4. In `supabase-config.js`, replace the two placeholders:
   - `YOUR-PROJECT-REF` → your Project URL
   - `YOUR-ANON-KEY-HERE` → your anon key
5. Use `supabase-config.js` in the website (the developer building the
   website will know where it goes).
6. **Never** copy the `service_role` key into the website. That key
   bypasses all security and must only ever live on a server.

## Step 6 — Make yourself the admin

1. First, **sign up on the website** with your own email (the same
   email you want to use as admin). Confirm the email if asked.
2. In Supabase, go to **Authentication** → **Users**. Find your email
   and copy the long **UUID** next to it.
3. Go to **SQL Editor** → **New query** and run this, with your UUID
   pasted in place of `PASTE-YOUR-USER-UUID-HERE`:

```sql
insert into public.admin_users (user_id)
values ('PASTE-YOUR-USER-UUID-HERE');
```

4. You are now the admin. The admin panel will show you every lead
   and assessment. To add a second admin later, repeat this step with
   their UUID.

## Step 7 — Test it (5 minutes)

1. On the website, sign up with a **different** test email.
2. Submit an appointment request and an eligibility analysis.
3. In Supabase, open **Table Editor** → `leads`. Your test rows
   should be there with status `New`.
4. Open `assessments`. Your test analysis should be there with an
   empty result (the admin fills it in, or the live-analysis feature
   does it later).
5. Sign in as your admin email and check that you can see both rows.
6. Sign in as the test email and check that you can **only** see your
   own rows. If the test user sees other people's rows, stop and ask
   for help — the security rules are the whole point.

## Step 8 — Later: live analysis (not now)

When the website is live and working, follow
`supabase/edge-function-outline.md` to add the feature that reads the
official Canada/US government pages at submission time and writes the
analysis. It needs an LLM key (paid, a small amount per analysis).
Nothing in this pack needs that key today.

## If something goes wrong

| Problem | What it usually means |
|---|---|
| `row violates row-level security policy` when submitting | The security rules blocked the insert. Check that `schema.sql` ran fully, and that the website sends `country` as exactly `Canada` or `USA`. |
| Sign-up works but sign-in says "Email not confirmed" | The confirmation email went to spam, or **Confirm email** is on and the link was not clicked. Check spam, or turn **Confirm email** off in Authentication → Providers → Email. |
| Upload fails | The visitor must be signed in first, and the file must be PDF/JPG/PNG/Word and under 10 MB. |
| Project says "Paused" | Free projects pause after 1 week of no activity. Open the project in the dashboard and click **Restore**. |
| `relation "public.leads" does not exist` | `schema.sql` did not run, or ran in the wrong project. Re-run Step 2. |

## Free-tier limits to remember

- Database: 500 MB. Leads and assessments are tiny text — this lasts
  a very long time.
- File storage: 1 GB total. At 10 MB per file, about 100 documents.
  Download old files and delete them from Storage when space runs low.
- Auth: 50,000 logins per month. Far more than a new website needs.
- A free project pauses after 1 week of no activity — open it weekly.
