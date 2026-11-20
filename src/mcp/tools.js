/**
 * Every MCP tool, as data: what Claude sees (name, description, inputs, safety
 * markings) and how a call becomes a CLI command line.
 *
 * One tool per CLI action, not one "run anything" tool, so the client can tell
 * a listing from a production change and ask before the second. The markings:
 *
 * - READ: changes nothing anywhere. Clients may run these without asking.
 * - WRITE: changes something, on the test side or in the developer's own files,
 *   that can be changed back.
 * - DESTRUCTIVE: reaches production, deletes, revokes, or mints a credential.
 *
 * MCP treats a tool that is not read-only as destructive unless it says
 * otherwise, so WRITE sets `destructiveHint: false` explicitly.
 *
 * `tests/mcpDrift.test.js` fails when a CLI command has neither a tool here nor
 * an entry in EXCLUDED.
 */

import { isAbsolute } from "node:path";
import { z } from "zod";

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

const MIN = 60_000;

/** CLI commands deliberately without a tool, and why. */
export const EXCLUDED = {
  "vfs mount": "long-running: keeps a folder in sync until stopped",
  "vfs cd": "shared working-directory state across calls; every tool takes absolute paths instead",
  "vfs pwd": "shared working-directory state across calls",
  "vfs use-app": "deprecated: prints a notice and does nothing",
  "vfs app": "deprecated: prints a notice and does nothing",
  eject: "runs npx tsx on a local agent file with raw terminal output",
  "vectors query": "needs an app key as input (--key or MUHKOO_APP_KEY), and secrets are never taken as tool input",
};

/**
 * The name of the first argument that looks like a flag (starts with "-"), or
 * null. The CLI's parser reads any "--x" in argv as an option wherever it
 * appears, so a value like appId "--base" followed by a URL would redirect the
 * signed-in session to another host. No legitimate value here starts with "-":
 * Muhkoo and local paths start with "/".
 */
export function flagLikeArgument(args) {
  for (const [key, value] of Object.entries(args ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    if (values.some((v) => typeof v === "string" && v.startsWith("-"))) return key;
  }
  return null;
}

// ── inputs ─────────────────────────────────────────────────────────────────

/** A path on the developer's computer. Always absolute: the server's own cwd is arbitrary. */
export function absolutePath(field) {
  return z
    .string()
    .refine((p) => isAbsolute(p) && !p.startsWith("~"), { message: `${field} must be an absolute path` });
}

const appId = z.string().min(1).describe("The app id (from apps_ls)");
const vfsPath = (what = "Path in your Muhkoo filesystem") =>
  z.string().startsWith("/", { message: "filesystem paths start with /" }).describe(`${what}, absolute, e.g. /apps/my-app`);
const project = z.string().min(1).describe("The project's slug: the folder name under /apps in your filesystem");
const space = z.string().min(1).describe("Space id, or #channel name");

// ── argv helpers ───────────────────────────────────────────────────────────

const opt = (flag, value) => (value === undefined || value === null || value === "" ? [] : [flag, String(value)]);
const bool = (flag, on) => (on ? [flag] : []);
const list = (flag, values) => (values?.length ? [flag, values.join(",")] : []);
const pos = (value) => (value === undefined || value === null || value === "" ? [] : [String(value)]);

// ── the tools ──────────────────────────────────────────────────────────────

/**
 * @typedef {{ name: string, title: string, description: string, input: Record<string, import("zod").ZodTypeAny>,
 *   annotations: Record<string, boolean>, timeoutMs?: number, argv: (a: any) => string[], cwd?: (a: any) => string | undefined }} Tool
 */

/** @type {Tool[]} */
export const TOOLS = [
  // Account
  {
    name: "login",
    title: "Sign in",
    description:
      "Sign in to Muhkoo in the browser (password, passkey or Google). Opens a sign-in page and waits up to 5 minutes. Also pairs this computer, which the filesystem tools need. Use when another tool says you are not signed in. `base` is only for Muhkoo staff working against staging.",
    input: { base: z.enum(["prod", "staging"]).optional().describe("Platform to sign in to: prod (default) or staging") },
    annotations: WRITE,
    timeoutMs: 5 * MIN,
    argv: (a) => ["login", "--web", ...opt("--base", a.base)],
  },
  {
    name: "logout",
    title: "Sign out",
    description: "Forget the stored Muhkoo session on this computer.",
    input: {},
    annotations: WRITE,
    argv: () => ["logout"],
  },
  {
    name: "whoami",
    title: "Who am I",
    description: "Show the signed-in developer and which platform (production or staging) the tools act on. A good first call.",
    input: {},
    annotations: READ,
    argv: () => ["whoami"],
  },
  {
    name: "devices_ls",
    title: "List paired computers",
    description: "List the computers paired to your account (they can open your filesystem without a password).",
    input: {},
    annotations: READ,
    argv: () => ["devices", "ls"],
  },
  {
    name: "devices_rm",
    title: "Unpair a computer",
    description: "Withdraw a paired computer's access to your account.",
    input: { factorId: z.string().min(1).describe("From devices_ls") },
    annotations: DESTRUCTIVE,
    argv: (a) => ["devices", "rm", a.factorId],
  },

  // Apps, keys, tokens
  {
    name: "apps_ls",
    title: "List apps",
    description: "List your Muhkoo apps with their ids and slugs.",
    input: {},
    annotations: READ,
    argv: () => ["apps", "ls"],
  },
  {
    name: "apps_get",
    title: "Get an app",
    description: "Show one app's details.",
    input: { appId },
    annotations: READ,
    argv: (a) => ["apps", "get", a.appId],
  },
  {
    name: "apps_create",
    title: "Create an app",
    description:
      "Create a new app. Its hosting address is https://<slug>.apps.muhkoo.dev. The publishable (pk) keys are returned; the secret (sk) keys are saved to a private file and only its path is returned. For a full backend (tables, functions, agents) from a spec, use provision instead.",
    input: {
      slug: z.string().min(1).describe("Lowercase name, used in the app's address; check it with apps_slug first"),
      email: z.string().optional().describe("Billing email, needed the first time a developer account creates an app"),
      origins: z.array(z.string()).optional().describe("Allowed browser origins (CORS)"),
    },
    annotations: WRITE,
    argv: (a) => ["apps", "create", "--slug", a.slug, ...opt("--email", a.email), ...list("--origins", a.origins)],
  },
  {
    name: "apps_slug",
    title: "Check a slug",
    description: "Check whether an app slug is still available.",
    input: { slug: z.string().min(1) },
    annotations: READ,
    argv: (a) => ["apps", "slug", a.slug],
  },
  {
    name: "apps_rm",
    title: "Delete an app",
    description: "Delete an app and revoke all its keys. Cannot be undone.",
    input: { appId },
    annotations: DESTRUCTIVE,
    argv: (a) => ["apps", "rm", a.appId],
  },
  {
    name: "keys_rotate",
    title: "Rotate app keys",
    description:
      "Replace all four of an app's keys; the old ones stop working at once. New secret keys are saved to the project's .muhkoo-app.json when projectDir has one, otherwise to a private file; only the path is returned.",
    input: { appId, projectDir: absolutePath("projectDir").optional().describe("The app's project folder on this computer") },
    annotations: DESTRUCTIVE,
    argv: (a) => ["keys", "rotate", a.appId],
  },
  {
    name: "tokens_ls",
    title: "List access tokens",
    description: "List an app's scoped access tokens (not their values).",
    input: { appId },
    annotations: READ,
    argv: (a) => ["tokens", "ls", a.appId],
  },
  {
    name: "tokens_create",
    title: "Create an access token",
    description:
      "Mint a scoped, expiring access token for servers and scripts. The token is saved to a private file and only its path is returned. Needs a paid plan.",
    input: {
      appId,
      scopes: z
        .array(z.string())
        .optional()
        .describe("e.g. db:read, db:write, kv:read, kv:write, storage:read, storage:write, messages:read, messages:write, functions:invoke, ai:infer, vectors:read, vectors:write"),
      env: z.enum(["test", "live"]).optional(),
      expiresInDays: z.number().int().positive().optional(),
      label: z.string().optional(),
    },
    annotations: DESTRUCTIVE,
    argv: (a) => [
      "tokens", "create", a.appId,
      ...list("--scopes", a.scopes), ...opt("--env", a.env), ...opt("--expires-in", a.expiresInDays), ...opt("--label", a.label),
    ],
  },
  {
    name: "tokens_revoke",
    title: "Revoke an access token",
    description: "Revoke an access token; anything using it stops working.",
    input: { appId, keyId: z.string().min(1).describe("From tokens_ls") },
    annotations: DESTRUCTIVE,
    argv: (a) => ["tokens", "revoke", a.appId, a.keyId],
  },

  // Backend
  {
    name: "provision",
    title: "Provision a backend",
    description:
      "Create or update an app's backend from a JSON spec: the app itself, database tables, vector collections, agents and functions. Writes .muhkoo-app.json (with the app's keys) into projectDir, which deploy then uses. Safe to re-run. Use dryRun to preview.",
    input: {
      spec: absolutePath("spec").describe("The spec file, e.g. /Users/me/my-app/muhkoo.json"),
      projectDir: absolutePath("projectDir").describe("The app's project folder; .muhkoo-app.json is written here"),
      dryRun: z.boolean().optional(),
      enable: z.boolean().optional().describe("Second step: enable the spec's agents and functions on their channels, once the app has run"),
    },
    // It (re)deploys the spec's functions, which go live at once, and with
    // enable switches agents and functions on in live channels.
    annotations: DESTRUCTIVE,
    timeoutMs: 10 * MIN,
    argv: (a) => ["provision", "--spec", a.spec, ...bool("--dry-run", a.dryRun), ...bool("--enable", a.enable)],
    cwd: (a) => a.projectDir,
  },
  {
    name: "tables_ls",
    title: "List tables",
    description: "List an app's database tables.",
    input: { appId },
    annotations: READ,
    argv: (a) => ["tables", "ls", a.appId],
  },
  {
    name: "tables_get",
    title: "Get a table",
    description: "Show a table's schema.",
    input: { appId, table: z.string().min(1) },
    annotations: READ,
    argv: (a) => ["tables", "get", a.appId, a.table],
  },
  {
    name: "tables_rm",
    title: "Delete a table",
    description: "Delete a table and its data. Cannot be undone.",
    input: { appId, table: z.string().min(1) },
    annotations: DESTRUCTIVE,
    argv: (a) => ["tables", "rm", a.appId, a.table],
  },
  {
    name: "vectors_ls",
    title: "List vector collections",
    description: "List an app's vector search collections.",
    input: { appId },
    annotations: READ,
    argv: (a) => ["vectors", "ls", a.appId],
  },
  {
    name: "vectors_get",
    title: "Get a vector collection",
    description: "Show one vector collection.",
    input: { appId, name: z.string().min(1) },
    annotations: READ,
    argv: (a) => ["vectors", "get", a.appId, a.name],
  },
  {
    name: "vectors_create",
    title: "Create a vector collection",
    description: "Create a vector search collection. mode 'text' embeds text for you with `model`; mode 'vectors' takes your own vectors of `dimensions` length.",
    input: {
      appId,
      name: z.string().min(1),
      mode: z.enum(["text", "vectors"]),
      model: z.string().optional(),
      dimensions: z.number().int().positive().optional(),
      metric: z.enum(["cosine", "euclidean", "dot-product"]).optional(),
      fields: z.array(z.string()).optional().describe("Filterable fields as name:type, e.g. category:string"),
      access: z.enum(["app", "backend"]).optional(),
      noWait: z.boolean().optional().describe("Return before the collection is ready"),
    },
    annotations: WRITE,
    argv: (a) => [
      "vectors", "create", a.appId, a.name, "--mode", a.mode,
      ...opt("--model", a.model), ...opt("--dimensions", a.dimensions), ...opt("--metric", a.metric),
      ...list("--fields", a.fields), ...opt("--access", a.access), ...bool("--no-wait", a.noWait),
    ],
  },
  {
    name: "vectors_rm",
    title: "Delete a vector collection",
    description: "Delete a vector collection and everything in it.",
    input: { appId, name: z.string().min(1) },
    annotations: DESTRUCTIVE,
    argv: (a) => ["vectors", "rm", a.appId, a.name],
  },
  {
    name: "vectors_notices",
    title: "Set vector notices",
    description: "Choose which Spaces are told when a collection changes, per environment.",
    input: {
      appId,
      name: z.string().min(1),
      env: z.enum(["live", "test"]),
      spaces: z.array(z.string()).min(1),
      default: z.string().optional(),
    },
    annotations: DESTRUCTIVE,
    argv: (a) => ["vectors", "notices", a.appId, a.name, "--env", a.env, ...list("--spaces", a.spaces), ...opt("--default", a.default)],
  },
  {
    name: "agents_ls",
    title: "List agents",
    description: "List an app's programmable agents.",
    input: { appId },
    annotations: READ,
    argv: (a) => ["agents", "ls", a.appId],
  },
  {
    name: "agents_get",
    title: "Get an agent",
    description: "Show one agent.",
    input: { appId, agentId: z.string().min(1) },
    annotations: READ,
    argv: (a) => ["agents", "get", a.appId, a.agentId],
  },
  {
    name: "agents_rm",
    title: "Delete an agent",
    description: "Delete an agent.",
    input: { appId, agentId: z.string().min(1) },
    annotations: DESTRUCTIVE,
    argv: (a) => ["agents", "rm", a.appId, a.agentId],
  },
  {
    name: "agents_enable",
    title: "Enable an agent",
    description: "Turn an agent on in a Space.",
    input: { appId, agentId: z.string().min(1), space },
    annotations: DESTRUCTIVE,
    argv: (a) => ["agents", "enable", a.appId, a.agentId, "--space", a.space],
  },
  {
    name: "agents_disable",
    title: "Disable an agent",
    description: "Turn an agent off in a Space.",
    input: { appId, agentId: z.string().min(1), space },
    annotations: DESTRUCTIVE,
    argv: (a) => ["agents", "disable", a.appId, a.agentId, "--space", a.space],
  },
  {
    name: "agents_models",
    title: "List agent models",
    description: "List the AI models agents can use.",
    input: {},
    annotations: READ,
    argv: () => ["agents", "models"],
  },
  {
    name: "functions_ls",
    title: "List functions",
    description: "List an app's serverless functions.",
    input: { appId },
    annotations: READ,
    argv: (a) => ["functions", "ls", a.appId],
  },
  {
    name: "functions_get",
    title: "Get a function",
    description: "Show one function's settings.",
    input: { appId, functionId: z.string().min(1) },
    annotations: READ,
    argv: (a) => ["functions", "get", a.appId, a.functionId],
  },
  {
    name: "functions_code",
    title: "Show function code",
    description: "Print a function's deployed source.",
    input: { appId, functionId: z.string().min(1) },
    annotations: READ,
    argv: (a) => ["functions", "code", a.appId, a.functionId],
  },
  {
    name: "functions_deploy",
    title: "Deploy a function",
    description:
      "Deploy a serverless function from a local file. It goes live as soon as it deploys. Use http for a function called directly over HTTP rather than from a channel.",
    input: {
      appId,
      name: z.string().min(1),
      file: absolutePath("file").describe("The function's source file"),
      http: z.boolean().optional(),
    },
    annotations: DESTRUCTIVE,
    argv: (a) => ["functions", "deploy", a.appId, "--name", a.name, "--file", a.file, ...bool("--http", a.http)],
  },
  {
    name: "functions_rm",
    title: "Delete a function",
    description: "Delete a function.",
    input: { appId, functionId: z.string().min(1) },
    annotations: DESTRUCTIVE,
    argv: (a) => ["functions", "rm", a.appId, a.functionId],
  },
  {
    name: "functions_enable",
    title: "Enable a function",
    description: "Run a function on a Space's messages.",
    input: { appId, functionId: z.string().min(1), space },
    annotations: DESTRUCTIVE,
    argv: (a) => ["functions", "enable", a.appId, a.functionId, "--space", a.space],
  },
  {
    name: "functions_disable",
    title: "Disable a function",
    description: "Stop a function running on a Space.",
    input: { appId, functionId: z.string().min(1), space },
    annotations: DESTRUCTIVE,
    argv: (a) => ["functions", "disable", a.appId, a.functionId, "--space", a.space],
  },

  // Filesystem
  {
    name: "vfs_ls",
    title: "List a folder",
    description: "List a folder in your Muhkoo filesystem (your encrypted files; projects live under /apps).",
    input: { path: vfsPath().optional().describe("Folder, default /") },
    annotations: READ,
    argv: (a) => ["vfs", "ls", a.path ?? "/"],
  },
  {
    name: "vfs_stat",
    title: "File details",
    description: "Size, versions and modified time of a file or folder in your filesystem.",
    input: { path: vfsPath() },
    annotations: READ,
    argv: (a) => ["vfs", "stat", a.path],
  },
  {
    name: "vfs_tree",
    title: "List everything under a folder",
    description: "Every file beneath a folder in your filesystem.",
    input: { path: vfsPath().optional().describe("Folder, default /") },
    annotations: READ,
    argv: (a) => ["vfs", "tree", a.path ?? "/"],
  },
  {
    name: "vfs_cat",
    title: "Read a file",
    description: "Read a text file from your filesystem (up to 1 MB is returned; use vfs_get for binary or larger files).",
    input: { path: vfsPath() },
    annotations: READ,
    argv: (a) => ["vfs", "cat", a.path],
  },
  {
    name: "vfs_find",
    title: "Find files",
    description: "Find files in your filesystem by glob, e.g. /apps/**/*.ts",
    input: { glob: z.string().min(1) },
    annotations: READ,
    argv: (a) => ["vfs", "find", a.glob],
  },
  {
    name: "vfs_history",
    title: "File history",
    description: "A file's earlier versions, newest first (restore one with vfs_restore).",
    input: { path: vfsPath() },
    annotations: READ,
    argv: (a) => ["vfs", "history", a.path],
  },
  {
    name: "vfs_put",
    title: "Upload a file",
    description: "Upload a file from this computer into your filesystem.",
    input: { local: absolutePath("local").describe("File on this computer"), path: vfsPath("Destination") },
    annotations: WRITE,
    argv: (a) => ["vfs", "put", a.local, a.path],
  },
  {
    name: "vfs_get",
    title: "Download a file",
    description: "Download a file from your filesystem to this computer. Replaces a file already at `local`.",
    input: { path: vfsPath(), local: absolutePath("local").describe("Where to save it on this computer") },
    annotations: DESTRUCTIVE,
    argv: (a) => ["vfs", "get", a.path, a.local],
  },
  {
    name: "vfs_mkdir",
    title: "Make a folder",
    description: "Create a folder (and any missing parents) in your filesystem.",
    input: { path: vfsPath() },
    annotations: WRITE,
    argv: (a) => ["vfs", "mkdir", a.path],
  },
  {
    name: "vfs_rm",
    title: "Delete from filesystem",
    description: "Delete a file, or a folder with recursive. A deleted file's history goes with it.",
    input: { path: vfsPath(), recursive: z.boolean().optional() },
    annotations: DESTRUCTIVE,
    argv: (a) => ["vfs", "rm", a.path, ...bool("-r", a.recursive)],
  },
  {
    name: "vfs_cp",
    title: "Copy in filesystem",
    description: "Copy a file or folder within your filesystem.",
    input: { from: vfsPath("Source"), to: vfsPath("Destination") },
    annotations: WRITE,
    argv: (a) => ["vfs", "cp", a.from, a.to],
  },
  {
    name: "vfs_mv",
    title: "Move or rename",
    description: "Move or rename a file or folder within your filesystem.",
    input: { from: vfsPath("Source"), to: vfsPath("Destination") },
    annotations: WRITE,
    argv: (a) => ["vfs", "mv", a.from, a.to],
  },
  {
    name: "vfs_restore",
    title: "Restore a version",
    description: "Put back an earlier version of a file (index from vfs_history, default 0 = the previous one).",
    input: { path: vfsPath(), index: z.number().int().min(0).optional() },
    annotations: DESTRUCTIVE,
    argv: (a) => ["vfs", "restore", a.path, ...pos(a.index)],
  },
  {
    name: "vfs_import",
    title: "Upload a project",
    description:
      "Upload whole project folders from this computer into your filesystem, once (default destination /apps/<folder name>). Upload only: never changes anything on this computer. Skips node_modules, .git, secrets and what .gitignore/.vcsignore exclude. Use dryRun to preview.",
    input: {
      dirs: z.array(absolutePath("dirs")).min(1).describe("Project folders on this computer"),
      path: vfsPath("Destination folder").optional(),
      dryRun: z.boolean().optional(),
      hidden: z.boolean().optional().describe("Also upload dot-files"),
    },
    annotations: WRITE,
    timeoutMs: 10 * MIN,
    argv: (a) => ["vfs", "import", ...a.dirs, ...opt("--path", a.path), ...bool("--dry-run", a.dryRun), ...bool("--hidden", a.hidden)],
  },
  {
    name: "vfs_ignore",
    title: "Ignore rules",
    description:
      "Show whether a local folder's ignore rules (.vcsignore/.gitignore) hold files back from syncing. To accept loosened rules, first call without acceptDigest, check what it would let through, then pass the digest it printed. draft prints a .vcsignore built from the folder's .gitignore files; write saves it.",
    input: {
      dir: absolutePath("dir"),
      acceptDigest: z.string().optional(),
      draft: z.boolean().optional(),
      write: z.boolean().optional(),
      force: z.boolean().optional().describe("With write: replace an existing .vcsignore"),
    },
    annotations: WRITE,
    argv: (a) => [
      "vfs", "ignore", a.dir,
      ...opt("--accept", a.acceptDigest), ...bool("--draft", a.draft), ...bool("--write", a.write), ...bool("--force", a.force),
    ],
  },
  {
    name: "vfs_sweep",
    title: "Reclaim storage",
    description: "Reclaim records no longer reachable in your filesystem.",
    input: { force: z.boolean().optional() },
    annotations: DESTRUCTIVE,
    argv: (a) => ["vfs", "sweep", ...bool("--force", a.force)],
  },
  {
    name: "vfs_rehome",
    title: "Move app-stored files to your account",
    description: "One-time move of files older IDE/Cloud Drive versions stored under an app onto your own account. Safe to repeat. Use dryRun to list candidates.",
    input: { dryRun: z.boolean().optional() },
    annotations: DESTRUCTIVE,
    timeoutMs: 10 * MIN,
    argv: (a) => ["vfs", "rehome", ...bool("--dry-run", a.dryRun)],
  },

  // Version control
  {
    name: "vcs_status",
    title: "Project status",
    description: "What has changed in a project since its last commit.",
    input: { project },
    annotations: READ,
    argv: (a) => ["vcs", "status", "--project", a.project],
  },
  {
    name: "vcs_commit",
    title: "Commit",
    description: "Record a project's current state.",
    input: { project, message: z.string().min(1) },
    annotations: WRITE,
    argv: (a) => ["vcs", "commit", "--project", a.project, "-m", a.message],
  },
  {
    name: "vcs_log",
    title: "Project history",
    description: "A project's commits, newest first.",
    input: { project, count: z.number().int().positive().optional() },
    annotations: READ,
    argv: (a) => ["vcs", "log", "--project", a.project, ...opt("-n", a.count)],
  },
  {
    name: "vcs_show",
    title: "Show a commit",
    description: "What one commit changed.",
    input: { project, commit: z.string().min(1) },
    annotations: READ,
    argv: (a) => ["vcs", "show", a.commit, "--project", a.project],
  },
  {
    name: "vcs_diff",
    title: "Compare commits",
    description: "Compare two commits (default: the last commit against now).",
    input: { project, a: z.string().optional(), b: z.string().optional() },
    annotations: READ,
    argv: (a) => ["vcs", "diff", ...pos(a.a), ...pos(a.b), "--project", a.project],
  },
  {
    name: "vcs_branch",
    title: "Branches",
    description: "List a project's branches, or start a new one at the current commit when name is given.",
    input: { project, name: z.string().optional() },
    annotations: WRITE,
    argv: (a) => ["vcs", "branch", ...pos(a.name), "--project", a.project],
  },
  {
    name: "vcs_switch",
    title: "Switch branch",
    description: "Move a project onto a branch. Refuses if there are uncommitted changes.",
    input: { project, name: z.string().min(1) },
    annotations: WRITE,
    argv: (a) => ["vcs", "switch", a.name, "--project", a.project],
  },
  {
    name: "vcs_checkout",
    title: "Check out a commit",
    description: "Put a project's files at an old commit to inspect it (detaches HEAD). Refuses if there are uncommitted changes.",
    input: { project, commit: z.string().min(1) },
    annotations: DESTRUCTIVE,
    argv: (a) => ["vcs", "checkout", a.commit, "--project", a.project],
  },
  {
    name: "vcs_merge",
    title: "Merge",
    description: "Bring a branch into the current one, or abort a merge that stopped for conflicts.",
    input: { project, name: z.string().optional(), abort: z.boolean().optional() },
    annotations: WRITE,
    argv: (a) => ["vcs", "merge", ...pos(a.name), ...bool("--abort", a.abort), "--project", a.project],
  },
  {
    name: "vcs_restore",
    title: "Restore a file from history",
    description: "Put one file back as it was at a commit (default: the last commit).",
    input: { project, path: z.string().min(1).describe("Path within the project"), commit: z.string().optional() },
    annotations: DESTRUCTIVE,
    argv: (a) => ["vcs", "restore", a.path, ...pos(a.commit), "--project", a.project],
  },

  // Key/value
  {
    name: "kv_ls",
    title: "List personal keys",
    description: "List the keys (never values) in your personal key/value store, optionally under a prefix.",
    input: { prefix: z.string().optional() },
    annotations: READ,
    argv: (a) => ["kv", "ls", ...pos(a.prefix)],
  },

  // Hosting
  {
    name: "deploy",
    title: "Deploy to test",
    description:
      "Deploy a built web client to the app's TEST environment and return its address. Run the project's build first; uploads <projectDir>/dist (or `dist`). Reads the app from the project's .muhkoo-app.json (from provision). Also copies the project's source to /apps/<slug> in your filesystem. Use promote to put the deployed version into production.",
    input: {
      projectDir: absolutePath("projectDir").describe("The app's project folder (holds .muhkoo-app.json)"),
      dist: z.string().optional().describe("Build output folder, relative to projectDir or absolute; default dist"),
      noFilesystem: z.boolean().optional().describe("Skip copying the source to your filesystem"),
    },
    annotations: WRITE,
    timeoutMs: 10 * MIN,
    argv: (a) => ["deploy", ...opt("--dist", a.dist), ...bool("--no-vfs", a.noFilesystem)],
    cwd: (a) => a.projectDir,
  },
  {
    name: "promote",
    title: "Promote to production",
    description:
      "Put an app's current TEST hosting release and functions into PRODUCTION, in place. Instant and rollback-able (hosting_rollback). Production data and per-environment config are not touched.",
    input: {
      appId: appId.optional().describe("The app id; or give projectDir to read it from .muhkoo-app.json"),
      projectDir: absolutePath("projectDir").optional(),
    },
    annotations: DESTRUCTIVE,
    argv: (a) => ["promote", ...pos(a.appId)],
    cwd: (a) => a.projectDir,
  },
  {
    name: "hosting_status",
    title: "Hosting status",
    description: "An app's hosting: whether it is published and its releases.",
    input: { appId },
    annotations: READ,
    argv: (a) => ["hosting", "status", a.appId],
  },
  {
    name: "hosting_rollback",
    title: "Roll back hosting",
    description: "Point an app's hosting back at an earlier release.",
    input: { appId, releaseId: z.string().min(1).describe("From hosting_status") },
    annotations: DESTRUCTIVE,
    argv: (a) => ["hosting", "rollback", a.appId, "--release", a.releaseId],
  },
  {
    name: "hosting_rm_release",
    title: "Delete a release",
    description: "Delete one hosting release.",
    input: { appId, releaseId: z.string().min(1) },
    annotations: DESTRUCTIVE,
    argv: (a) => ["hosting", "rm-release", a.appId, a.releaseId],
  },
  {
    name: "hosting_unpublish",
    title: "Unpublish",
    description: "Take an app's site offline.",
    input: { appId },
    annotations: DESTRUCTIVE,
    argv: (a) => ["hosting", "unpublish", a.appId],
  },
  {
    name: "domains_ls",
    title: "List domains",
    description: "List an app's custom domains and their certificate status.",
    input: { appId },
    annotations: READ,
    argv: (a) => ["domains", "ls", a.appId],
  },
  {
    name: "domains_add",
    title: "Add a domain",
    description: "Attach a custom domain to an app; the result says which DNS records to create.",
    input: { appId, hostname: z.string().min(1) },
    annotations: WRITE,
    argv: (a) => ["domains", "add", a.appId, a.hostname],
  },
  {
    name: "domains_rm",
    title: "Remove a domain",
    description: "Detach a custom domain from an app; the site stops answering on it.",
    input: { appId, hostname: z.string().min(1) },
    annotations: DESTRUCTIVE,
    argv: (a) => ["domains", "rm", a.appId, a.hostname],
  },

  // Tools
  {
    name: "logs",
    title: "Server logs",
    description: "Show an app's server-log Space and recent entries (entries are end-to-end encrypted; decrypted viewing is in the portal).",
    input: { appId, env: z.enum(["live", "test"]).optional(), limit: z.number().int().positive().optional() },
    annotations: READ,
    argv: (a) => ["logs", a.appId, ...opt("--env", a.env), ...opt("--limit", a.limit)],
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
