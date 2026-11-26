# Live-analysis Edge Function — outline

## What it will do

A Supabase Edge Function (Deno + TypeScript) that runs the eligibility
analysis **at the moment a visitor submits**, instead of using fixed rules:

1. The website sends a profile (age, education, work experience, IELTS,
   funds, travel history, refusal history, country, visa type).
2. The function fetches the **current official pages** — canada.ca / IRCC
   for Canada, uscis.gov and travel.state.gov for the USA — and reads
   what they say right now.
3. It sends the profile plus the official policy text to an LLM, which
   writes the analysis: result (`Strong`, `Needs improvement` or
   `Not eligible yet`), reasons, and the source links it used.
4. It saves the result into the `assessments` row and returns it to the
   website, so the visitor sees it immediately and the admin sees it in
   the admin panel.

> This file is an **outline only**. There are no API keys in this pack,
> nothing here calls the internet, and no function is deployed yet.
> Secrets and deployment happen in a later step, with the owner's
> accounts.

## Files (to create later)

```text
supabase/
  config.toml                      # verify_jwt = true for live-analysis
  functions/
    live-analysis/
      index.ts                     # the function (skeleton below)
      deno.json                    # import map (optional)
```

## Request and response

**Request** — `POST /functions/v1/live-analysis`
(headers: `Authorization: Bearer <user JWT>`, `Content-Type: application/json`)

```json
{
  "assessment_id": "00000000-0000-0000-0000-000000000000"
}
```

The function loads the profile from the `assessments` table itself, so
the browser never has to trust the visitor's data twice. (Sending the
profile inline instead of an id is also possible; loading by id is safer.)

**Response** — success:

```json
{
  "assessment_id": "00000000-0000-0000-0000-000000000000",
  "result": "Needs improvement",
  "analysis_text": "Your profile is close. Funds meet the requirement, but ...",
  "source_links": [
    { "title": "Visit Canada: Who can apply", "url": "https://www.canada.ca/..." },
    { "title": "Proof of funds — Express Entry", "url": "https://www.canada.ca/..." }
  ],
  "checked_at": "2026-11-26T12:00:00.000Z"
}
```

**Response** — error (for example, official pages unreachable):

```json
{ "error": "Official policy pages could not be read right now. Your submission is saved and the admin will review it." }
```

The submission is **always saved first** (the website already inserted
the assessment row). A failed live check never loses the lead.

## Official sources (starting list — verify each URL still resolves when building)

Canada (IRCC / canada.ca):

- Visitor visa, who can apply:
  `https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada/eligibility.html`
- Study permit:
  `https://www.canada.ca/en/immigration-refugees-citizenship/services/study-canada/study-permit/eligibility.html`
- Proof of funds, Express Entry:
  `https://www.canada.ca/en/immigration-refugees-citizenship/services/immigrate-canada/express-entry/documents/proof-funds.html`
- Super Visa (parents and grandparents):
  `https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada/parent-grandparent-super-visa.html`

USA (travel.state.gov / uscis.gov):

- Visitor visa B1/B2:
  `https://travel.state.gov/content/travel/en/us-visas/tourism-visit/visitor.html`
- Student visa F-1:
  `https://travel.state.gov/content/travel/en/us-visas/study/student-visa.html`
- Working in the United States (USCIS):
  `https://www.uscis.gov/working-in-the-united-states`

Government pages move and get renamed. The function must treat a
missing or changed page as a normal error (see the error response
above), never as a reason to invent policy.

## Flow inside the function

```text
1. Check the Authorization header. Reject the call when there is no
   valid user JWT (verify_jwt = true in config.toml does this first).
2. Load the assessment row with the service_role client.
3. Check the caller owns the assessment, or is an admin. Reject others.
4. Pick the source list by country (Canada -> IRCC pages, USA -> State
   Dept / USCIS pages). Pick 2-4 pages, never more.
5. Fetch the pages in parallel (Promise.all, 10 second timeout each),
   with a normal browser User-Agent header. Strip HTML tags, scripts
   and navigation. Keep at most ~6,000 characters per page.
6. Build the LLM prompt: the visitor profile + the policy excerpts +
   a fixed instruction (answer only from the excerpts, give one of the
   three results, list the source URLs used, never guarantee a visa).
7. Call the LLM (endpoint, model and key come from Edge Function
   secrets — see below). Ask for JSON output only.
8. Validate the JSON (result is one of the three allowed values,
   source links are from the fetched pages). On bad output, retry once,
   then fall back to the error response.
9. Update the assessments row (result, analysis_text, source_links,
   checked_at) with the service_role client.
10. Return the response JSON.
```

## Code skeleton (outline — fill in at build time)

```ts
// supabase/functions/live-analysis/index.ts
// Deno Edge Function. Requires secrets: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, LLM_API_URL, LLM_API_KEY, LLM_MODEL.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const OFFICIAL_SOURCES: Record<string, { title: string; url: string }[]> = {
  Canada: [
    // TODO: fill from the source list above
  ],
  USA: [
    // TODO: fill from the source list above
  ],
};

async function fetchPolicyText(url: string): Promise<string> {
  // TODO: fetch with a browser User-Agent and a 10s timeout,
  // strip tags/scripts, truncate to ~6000 chars.
  throw new Error("not implemented in outline");
}

async function askLlm(profile: unknown, policyText: string): Promise<unknown> {
  // TODO: POST to Deno.env.get("LLM_API_URL") with the key from
  // Deno.env.get("LLM_API_KEY"), ask for strict JSON output.
  throw new Error("not implemented in outline");
}

serve(async (req) => {
  // TODO: 1. verify the caller (getUser with the Bearer token).
  // TODO: 2. load the assessment by id (service_role client).
  // TODO: 3. check ownership or admin.
  // TODO: 4. fetch official pages, 5. ask the LLM, 6. validate,
  //        7. update the row, 8. return the JSON response.
  return new Response(JSON.stringify({ error: "not implemented in outline" }), {
    status: 501,
    headers: { "Content-Type": "application/json" },
  });
});
```

## Secrets (set later — placeholders only, never put real values here)

Set with the Supabase CLI after the project exists:

```bash
supabase secrets set \
  LLM_API_URL="https://example-llm-provider.invalid/v1/chat" \
  LLM_API_KEY="PASTE-KEY-HERE" \
  LLM_MODEL="provider-model-name"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to Edge
Functions by Supabase automatically. The `service_role` key must never
appear in website code or in this pack.

## Deploy (later)

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase functions deploy live-analysis
```

## Cost, limits and safety notes

- **Official pages change slowly.** Fetching 2-4 pages per analysis is
  fine at low volume. Do not fetch dozens of pages per call.
- **LLM cost is per call** (paid, per token, provider rates apply).
  Keep the policy excerpts short so each call stays cheap.
- **Timeouts:** Edge Functions have a default wall-clock limit. Keep
  the whole flow under ~25 seconds: parallel fetches, short excerpts,
  one LLM call, one retry at most.
- **Never guarantee a visa.** The prompt must force the model to say
  the final decision rests with the embassy, and to answer only from
  the official text it was given. If the official pages do not cover
  something, the answer must say so instead of guessing.
- **Privacy:** the function receives only the profile fields needed
  for the analysis. No names, phone numbers or email addresses are
  sent to the LLM.
- **Audit:** every run is stored on the assessment row (`checked_at`
  and `source_links`), so the admin can see exactly what was checked
  and when.
