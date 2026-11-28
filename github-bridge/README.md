# GitHub Bridge

One small app that works as a **connector** between any AI chatbot and your
GitHub repos. The bot connects **directly** to the bridge, and through the
bridge it gets access to edit the repo — the bot never sees your GitHub
token, so the token-security objection disappears. No computer, no git
commands, no paid plan. Works fully from your phone.

For bots that cannot connect to anything at all, the bridge also has a web
page where you paste the bot's files and sync them yourself (fallback — see
below).

## Cost: Rs 0, forever

- **Cloudflare Workers free tier** — no card required, 100,000 requests a
  day. This bridge makes a handful of requests per sync. You will never hit
  the limit, and Cloudflare cannot bill you without a card on file.
- **GitHub free account + free personal access token.**
- **No paid bot needed.** The direct MCP connection works with the free
  Claude desktop app and other free MCP clients, and the web-page fallback
  works with the **free** versions of ChatGPT, DeepSeek, Claude, Gemini,
  etc. — you only copy their output.
- Nothing in this design can start charging you. No billing is set up
  anywhere.

## The workflow (main path — the bot connects directly)

The bridge is a **connector**: the bot connects to it, and it connects to
GitHub. The bot never handles your GitHub token.

1. Deploy the bridge (steps below) — once.
2. In your bot, add the bridge as a connector: paste your `/mcp` address
   and your BRIDGE_KEY as the bearer token. (Exact steps per bot are in the
   table below.)
3. Ask the bot to build or change your site/app. It calls the bridge's
   tools (`list_files`, `read_file`, `write_file`, `delete_file`,
   `sync_bundle`) and the bridge does the GitHub work with your token.
4. Done. Old files from the last bundle that are missing now are **deleted
   automatically**. Unchanged files are left alone. Everything lands in **one
   commit**.

Why this removes the bot's objection: the bot never sees, stores or sends
your GitHub token anywhere — the token lives only in the Worker as a
secret, and the bot only gets narrow tools (read/write/delete files in the
repos you ticked). The security worry was about the token; the connector
takes the token out of the bot's hands entirely.

Honest limit: a bot can only connect directly if its platform allows
external connections (MCP). A bot that cannot connect to anything at all
(DeepSeek web/app, ChatGPT web free) cannot be connected by ANY app — the
connection has to come from the bot's side. For those bots, use the web-page
fallback below.

## Fallback — the web page (for bots that cannot connect at all)

1. Ask any bot to build or change your site/app.
2. Send it the prompt below (also built into the web page — one tap copies it).
   It tells the bot to output ALL files as ONE JSON bundle.
3. Copy the bot's answer, open your bridge page, paste it in **section 4B**,
   press **Preview sync**, check the lists, press **Confirm sync**.
4. Done — same smart sync as above.

### The prompt to paste to any bot

```text
Please output ALL the files for this project as ONE JSON code block, and nothing else outside it. Use this exact format:

```json
{"files":[{"path":"index.html","content":"...full file content here..."},{"path":"assets/style.css","content":"..."}]}
```

Rules:
1. Include EVERY file, with its COMPLETE content. Do not shorten, summarise or use placeholders.
2. Paths are relative to the project root, using / between folders, for example assets/style.css
3. If a file is an image or other binary file, set encoding to base64 and put the base64 data in content.
4. Do not leave out any file that belongs in the project. Files that were in the last bundle but are missing from your bundle will be DELETED from the repo.
5. Do not put any explanation outside the code block.
```

### The web page can also do

- **Pick files / a folder** from your phone and sync them (section 4A).
- **Browse the repo tree**, open any file, edit it and save it, or delete it
  (sections 2–3). Your bridge key is saved on your phone only.

## How the smart sync works (the fix for the old zip app)

The old zip-push app only ever *added* files — old files stayed in the repo
forever, so every change needed a whole fresh zip.

The bridge keeps a small manifest at `.bridge/manifest.json` in the repo,
listing the files from the last sync. On the next sync it:

- **adds** files that are new,
- **updates** files whose content changed,
- **deletes** files that were in the last bundle but are missing now,
- **leaves unchanged files alone** (they are not rewritten),
- writes the new manifest in the **same single commit**.

Preview first with `dry_run` (the web page's **Preview sync** button) to see
exactly what would change before anything is written.

## Deploy — 3 steps (about 10 minutes, phone only)

### Step 1 — Make a GitHub token (free)

Open this link (verified 28 Nov 2026 — it opens GitHub's token page):

**https://github.com/settings/personal-access-tokens/new**

If it asks you to sign in, sign in with your GitHub account (arshadldbr).
Then set:

| Field | Value |
|---|---|
| Token name | `GitHub Bridge` |
| Expiration | 1 year (fine-grained tokens must expire — set a reminder to make a new one in a year) |
| Resource owner | arshadldbr |
| Repository access | **Only select repositories** — tick `Immigration` (and any other repo you want the bridge to touch) |
| Permissions → Repository permissions → **Contents** | **Read and write** (Metadata: Read-only is added automatically) |

Press **Generate token** and **copy it at once** — GitHub shows it only once.
It starts with `github_pat_`. Keep it private; never paste it in a chat.

### Step 2 — Create the Cloudflare Worker (free)

Open this link (goes straight to the create page; if it lands on the wrong
tab, use the second link and tap **Create → Worker**):

- Create page: **https://dash.cloudflare.com/?to=/:account/workers-and-pages/create**
- List page (fallback): **https://dash.cloudflare.com/?to=/:account/workers-and-pages**

Then:

1. Choose the **Worker** tab (not Pages) → **Start with Hello World!**
2. Name it `github-bridge` → **Deploy**.
3. On the worker page, tap **Edit code**. Select all the starter code,
   delete it, and paste the whole contents of `worker.js` from this folder.
   Tap **Deploy**.
4. Go to **Settings → Variables → Add** and add these three (tap **Encrypt**
   / secret for the first two — secrets are hidden after saving):
   - `GITHUB_TOKEN` — secret — paste the token from Step 1.
   - `BRIDGE_KEY` — secret — a passphrase **you** invent (long and random,
     e.g. four random words with numbers). This is the key you type in the
     web page and give to bots — it is the only thing protecting your repos.
   - `DEFAULT_OWNER` — plain text variable — `arshadldbr`.
5. Tap **Deploy** again so the new variables take effect.

Your bridge address is shown on the worker page — it looks like:

**https://github-bridge.&lt;your-subdomain&gt;.workers.dev**

Open it on your phone. If it shows the GitHub Bridge page, Step 2 worked.

Official Cloudflare guide (same steps):
https://developers.cloudflare.com/workers/get-started/dashboard/

### Step 3 — Use it

**Main path — connect a bot:** in your bot, add the `/mcp` address (see the
table below) with your BRIDGE_KEY, then just ask the bot to change the repo.

**Fallback — web page:** open your bridge address, paste the **BRIDGE_KEY**
once (it is saved on your phone), set **Repo** to `Immigration`, tap **Load
files**. Use the **Copy this prompt** button, paste the prompt to any bot,
paste the bot's answer back in section 4B, Preview, Confirm sync.

## Connecting a bot directly — the details

The bridge speaks MCP (remote Streamable HTTP, stateless JSON-RPC 2.0)
at `https://github-bridge.<your-subdomain>.workers.dev/mcp`, plus a small
REST API (`/api/tree`, `/api/file`, `/api/sync`, header `X-Bridge-Key`).
Tools: `list_files`, `read_file`, `write_file`, `delete_file`, `sync_bundle`.

Direct connection works with any bot whose platform allows remote MCP
servers. What was verified on 28 Nov 2026:

| Bot | Direct connection | Notes |
|---|---|---|
| **Claude** (web, desktop, mobile) | Works | Customize → Connectors → + Add → Add custom connector. URL = your `/mcp` address. Choose **No sign-in**, add request header `authorization` with value `Bearer <your BRIDGE_KEY>` (type the `Bearer ` part yourself). Free plan allows 1 custom connector. |
| **ChatGPT desktop app** | Works | Plugins → MCPs → Add → Streamable HTTP, URL = your `/mcp` address, **Bearer token** field = your BRIDGE_KEY only (ChatGPT adds `Bearer ` itself). |
| **ChatGPT web** | Does NOT work with a key | Web only supports OAuth for custom MCP servers, and this bridge has no OAuth. Use the web page instead. (Custom MCP on web also needs a Business/Enterprise/Edu workspace; Pro is read-only per OpenAI's help page, Nov 2026.) |
| **DeepSeek** (web/app) | Does NOT work | DeepSeek web/app cannot call external tools or MCP servers at all. Use the web page: DeepSeek writes the files, you paste them. (DeepSeek's own API/harness tools exist for developers, not in the chat app.) |
| **Cursor / VS Code / Claude Code** | Works | Any MCP client that takes a remote Streamable HTTP URL + a static bearer header. |

MCP spec followed: Model Context Protocol, revision 2026-07-28
(stateless Streamable HTTP, no session id). The server also answers the
older `initialize` handshake (protocolVersion, capabilities `{tools:{}}`,
serverInfo) because most clients still send it, and accepts
`notifications/initialized` with a 202.
Spec: https://modelcontextprotocol.io/specification/2026-07-28

## Safety — read this

- **BRIDGE_KEY is the only lock.** Anyone with your bridge address AND the
  key can read and write every repo your token can see. Keep the key private
  and never paste it into a public chat or screenshot.
- The GitHub token is scoped to **only the repos you ticked** in Step 1,
  with only Contents read/write. It cannot create repos, cannot touch your
  other repos, and cannot change your account.
- If a key ever leaks: delete the token on GitHub and make a new one, and
  change BRIDGE_KEY in the Worker settings. Both take two minutes.
- The bridge never returns or logs either secret. Errors are plain English.
- Limits (to keep one bad sync from doing damage): 5 MB per file, max
  50 files per sync, max 20 MB per bundle. Paths with `..`, absolute paths,
  hidden folders and `.git` are rejected.

## Files in this folder

- `worker.js` — the whole bridge (web page + MCP + REST). One file, no
  dependencies, no build step. Paste it into the Worker as-is.
- `README.md` — this file.

## What was verified — and what was NOT

Verified on 28 Nov 2026 (in a sandbox, no real tokens used):

- `node --check worker.js` — syntax clean.
- A Node test (`test-bridge.mjs`, kept locally, not in the repo) ran the
  worker with a **mocked** GitHub: initialize handshake, tools/list (all 5
  tools), tools/call `list_files` / `read_file` / `write_file`, `sync_bundle`
  dry-run (correct added / updated / unchanged / deleted), and a real mocked
  sync commit that **deleted the stale file** and updated the manifest in
  one commit — 34 checks, all passed. Unauthenticated requests get 401.
- Links checked: the GitHub token page loads; the Cloudflare Workers
  dashboard guide is current; the MCP spec revision 2026-07-28 and the
  client-support facts above were checked against sources dated Oct–Nov 2026.

NOT verified (needs Arshid, on his phone):

- Deploying the Worker, adding the secrets, and opening the page.
- A real sync to the real `Immigration` repo.
- Connecting a real bot (Claude / ChatGPT desktop) to the real `/mcp` URL.
- The Cloudflare "Create Worker" deep link is pattern-matched from the
  verified Pages create link — if it lands on the wrong tab, use the list
  link in Step 2 and tap Create → Worker.
