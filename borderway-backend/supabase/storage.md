# Documents storage — bucket plan

## The plan

- **One private bucket** named `documents` for everything visitors upload
  (passport, bank statements, education papers, photos).
- **Private** means nobody can open a file from a public link. A file can
  only be opened by the person who uploaded it, or by an admin.
- **File layout inside the bucket:** `<user_id>/<lead_id>/<file_name>`
  (example: `a1b2c3d4.../e5f6g7h8.../passport.pdf`). The first folder is
  always the uploader's own user id — the security rules below rely on it.
- **10 MB limit per file.** Big enough for a scanned PDF or photo, small
  enough that the free 1 GB of storage is not eaten by one upload.
- **Allowed file types:** PDF, JPG, PNG, Word documents only.
- **Free tier:** Supabase free projects include 1 GB of storage. At 10 MB
  per file that is roughly 100 documents. The admin should download old
  files and delete them from the bucket when space runs low.
- **Anonymous visitors cannot upload.** A visitor must sign in first, then
  upload. A visitor who has not signed in sends documents over WhatsApp
  instead (that is how the current website already works).

## Step 1 — create the bucket

Run this in the Supabase Dashboard → SQL Editor → New query → Run.
It is safe to run twice: the second run changes nothing.

```sql
-- Create the private documents bucket (10 MB per file, PDF/images/Word only).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents',
  'documents',
  false,
  10485760,
  array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do nothing;
```

Check it worked: Storage in the left menu → you should see a bucket
called `documents` with a lock icon (private).

## Step 2 — access rules for the bucket

Run this in the SQL Editor as well. These are Row Level Security policies
on the `storage.objects` table (RLS is already switched on for storage).

```sql
-- UPLOAD: a signed-in user may upload only into their own folder.
drop policy if exists "Users upload own documents" on storage.objects;
create policy "Users upload own documents"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- VIEW: the owner or an admin may view a file.
drop policy if exists "Owners and admins view documents" on storage.objects;
create policy "Owners and admins view documents"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'documents'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_admin()
    )
  );

-- REPLACE: the owner or an admin may replace a file.
drop policy if exists "Owners and admins replace documents" on storage.objects;
create policy "Owners and admins replace documents"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'documents'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_admin()
    )
  )
  with check (
    bucket_id = 'documents'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_admin()
    )
  );

-- DELETE: the owner or an admin may delete a file.
drop policy if exists "Owners and admins delete documents" on storage.objects;
create policy "Owners and admins delete documents"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'documents'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_admin()
    )
  );
```

Notes on the rules above:

- `public.is_admin()` is the helper created by `schema.sql`. Run
  `schema.sql` first, then this file, or the `is_admin()` calls will fail.
- `storage.foldername(name)` splits the file path on `/` and returns the
  folder parts, so `[1]` is the user-id folder.
- The website must also write one row into the `documents` table
  (see `website/supabase-config.example.js`, `uploadDocument`) so the
  admin panel can list files without scanning the bucket.

## Step 3 — how the website uses it

1. Visitor signs in.
2. Website uploads the file to `documents/<user_id>/<lead_id>/<file_name>`.
3. Website inserts one row into the `documents` table with the same path.
4. Admin opens the lead in the admin panel, sees the file list, and
   downloads a file through a short-lived signed URL
   (`supabase.storage.from('documents').createSignedUrl(path, 3600)`).
   Signed URLs expire after 1 hour on purpose, so a shared link stops
   working.
