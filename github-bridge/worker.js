/**
 * GitHub Bridge — one file, no dependencies, no build step.
 *
 * What it is (plain words): a small app that lives on Cloudflare and holds
 * your GitHub token. ANY AI chatbot can edit your GitHub repos through it —
 * or, if the bot refuses, YOU paste the bot's files into the web page and
 * the bridge syncs them for you. That second way (the web page) is the one
 * that always works, with every bot, for free.
 *
 * Cost: Rs 0, forever. Cloudflare Workers free tier (no card needed,
 * 100,000 requests a day — far above this use) + a free GitHub account and
 * a free personal access token. No paid service anywhere in this design.
 *
 * Three ways in:
 *   1. Web UI (PRIMARY — works with every bot, no connector needed):
 *      GET /  — paste a JSON bundle or pick files, preview, sync.
 *   2. MCP (BONUS — for bots that support remote MCP servers):
 *      POST /mcp — Streamable HTTP, stateless JSON-RPC 2.0.
 *      Answers the 2025-11-25 initialize handshake for compatibility
 *      (the 2026-07-28 spec removed the handshake, but most clients
 *      still send it) and also works statelessly without it.
 *   3. REST API (BONUS): /api/tree, /api/file, /api/sync.
 *
 * Secrets (set in the Cloudflare dashboard, NEVER in this file):
 *   GITHUB_TOKEN  — fine-grained GitHub PAT, Contents: Read and write,
 *                   only for the repos you choose.
 *   BRIDGE_KEY    — a passphrase YOU choose. Anyone with the Worker URL
 *                   AND this key can edit those repos. Keep it private.
 *   DEFAULT_OWNER — your GitHub username (default: arshadldbr).
 *
 * The key feature — smart sync: the bridge keeps a manifest at
 * .bridge/manifest.json listing the files from the last sync. On the next
 * sync it DELETES files that were in the last bundle but are missing from
 * the new one, writes new/changed files, leaves unchanged files alone,
 * and does it all in ONE commit. That is what a plain zip-push cannot do.
 *
 * Safety: paths with "..", absolute paths, hidden folders and .git are
 * rejected. 5 MB per file, max 50 files per sync, max 20 MB per bundle.
 * Tokens are never returned or logged. Errors are plain English.
 */

const VERSION = "1.0.0";
const MANIFEST_PATH = ".bridge/manifest.json";
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per file
const MAX_SYNC_FILES = 50;
const MAX_SYNC_BYTES = 20 * 1024 * 1024; // 20 MB per bundle
const DEFAULT_OWNER_FALLBACK = "arshadldbr";
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2026-07-28"];

// ---------------------------------------------------------------- helpers

class BridgeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function bytesToBase64(bytes) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(String(b64).replace(/\s/g, ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function utf8ToBytes(str) {
  return new TextEncoder().encode(str);
}

function bytesToUtf8(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

// Git blob SHA: sha1("blob <len>\0" + content). Used to tell changed files
// from unchanged ones without downloading every file.
async function gitBlobSha(bytes) {
  const head = utf8ToBytes("blob " + bytes.length + "\0");
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head, 0);
  all.set(bytes, head.length);
  const d = await crypto.subtle.digest("SHA-1", all);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function encPath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

// Reject dangerous paths. The manifest (.bridge/...) is written by the
// bridge itself and never comes through this check from a user.
function checkPath(p) {
  if (typeof p !== "string" || !p) return "Path is empty.";
  if (p.length > 512) return "Path is too long: " + p;
  if (p.startsWith("/") || p.startsWith("\\")) return "Path must be relative, not absolute: " + p;
  if (p.includes("\\")) return "Use / (not \\) in paths: " + p;
  if (/[\x00-\x1f\x7f]/.test(p)) return "Path has invalid characters: " + p;
  const parts = p.split("/");
  for (const seg of parts) {
    if (!seg || seg === "." || seg === "..") return "Invalid path: " + p;
    if (seg === ".git") return "Invalid path: " + p;
  }
  if (parts[0].startsWith(".")) return "Hidden folders are not allowed: " + p;
  return null;
}

function keysEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function getBridgeKey(request) {
  const h = request.headers.get("Authorization") || "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return request.headers.get("X-Bridge-Key") || "";
}

function requireAuth(request, env) {
  if (!env.BRIDGE_KEY) {
    return "BRIDGE_KEY is not set on the Worker. Add it under Settings → Variables in the Cloudflare dashboard.";
  }
  if (!keysEqual(getBridgeKey(request), env.BRIDGE_KEY)) {
    return "Wrong or missing bridge key.";
  }
  return null;
}

// ---------------------------------------------------------------- GitHub API

function ghErrorMessage(status, body) {
  const m = body && body.message ? body.message : "";
  if (status === 401) return "GitHub rejected the token. Check the GITHUB_TOKEN secret in the Worker settings.";
  if (status === 403) return "GitHub refused this action. The token may lack Contents write permission, or the rate limit was hit. " + m;
  if (status === 404) return "Repo, branch or file not found. Check the owner, repo and branch names, and that the token can see that repo.";
  if (status === 422) return "GitHub could not do that: " + (m || "invalid request");
  if (status === 409) return "GitHub conflict (maybe the repo changed just now). Try again. " + m;
  return "GitHub error " + status + ": " + (m || "unknown error");
}

async function gh(env, method, path, body) {
  if (!env.GITHUB_TOKEN) {
    throw new BridgeError(500, "GITHUB_TOKEN is not set on the Worker. Add it under Settings → Variables in the Cloudflare dashboard.");
  }
  const res = await fetch("https://api.github.com" + path, {
    method,
    headers: {
      Authorization: "Bearer " + env.GITHUB_TOKEN,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-bridge/" + VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = null;
  }
  if (!res.ok) throw new BridgeError(res.status, ghErrorMessage(res.status, data));
  return data;
}

async function getDefaultBranch(env, owner, repo) {
  const r = await gh(env, "GET", "/repos/" + owner + "/" + repo);
  return r.default_branch || "main";
}

async function resolveBranch(env, owner, repo, branch) {
  if (branch) return branch;
  return await getDefaultBranch(env, owner, repo);
}

async function getBranchCommit(env, owner, repo, branch) {
  try {
    const r = await gh(env, "GET", "/repos/" + owner + "/" + repo + "/git/ref/heads/" + encodeURIComponent(branch));
    return r.object && r.object.sha ? r.object.sha : null;
  } catch (e) {
    if (e.status === 404) return null; // branch (or repo) has no commits yet
    throw e;
  }
}

async function getTree(env, owner, repo, branch) {
  const r = await gh(
    env,
    "GET",
    "/repos/" + owner + "/" + repo + "/git/trees/" + encodeURIComponent(branch) + "?recursive=1"
  );
  const files = {};
  for (const e of r.tree || []) {
    if (e.type === "blob") files[e.path] = { sha: e.sha, size: e.size || 0 };
  }
  return { files, sha: r.sha, truncated: !!r.truncated };
}

async function readFileRaw(env, owner, repo, branch, path) {
  const r = await gh(
    env,
    "GET",
    "/repos/" + owner + "/" + repo + "/contents/" + encPath(path) + "?ref=" + encodeURIComponent(branch)
  );
  if (r && r.type === "file" && r.content) {
    return { bytes: base64ToBytes(r.content), sha: r.sha, size: r.size || 0 };
  }
  if (r && r.sha) {
    // File too big for the contents API — read the blob directly.
    const b = await gh(env, "GET", "/repos/" + owner + "/" + repo + "/git/blobs/" + r.sha);
    return { bytes: base64ToBytes(b.content || ""), sha: r.sha, size: r.size || 0 };
  }
  throw new BridgeError(404, "File not found: " + path);
}

async function getManifest(env, owner, repo, branch) {
  try {
    const f = await readFileRaw(env, owner, repo, branch, MANIFEST_PATH);
    const m = JSON.parse(bytesToUtf8(f.bytes));
    if (m && Array.isArray(m.files)) return m.files.filter((x) => typeof x === "string");
  } catch (e) {
    // No manifest yet (first sync) or unreadable — nothing managed so far.
  }
  return [];
}

function ownerOf(env, args) {
  return (args && args.owner) || env.DEFAULT_OWNER || DEFAULT_OWNER_FALLBACK;
}

// ---------------------------------------------------------------- tool operations

async function doListFiles(env, args) {
  const owner = ownerOf(env, args);
  const repo = args && args.repo;
  if (!repo) throw new BridgeError(400, "repo is required.");
  const branch = await resolveBranch(env, owner, repo, args.branch);
  const tree = await getTree(env, owner, repo, branch);
  const files = Object.keys(tree.files)
    .sort()
    .map((p) => ({ path: p, sha: tree.files[p].sha, size: tree.files[p].size }));
  return { owner, repo, branch, files, count: files.length, truncated: tree.truncated };
}

async function doReadFile(env, args) {
  const owner = ownerOf(env, args);
  const repo = args && args.repo;
  if (!repo) throw new BridgeError(400, "repo is required.");
  if (!args.path) throw new BridgeError(400, "path is required.");
  const perr = checkPath(args.path);
  if (perr) throw new BridgeError(400, perr);
  const branch = await resolveBranch(env, owner, repo, args.branch);
  const f = await readFileRaw(env, owner, repo, branch, args.path);
  let encoding = "utf8";
  let content;
  try {
    content = bytesToUtf8(f.bytes);
  } catch (e) {
    encoding = "base64";
    content = bytesToBase64(f.bytes);
  }
  return { owner, repo, branch, path: args.path, size: f.size, sha: f.sha, encoding, content };
}

async function doWriteFile(env, args) {
  const owner = ownerOf(env, args);
  const repo = args && args.repo;
  if (!repo) throw new BridgeError(400, "repo is required.");
  if (!args.path) throw new BridgeError(400, "path is required.");
  const perr = checkPath(args.path);
  if (perr) throw new BridgeError(400, perr);
  const bytes =
    args.encoding === "base64" ? base64ToBytes(args.content || "") : utf8ToBytes(args.content || "");
  if (bytes.length > MAX_FILE_BYTES) {
    throw new BridgeError(400, "File is too big (max 5 MB): " + args.path);
  }
  const branch = await resolveBranch(env, owner, repo, args.branch);
  let sha = null;
  let action = "created";
  try {
    const cur = await readFileRaw(env, owner, repo, branch, args.path);
    sha = cur.sha;
    action = "updated";
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const body = {
    message:
      args.message ||
      (action === "created" ? "Add " : "Update ") + args.path + " (via GitHub Bridge)",
    content: bytesToBase64(bytes),
    branch,
  };
  if (sha) body.sha = sha;
  const r = await gh(env, "PUT", "/repos/" + owner + "/" + repo + "/contents/" + encPath(args.path), body);
  return {
    owner,
    repo,
    branch,
    path: args.path,
    action,
    commit_sha: r.commit && r.commit.sha,
    commit_url: r.commit && r.commit.html_url,
  };
}

async function doDeleteFile(env, args) {
  const owner = ownerOf(env, args);
  const repo = args && args.repo;
  if (!repo) throw new BridgeError(400, "repo is required.");
  if (!args.path) throw new BridgeError(400, "path is required.");
  const perr = checkPath(args.path);
  if (perr) throw new BridgeError(400, perr);
  const branch = await resolveBranch(env, owner, repo, args.branch);
  const cur = await readFileRaw(env, owner, repo, branch, args.path);
  const r = await gh(env, "DELETE", "/repos/" + owner + "/" + repo + "/contents/" + encPath(args.path), {
    message: args.message || "Delete " + args.path + " (via GitHub Bridge)",
    sha: cur.sha,
    branch,
  });
  return {
    owner,
    repo,
    branch,
    path: args.path,
    deleted: true,
    commit_sha: r.commit && r.commit.sha,
    commit_url: r.commit && r.commit.html_url,
  };
}

// The key feature: smart bundle sync with stale-file deletion.
// Manifest (.bridge/manifest.json) remembers the files from the last sync.
// Files in the manifest but missing from the new bundle are deleted.
// Unchanged files are NOT rewritten. Everything lands in ONE commit.
async function doSync(env, args) {
  const owner = ownerOf(env, args);
  const repo = args && args.repo;
  if (!repo) throw new BridgeError(400, "repo is required.");
  const files = args && args.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new BridgeError(400, "files is empty. Send at least one file.");
  }
  if (files.length > MAX_SYNC_FILES) {
    throw new BridgeError(400, "Too many files in one sync (max 50). Split the bundle into two syncs.");
  }
  const deleteStale = !args || args.delete_stale !== false;
  const dryRun = !!(args && args.dry_run);

  const prepared = [];
  const seen = {};
  let total = 0;
  for (const f of files) {
    if (!f || typeof f.path !== "string") throw new BridgeError(400, "Every file needs a path.");
    const perr = checkPath(f.path);
    if (perr) throw new BridgeError(400, perr);
    if (seen[f.path]) throw new BridgeError(400, "Duplicate path in bundle: " + f.path);
    seen[f.path] = true;
    const bytes =
      f.encoding === "base64" ? base64ToBytes(f.content || "") : utf8ToBytes(f.content || "");
    if (bytes.length > MAX_FILE_BYTES) {
      throw new BridgeError(400, "File is too big (max 5 MB): " + f.path);
    }
    total += bytes.length;
    prepared.push({ path: f.path, bytes });
  }
  if (total > MAX_SYNC_BYTES) {
    throw new BridgeError(400, "Bundle is too big in total (max 20 MB). Split it into two syncs.");
  }

  const branch = await resolveBranch(env, owner, repo, args.branch);
  const parentCommit = await getBranchCommit(env, owner, repo, branch);
  let tree = { files: {}, sha: null };
  if (parentCommit) tree = await getTree(env, owner, repo, branch);
  const managed = await getManifest(env, owner, repo, branch);
  const incoming = prepared.map((p) => p.path);

  const added = [];
  const updated = [];
  const unchanged = [];
  for (const p of prepared) {
    const cur = tree.files[p.path];
    if (!cur) {
      added.push(p.path);
      continue;
    }
    const sha = await gitBlobSha(p.bytes);
    if (sha === cur.sha) unchanged.push(p.path);
    else updated.push(p.path);
  }
  // Only delete files that are really in the repo now (a stale manifest
  // entry for a file deleted by hand elsewhere is simply ignored).
  const deleted = deleteStale ? managed.filter((p) => !seen[p] && tree.files[p]) : [];

  const result = {
    owner,
    repo,
    branch,
    added,
    updated,
    deleted,
    unchanged,
    commit_sha: null,
    commit_url: null,
    dry_run: dryRun,
  };
  if (dryRun) return result;
  if (added.length === 0 && updated.length === 0 && deleted.length === 0) {
    result.message = "Nothing changed — no commit made.";
    return result;
  }

  // New manifest = the files in this bundle (sorted). It is itself part
  // of the same commit, so the manifest and the files never drift apart.
  const manifestObj = { version: 1, updated: new Date().toISOString(), files: [...incoming].sort() };
  const manifestBytes = utf8ToBytes(JSON.stringify(manifestObj, null, 2) + "\n");
  let manifestChanged = true;
  try {
    const oldM = await readFileRaw(env, owner, repo, branch, MANIFEST_PATH);
    manifestChanged = bytesToBase64(oldM.bytes) !== bytesToBase64(manifestBytes);
  } catch (e) {
    manifestChanged = true;
  }

  const treeEntries = [];
  for (const p of prepared) {
    if (added.includes(p.path) || updated.includes(p.path)) {
      const b = await gh(env, "POST", "/repos/" + owner + "/" + repo + "/git/blobs", {
        content: bytesToBase64(p.bytes),
        encoding: "base64",
      });
      treeEntries.push({ path: p.path, mode: "100644", type: "blob", sha: b.sha });
    }
  }
  for (const p of deleted) {
    treeEntries.push({ path: p, mode: "100644", type: "blob", sha: null });
  }
  if (manifestChanged) {
    const mb = await gh(env, "POST", "/repos/" + owner + "/" + repo + "/git/blobs", {
      content: bytesToBase64(manifestBytes),
      encoding: "base64",
    });
    treeEntries.push({ path: MANIFEST_PATH, mode: "100644", type: "blob", sha: mb.sha });
  }

  const treeBody = { tree: treeEntries };
  if (tree.sha) treeBody.base_tree = tree.sha;
  const newTree = await gh(env, "POST", "/repos/" + owner + "/" + repo + "/git/trees", treeBody);
  const commitBody = {
    message:
      args.message ||
      "Sync bundle via GitHub Bridge (" +
        added.length +
        " added, " +
        updated.length +
        " updated, " +
        deleted.length +
        " deleted)",
    tree: newTree.sha,
  };
  if (parentCommit) commitBody.parents = [parentCommit];
  const commit = await gh(env, "POST", "/repos/" + owner + "/" + repo + "/git/commits", commitBody);
  if (parentCommit) {
    await gh(env, "PATCH", "/repos/" + owner + "/" + repo + "/git/refs/heads/" + encodeURIComponent(branch), {
      sha: commit.sha,
    });
  } else {
    // Empty repo: create the branch ref for the first time.
    await gh(env, "POST", "/repos/" + owner + "/" + repo + "/git/refs", {
      ref: "refs/heads/" + branch,
      sha: commit.sha,
    });
  }
  result.commit_sha = commit.sha;
  result.commit_url = "https://github.com/" + owner + "/" + repo + "/commit/" + commit.sha;
  return result;
}

async function callTool(env, name, args) {
  const a = args || {};
  switch (name) {
    case "list_files":
      return await doListFiles(env, a);
    case "read_file":
      return await doReadFile(env, a);
    case "write_file":
      return await doWriteFile(env, a);
    case "delete_file":
      return await doDeleteFile(env, a);
    case "sync_bundle":
      return await doSync(env, a);
    default:
      throw new BridgeError(400, "Unknown tool: " + name);
  }
}

// ---------------------------------------------------------------- MCP (BONUS)

const TOOLS = [
  {
    name: "list_files",
    description:
      "List all files in a GitHub repo (recursive). Use this first to see what is in the repo before reading or editing.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "GitHub owner. Omit to use the bridge default owner." },
        repo: { type: "string", description: "Repository name, e.g. Immigration" },
        branch: { type: "string", description: "Branch. Omit for the repo default branch." },
      },
      required: ["repo"],
    },
  },
  {
    name: "read_file",
    description: "Read one file from a GitHub repo. Always read a file before editing it. Returns text, or base64 for binary files.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },
        path: { type: "string", description: "File path in the repo, e.g. index.html or assets/style.css" },
      },
      required: ["repo", "path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite ONE file in a GitHub repo (one commit). For a whole set of files use sync_bundle instead.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },
        path: { type: "string", description: "File path in the repo" },
        content: { type: "string", description: "Full new file content. Use encoding base64 for binary files." },
        encoding: { type: "string", enum: ["utf8", "base64"], description: "Default utf8." },
        message: { type: "string", description: "Commit message. Optional." },
      },
      required: ["repo", "path", "content"],
    },
  },
  {
    name: "delete_file",
    description: "Delete ONE file from a GitHub repo (one commit).",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },
        path: { type: "string", description: "File path in the repo" },
        message: { type: "string", description: "Commit message. Optional." },
      },
      required: ["repo", "path"],
    },
  },
  {
    name: "sync_bundle",
    description:
      "Publish a WHOLE set of files to a GitHub repo in ONE commit. Files in the bundle are added or updated; files that were in the previous bundle but are missing from this one are DELETED (stale-file cleanup via the .bridge/manifest.json manifest); unchanged files are left alone. This is the tool to use after building or rebuilding a site/app. Set delete_stale false to keep old files. Set dry_run true to preview what would change without committing.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },
        files: {
          type: "array",
          description: "Files to publish. Max 50 files, 5 MB each, 20 MB total.",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              encoding: { type: "string", enum: ["utf8", "base64"] },
            },
            required: ["path", "content"],
          },
        },
        delete_stale: { type: "boolean", description: "Delete files from the last bundle that are missing now. Default true." },
        dry_run: { type: "boolean", description: "Preview only — no commit. Default false." },
        message: { type: "string", description: "Commit message. Optional." },
      },
      required: ["repo", "files"],
    },
  },
];

const MCP_INSTRUCTIONS =
  "You edit GitHub repos through this bridge. Default owner is the bridge owner's account. " +
  "Use list_files to see the repo, read_file before editing anything, write_file for single files, " +
  "and sync_bundle to publish a whole set of files at once — it deletes files that were in the last " +
  "bundle but are missing now, so always send the COMPLETE file set, not only the changed files. " +
  "Never invent file contents; always read first.";

function jsonHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, X-Bridge-Key, Content-Type, Mcp-Session-Id, MCP-Protocol-Version",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  };
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: jsonHeaders() });
}

function rpcResult(id, result) {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

function rpcError(id, code, message, httpStatus) {
  return jsonResponse({ jsonrpc: "2.0", id, error: { code, message } }, httpStatus || 200);
}

// MCP Streamable HTTP, stateless: one POST per JSON-RPC message, no
// session id required. Notifications (no id) get a 202 with empty body.
async function handleMcp(request, env) {
  const authErr = requireAuth(request, env);
  if (authErr) return rpcError(null, -32001, authErr, 401);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return rpcError(null, -32700, "Parse error: body is not valid JSON.", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return rpcError(null, -32600, "Invalid request: expected one JSON-RPC object.", 400);
  }
  if (body.id === undefined || body.id === null) {
    // Notification (e.g. notifications/initialized) — accept silently.
    return new Response(null, { status: 202, headers: jsonHeaders() });
  }
  const id = body.id;
  const method = body.method;
  const params = body.params || {};
  try {
    if (method === "initialize") {
      const pv = params.protocolVersion;
      const negotiated = SUPPORTED_VERSIONS.includes(pv) ? pv : "2025-11-25";
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: "github-bridge", version: VERSION },
        instructions: MCP_INSTRUCTIONS,
      });
    }
    if (method === "ping") return rpcResult(id, {});
    if (method === "tools/list") return rpcResult(id, { tools: TOOLS });
    if (method === "tools/call") {
      const name = params.name;
      const args = params.arguments || {};
      if (!name) return rpcError(id, -32602, "tools/call needs a tool name.");
      try {
        const result = await callTool(env, name, args);
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
      } catch (e) {
        const msg = e instanceof BridgeError ? e.message : "Tool failed: " + (e && e.message ? e.message : e);
        return rpcResult(id, { content: [{ type: "text", text: "Error: " + msg }], isError: true });
      }
    }
    return rpcError(id, -32601, "Method not found: " + method);
  } catch (e) {
    const msg = e instanceof BridgeError ? e.message : e && e.message ? e.message : "Request failed.";
    return rpcError(id, -32600, msg);
  }
}

// ---------------------------------------------------------------- REST API (BONUS)

async function handleApi(request, env, url) {
  const path = url.pathname;
  if (path === "/api/health") {
    return jsonResponse({ ok: true, service: "github-bridge", version: VERSION });
  }
  const authErr = requireAuth(request, env);
  if (authErr) return jsonResponse({ error: authErr }, 401);
  try {
    if (path === "/api/tree" && request.method === "GET") {
      const r = await doListFiles(env, {
        owner: url.searchParams.get("owner") || undefined,
        repo: url.searchParams.get("repo"),
        branch: url.searchParams.get("branch") || undefined,
      });
      return jsonResponse(r);
    }
    if (path === "/api/file" && request.method === "GET") {
      const r = await doReadFile(env, {
        owner: url.searchParams.get("owner") || undefined,
        repo: url.searchParams.get("repo"),
        branch: url.searchParams.get("branch") || undefined,
        path: url.searchParams.get("path"),
      });
      return jsonResponse(r);
    }
    if (path === "/api/file" && request.method === "PUT") {
      const body = await request.json();
      const r = await doWriteFile(env, body);
      return jsonResponse(r);
    }
    if (path === "/api/file" && request.method === "DELETE") {
      let body = {};
      try {
        body = await request.json();
      } catch (e) {
        body = {};
      }
      const r = await doDeleteFile(env, {
        owner: body.owner || url.searchParams.get("owner") || undefined,
        repo: body.repo || url.searchParams.get("repo"),
        branch: body.branch || url.searchParams.get("branch") || undefined,
        path: body.path || url.searchParams.get("path"),
        message: body.message || url.searchParams.get("message") || undefined,
      });
      return jsonResponse(r);
    }
    if (path === "/api/sync" && request.method === "POST") {
      const body = await request.json();
      const r = await doSync(env, body);
      return jsonResponse(r);
    }
    return jsonResponse({ error: "Unknown API route: " + request.method + " " + path }, 404);
  } catch (e) {
    const status = e instanceof BridgeError ? e.status : 500;
    return jsonResponse({ error: (e && e.message) || "Something went wrong." }, status);
  }
}

// ---------------------------------------------------------------- router

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: jsonHeaders() });
    }
    if (url.pathname === "/") {
      return new Response(UI_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" },
      });
    }
    if (url.pathname === "/mcp") {
      if (request.method !== "POST") return jsonResponse({ error: "Use POST /mcp." }, 405);
      return handleMcp(request, env);
    }
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }
    return jsonResponse({ error: "Not found." }, 404);
  },
};

// ---------------------------------------------------------------- Web UI (PRIMARY)
//
// The web page is the guaranteed path: no connector, no MCP, no paid bot.
// The user asks ANY bot for files, pastes the bot's JSON bundle here,
// previews, and syncs. Works fully from a phone.
// NOTE: this HTML lives inside a JS template literal, so it must not
// contain backticks or ${...} — the UI script uses string concatenation
// only, and code-fence backticks are built with String.fromCharCode(96).

const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GitHub Bridge</title>
<style>
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 12px; background: #f4f1ea; color: #222; }
h1 { font-size: 24px; margin: 4px 0; }
.sub { color: #555; margin-top: 0; }
.card { background: #fff; border: 1px solid #ddd; border-radius: 10px; padding: 14px; margin: 12px 0; }
h2 { font-size: 18px; margin: 0 0 8px; }
h3 { font-size: 15px; margin: 12px 0 4px; }
input, textarea { width: 100%; padding: 10px; font-size: 16px; border: 1px solid #bbb; border-radius: 8px; margin: 4px 0; }
textarea { font-family: monospace; }
button { padding: 12px 16px; font-size: 16px; border: 0; border-radius: 8px; background: #14532d; color: #fff; margin: 4px 4px 4px 0; }
button:active { opacity: .8; }
.file { padding: 10px; border-bottom: 1px solid #eee; font-family: monospace; font-size: 14px; cursor: pointer; }
.size { color: #888; font-size: 12px; }
#status { position: sticky; bottom: 0; background: #eaf6ec; border: 1px solid #2a7; border-radius: 8px; padding: 12px; margin-top: 12px; }
pre { white-space: pre-wrap; word-wrap: break-word; background: #f6f6f6; padding: 10px; border-radius: 8px; font-size: 13px; }
label { display: block; font-size: 14px; color: #555; margin-top: 6px; }
</style>
</head>
<body>
<h1>GitHub Bridge</h1>
<p class="sub">Edit any repo from your phone — no app, no computer, no paid plan. Free forever.</p>

<div class="card">
<h2>1. Your bridge key</h2>
<p>Paste the BRIDGE_KEY you set in Cloudflare. It stays on this phone only.</p>
<input type="password" id="key" placeholder="Bridge key" autocomplete="off">
<button onclick="saveKey()">Save key</button>
</div>

<div class="card">
<h2>2. Repo</h2>
<label>Owner</label>
<input id="owner" value="arshadldbr">
<label>Repo</label>
<input id="repo" placeholder="e.g. Immigration">
<label>Branch (leave empty = default branch)</label>
<input id="branch" placeholder="">
<button onclick="loadTree()">Load files</button>
</div>

<div class="card">
<h2>3. Files</h2>
<div id="tree">No files loaded yet.</div>
<label>File path</label>
<input id="filepath" placeholder="e.g. index.html">
<textarea id="editor" rows="14" placeholder="File content..."></textarea>
<button onclick="saveFile()">Save file</button>
<button onclick="deleteFile()">Delete file</button>
<button onclick="newFile()">New file</button>
</div>

<div class="card">
<h2>4. Bundle sync — from ANY bot</h2>
<p>Ask any bot for your files, then bring them here. Two ways:</p>
<h3>A. Pick files or a folder</h3>
<input type="file" id="pickFiles" multiple>
<input type="file" id="pickFolder" webkitdirectory>
<button onclick="addPicked()">Add picked files to bundle</button>
<h3>B. Paste a JSON bundle</h3>
<p>Paste the JSON the bot gave you. If it came inside a code block, paste the whole block — fences are removed automatically.</p>
<textarea id="pasteJson" rows="6" placeholder='{"files":[{"path":"index.html","content":"..."}]}'></textarea>
<button onclick="parsePaste()">Add pasted bundle</button>
<h3>Bundle (<span id="bundleCount">0</span> files)</h3>
<div id="bundleList">Bundle is empty.</div>
<button onclick="previewSync()">Preview sync</button>
<div id="preview"></div>
<button onclick="confirmSync()" id="confirmBtn" style="display:none">Confirm sync — write to repo</button>
</div>

<div class="card">
<h2>Copy this prompt — send it to ANY bot</h2>
<p>Paste this to ChatGPT, DeepSeek, Claude or any bot, then paste its answer back in section 4B above.</p>
<pre id="promptText"></pre>
<button onclick="copyPrompt()">Copy prompt</button>
</div>

<div class="card">
<h2>How it works</h2>
<ol>
<li>Ask any bot to build or change your site or app.</li>
<li>Tell it to output ALL files as ONE JSON bundle (use the prompt above).</li>
<li>Copy the bot answer, paste it in 4B, press Preview, then Confirm sync.</li>
<li>Old files from the last bundle that are missing now are DELETED automatically. Unchanged files are left alone. Everything lands in one commit.</li>
</ol>
<p>Free forever: Cloudflare Workers free tier + GitHub free. No card, no paid bot needed — the free versions of the bots are enough, you only copy their output.</p>
</div>

<div id="status">Ready.</div>

<script>
var BT = String.fromCharCode(96);
var PROMPT =
'Please output ALL the files for this project as ONE JSON code block, and nothing else outside it. Use this exact format:\n\n' +
BT + BT + BT + 'json\n' +
'{"files":[{"path":"index.html","content":"...full file content here..."},{"path":"assets/style.css","content":"..."}]}\n' +
BT + BT + BT + '\n\n' +
'Rules:\n' +
'1. Include EVERY file, with its COMPLETE content. Do not shorten, summarise or use placeholders.\n' +
'2. Paths are relative to the project root, using / between folders, for example assets/style.css\n' +
'3. If a file is an image or other binary file, set encoding to base64 and put the base64 data in content.\n' +
'4. Do not leave out any file that belongs in the project. Files that were in the last bundle but are missing from your bundle will be DELETED from the repo.\n' +
'5. Do not put any explanation outside the code block.';

var bundle = [];

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function status(msg, ok) { var el = $('status'); el.textContent = msg; el.style.background = ok === false ? '#fde8e8' : '#eaf6ec'; el.style.borderColor = ok === false ? '#d33' : '#2a7'; }
function key() { return $('key').value.trim(); }
function repoArgs() { return { owner: $('owner').value.trim(), repo: $('repo').value.trim(), branch: $('branch').value.trim() || undefined }; }

function api(method, path, body) {
  var opts = { method: method, headers: { 'Content-Type': 'application/json', 'X-Bridge-Key': key() } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(path, opts).then(function(res) {
    return res.json().then(function(data) {
      if (!res.ok) throw new Error((data && data.error) || ('Request failed: ' + res.status));
      return data;
    });
  });
}

function saveKey() {
  if (!key()) { status('Enter your bridge key first.', false); return; }
  localStorage.setItem('ghbridge_key', key());
  status('Key saved on this phone.');
}

function loadTree() {
  var a = repoArgs();
  if (!a.repo) { status('Enter a repo name first.', false); return; }
  if (!key()) { status('Enter your bridge key first.', false); return; }
  localStorage.setItem('ghbridge_owner', a.owner);
  localStorage.setItem('ghbridge_repo', a.repo);
  localStorage.setItem('ghbridge_branch', a.branch || '');
  status('Loading files...');
  var q = '/api/tree?owner=' + encodeURIComponent(a.owner) + '&repo=' + encodeURIComponent(a.repo) + (a.branch ? '&branch=' + encodeURIComponent(a.branch) : '');
  api('GET', q).then(function(data) {
    var html = '';
    var shown = 0;
    for (var i = 0; i < data.files.length; i++) {
      var f = data.files[i];
      if (f.path.indexOf('.bridge/') === 0) continue;
      shown++;
      html += '<div class="file" data-path="' + esc(f.path) + '">' + esc(f.path) + ' <span class="size">' + f.size + ' bytes</span></div>';
    }
    if (shown === 0) html = 'Repo is empty.';
    $('tree').innerHTML = html;
    status('Loaded ' + data.count + ' files from ' + a.owner + '/' + a.repo + ' (' + data.branch + ').');
  }).catch(function(e) { status(e.message, false); });
}

function openFile(path) {
  var a = repoArgs();
  status('Opening ' + path + '...');
  var q = '/api/file?owner=' + encodeURIComponent(a.owner) + '&repo=' + encodeURIComponent(a.repo) + '&branch=' + encodeURIComponent(a.branch || '') + '&path=' + encodeURIComponent(path);
  api('GET', q).then(function(data) {
    $('filepath').value = data.path;
    if (data.encoding === 'base64') { $('editor').value = '[Binary file, ' + data.size + ' bytes. Change it through a bundle sync instead.]'; }
    else { $('editor').value = data.content; }
    status('Opened ' + path + '.');
    window.scrollTo(0, $('editor').offsetTop - 10);
  }).catch(function(e) { status(e.message, false); });
}

function saveFile() {
  var a = repoArgs();
  var path = $('filepath').value.trim();
  if (!path) { status('Enter a file path first.', false); return; }
  if (!key()) { status('Enter your bridge key first.', false); return; }
  status('Saving ' + path + '...');
  api('PUT', '/api/file', { owner: a.owner, repo: a.repo, branch: a.branch, path: path, content: $('editor').value }).then(function(data) {
    status('Saved ' + path + ' (' + data.action + ').');
    loadTree();
  }).catch(function(e) { status(e.message, false); });
}

function deleteFile() {
  var a = repoArgs();
  var path = $('filepath').value.trim();
  if (!path) { status('Enter a file path first.', false); return; }
  if (!confirm('Delete ' + path + ' from the repo?')) return;
  status('Deleting ' + path + '...');
  api('DELETE', '/api/file', { owner: a.owner, repo: a.repo, branch: a.branch, path: path }).then(function() {
    $('filepath').value = '';
    $('editor').value = '';
    status('Deleted ' + path + '.');
    loadTree();
  }).catch(function(e) { status(e.message, false); });
}

function newFile() { $('filepath').value = ''; $('editor').value = ''; $('filepath').focus(); }

function renderBundle() {
  $('bundleCount').textContent = bundle.length;
  if (bundle.length === 0) { $('bundleList').innerHTML = 'Bundle is empty.'; return; }
  var html = '';
  for (var i = 0; i < bundle.length; i++) {
    html += '<div class="file">' + esc(bundle[i].path) + ' <span class="size">' + bundle[i].content.length + ' chars</span> <button data-remove="' + i + '">Remove</button></div>';
  }
  $('bundleList').innerHTML = html;
}

function removeBundle(i) { bundle.splice(i, 1); renderBundle(); }

function addToBundle(path, content, encoding) {
  for (var i = 0; i < bundle.length; i++) {
    if (bundle[i].path === path) { bundle[i] = { path: path, content: content, encoding: encoding || 'utf8' }; renderBundle(); return; }
  }
  bundle.push({ path: path, content: content, encoding: encoding || 'utf8' });
  renderBundle();
}

function bytesToBase64UI(bytes) {
  var s = '';
  var CH = 0x8000;
  for (var i = 0; i < bytes.length; i += CH) { s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); }
  return btoa(s);
}

function readPicked(file) {
  var path = file.webkitRelativePath || file.name;
  return file.arrayBuffer().then(function(buf) {
    var bytes = new Uint8Array(buf);
    var text = null;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { text = null; }
    if (text !== null) addToBundle(path, text, 'utf8');
    else addToBundle(path, bytesToBase64UI(bytes), 'base64');
  });
}

function addPicked() {
  var files = [];
  var a = $('pickFiles').files;
  var b = $('pickFolder').files;
  for (var i = 0; i < a.length; i++) files.push(a[i]);
  for (var j = 0; j < b.length; j++) files.push(b[j]);
  if (files.length === 0) { status('Pick files or a folder first.', false); return; }
  status('Reading ' + files.length + ' files...');
  var done = 0;
  files.forEach(function(f) {
    readPicked(f).then(function() {
      done++;
      if (done === files.length) status(files.length + ' files added to the bundle. Press Preview sync.');
    });
  });
}

function parsePaste() {
  var raw = $('pasteJson').value.trim();
  if (!raw) { status('Paste the JSON bundle first.', false); return; }
  var fence = BT + BT + BT;
  if (raw.indexOf(fence) === 0) {
    raw = raw.slice(3);
    var nl = raw.indexOf('\n');
    if (nl >= 0) raw = raw.slice(nl + 1);
  }
  raw = raw.trim();
  if (raw.slice(-3) === fence) raw = raw.slice(0, -3).trim();
  var data;
  try { data = JSON.parse(raw); } catch (e) { status('That is not valid JSON: ' + e.message, false); return; }
  var list = Array.isArray(data) ? data : data.files;
  if (!Array.isArray(list) || list.length === 0) { status('No files found. Expected {"files":[{"path":"...","content":"..."}]}', false); return; }
  var added = 0;
  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    if (f && typeof f.path === 'string' && typeof f.content === 'string') { addToBundle(f.path, f.content, f.encoding || 'utf8'); added++; }
  }
  if (added === 0) { status('No usable files in the bundle.', false); return; }
  status(added + ' files added to the bundle. Press Preview sync.');
  $('pasteJson').value = '';
}

function syncBody(dry) {
  var a = repoArgs();
  return { owner: a.owner, repo: a.repo, branch: a.branch, files: bundle, delete_stale: true, dry_run: dry };
}

function previewSync() {
  var a = repoArgs();
  if (!a.repo) { status('Enter a repo name first.', false); return; }
  if (!key()) { status('Enter your bridge key first.', false); return; }
  if (bundle.length === 0) { status('Bundle is empty — add files first.', false); return; }
  status('Checking what would change...');
  api('POST', '/api/sync', syncBody(true)).then(function(data) {
    var html = '<p><b>Would add:</b> ' + (data.added.length ? esc(data.added.join(', ')) : 'none') + '</p>' +
      '<p><b>Would update:</b> ' + (data.updated.length ? esc(data.updated.join(', ')) : 'none') + '</p>' +
      '<p><b>Would delete (stale):</b> ' + (data.deleted.length ? esc(data.deleted.join(', ')) : 'none') + '</p>' +
      '<p><b>Unchanged:</b> ' + (data.unchanged.length ? esc(data.unchanged.join(', ')) : 'none') + '</p>';
    $('preview').innerHTML = html;
    $('confirmBtn').style.display = 'inline-block';
    status('Preview ready. Check the lists, then press Confirm sync.');
  }).catch(function(e) { status(e.message, false); });
}

function confirmSync() {
  status('Syncing to repo...');
  api('POST', '/api/sync', syncBody(false)).then(function(data) {
    var html = '<p>Done. Added ' + data.added.length + ', updated ' + data.updated.length + ', deleted ' + data.deleted.length + ', unchanged ' + data.unchanged.length + '.</p>';
    if (data.commit_url) html += '<p><a href="' + data.commit_url + '" target="_blank">See the commit on GitHub</a></p>';
    else html += '<p>No commit was needed — nothing changed.</p>';
    $('preview').innerHTML = html;
    $('confirmBtn').style.display = 'none';
    bundle = [];
    renderBundle();
    status('Sync complete.');
    loadTree();
  }).catch(function(e) { status(e.message, false); });
}

function copyPrompt() {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(PROMPT).then(function() { status('Prompt copied. Paste it to any bot.'); }).catch(function() { status('Copy did not work — long-press the text above and copy it by hand.', false); });
  } else { status('Long-press the text above and copy it by hand.', false); }
}

$('tree').addEventListener('click', function(ev) {
  var t = ev.target;
  while (t && !t.getAttribute('data-path')) t = t.parentElement;
  if (t) openFile(t.getAttribute('data-path'));
});
$('bundleList').addEventListener('click', function(ev) {
  var t = ev.target;
  if (t && t.getAttribute('data-remove') !== null) removeBundle(parseInt(t.getAttribute('data-remove'), 10));
});

window.onload = function() {
  $('key').value = localStorage.getItem('ghbridge_key') || '';
  $('owner').value = localStorage.getItem('ghbridge_owner') || 'arshadldbr';
  $('repo').value = localStorage.getItem('ghbridge_repo') || '';
  $('branch').value = localStorage.getItem('ghbridge_branch') || '';
  $('promptText').textContent = PROMPT;
};
</script>
</body>
</html>`;
