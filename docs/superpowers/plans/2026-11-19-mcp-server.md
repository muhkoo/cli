# Muhkoo MCP server (`muhkoo mcp`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `muhkoo mcp`, a local stdio MCP server that exposes every CLI action as a typed tool, and package it as a Claude Desktop `.mcpb`.

**Architecture:** Each tool is a data entry (name, description, zod input schema, annotations, argv builder). A runner spawns the CLI's own `bin/muhkoo.js … --json` as a child process (stdin ignored, non-interactive), parses the single JSON object on stdout, seals secrets into owner-only files, redacts, and returns the result. The CLI gets a global JSON mode in `ui.js` so that progress goes to stderr and errors become `{"error"}`.

**Tech Stack:** Node >= 20, plain ESM, no build step; `@modelcontextprotocol/sdk` ^1.32 (with its `zod` peer); vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-mcp-server-design.md`

## Global Constraints

- Node >= 20, plain ESM, zero build. Add only `@modelcontextprotocol/sdk` (+ `zod` if it is a peer).
- Spawn `process.execPath` with the CLI's own `bin/muhkoo.js`, never `muhkoo` from PATH.
- No tool result ever contains an sk key, an access token, or a session token. pk keys are returned.
- No subprocess ever reads stdin: stdin `ignore` plus `MUHKOO_NONINTERACTIVE=1`.
- Tools take no `--base`. Only the `login` tool takes an optional `base`.
- Every local path argument must be absolute. Relative or `~` paths are an error.
- Timeouts: `login` 5 min, `deploy` / `vfs_import` / `provision` 10 min, everything else 60 s.
- Destructive (`destructiveHint: true`): `promote`, every `*_rm`, `tokens_revoke`, `devices_rm`, `keys_rotate`, `vfs_restore`, `vfs_sweep`, `vfs_rehome`, `tokens_create`, `functions_deploy`, `hosting_rollback`, `hosting_rm_release`, `hosting_unpublish`, `vcs_restore`, `vcs_checkout`. `deploy` is NOT destructive.
- Read-only (`readOnlyHint: true`): every `ls`/`get`/`stat`/`cat`/`tree`/`find`/`history`/`status`/`log`/`show`/`diff`/`code`/`models`/`notices`/`query`/`slug`, plus `whoami` and `logs`. No tool that reads or writes LOCAL files is read-only.
- **Matt does all commits.** Each task ends with "leave changes in the working tree", never `git commit`. Never run `prettier --write`. Never `npm run release` / publish.
- Product copy in tool descriptions: no Cloudflare/Workers branding.

## Review Focus

1. **A command that unexpectedly prompts** (unpaired machine, expired device key) must fail within a second with "not signed in on this machine — use the login tool", not hang until the timeout. *(Task 1 test)*
2. **Huge or binary output** (`vfs_cat` on a 50 MB or binary file): cap the returned text at 1 MiB with a "truncated" note. Binary content is returned as a note to use `vfs_get` instead. *(Task 3 test)*
3. **Expired or missing session**: the CLI's 401 error comes back as a tool error that names the `login` tool. *(Task 3 test)*
4. **Relative / `~` paths** for `projectDir`, `local`, or `spec` are rejected before spawning, with a message saying an absolute path is needed. *(Task 5 test)*
5. **Timeout**: the child (and its own children, e.g. deploy's `vfs import`) is killed, and the tool returns "timed out after Ns". *(Task 3 test, spawned with `detached: true` and the group killed via `process.kill(-pid)`)*

---

### Task 1: JSON mode and non-interactive mode in the CLI core

**Files:**
- Modify: `src/lib/ui.js` (info/ok/warn/step/die/prompt/promptHidden)
- Modify: `src/index.js` (`run()`)
- Test: `tests/jsonMode.test.js`

**Interfaces:**
- Produces: `setJsonMode(on: boolean): void` and `isJsonMode(): boolean` exported from `ui.js`. When on, `info/ok/warn/step` write to **stderr**, `json()` still writes to stdout, and `die(first, ...more)` writes `{"error": "<first + more joined by \n, printable>"}` to stdout and exits 1.
- Produces: when `process.env.MUHKOO_NONINTERACTIVE === "1"`, `prompt()` and `promptHidden()` throw `new Error("not signed in on this machine — use the login tool (or run `muhkoo login` in a terminal)")` without touching stdin.
- `run(argv)` calls `setJsonMode(true)` when `args.json`, before loading the command.

- [ ] **Step 1: Write failing tests** in `tests/jsonMode.test.js`. Spawn `node bin/muhkoo.js` as a child process:
  - `apps bogus --json` (an unknown subcommand path that `die()`s): stdout parses to an object with a string `error`, exit code 1.
  - `nosuchcommand --json`: stdout is `{"error": …}` containing `Unknown command`.
  - The unit test for `prompt` sets `MUHKOO_NONINTERACTIVE=1`, calls `prompt("x")`, and expects a rejection matching `/use the login tool/` within 1000 ms (Review Focus 1).
  - With JSON mode on, `info("hi")` writes to `process.stderr` and nothing to stdout (spy on `process.stdout.write` / `console.log`).
- [ ] **Step 2: Run** `npx vitest run tests/jsonMode.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** in `ui.js` (module-level flag; route through `console.error` when on) and wire it in `index.js`.
- [ ] **Step 4: Run** `npx vitest run`. Expected: the new tests pass and every existing suite still passes (watch `pipedOutput.test.js` and `terminal.test.js`).
- [ ] **Step 5:** Leave changes in the working tree.

### Task 2: `--json` for deploy, provision, promote, login, logout, eject

**Files:**
- Modify: `src/commands/deploy.js`, `provision.js`, `promote.js`, `login.js`, `logout.js`, `eject.js`
- Test: extend `tests/deployCommand.test.js`, `tests/loginCommand.test.js`, `tests/provisionCollections.test.js`; new `tests/jsonResults.test.js` for promote/logout/eject

**Interfaces (stdout under `--json`, exactly one object via `json()`):**
- deploy → `{ appId, base, releaseId, bytes, files, url, filesystem: { copied: boolean, warnings: string[] } }`
- provision → the written record path plus `{ appId, slug, base, recordPath, tables, collections, hostingUrl, keys }`, where `keys` is the record's key array unchanged (secrets are sealed by the MCP layer in Task 4, not here)
- promote → the server body as today, minus the stray `info("")` before it
- login → `{ base, username, paired: boolean, deviceFactorId?: string }`. **Never the token.**
- logout → `{ base, signedOut: true }`
- eject → `{ prompt, tools }` as the runner already computes

- [ ] **Step 1: Write failing tests:**
  - deploy with stubbed fetch/spawn and `--json`: `JSON.parse(stdout)` has `url`, `releaseId` and `filesystem.copied`.
  - login `--json` (stubbed web login): the result has `base` and `paired`, and `JSON.stringify(result)` does not contain the stub session token.
  - provision `--json --dry-run`: the result has `appId` / `recordPath`.
  - promote `--json`: stdout is parseable JSON (no leading blank line).
- [ ] **Step 2: Run** the four files. Expected: FAIL.
- [ ] **Step 3: Implement.** Each command builds its result object and calls `json()` once at the end when `args.json`. Progress calls stay; JSON mode already routes them to stderr.
- [ ] **Step 4: Run** `npx vitest run`. Expected: all pass.
- [ ] **Step 5:** Leave changes in the working tree.

### Task 3: Runner

**Files:**
- Create: `src/mcp/run.js`
- Test: `tests/mcpRun.test.js` (+ fixture `tests/fixtures/fake-cli.mjs`, a script whose behaviour is chosen by argv: print JSON, print text, exit 1 with `{"error"}`, sleep forever with a sleeping grandchild, print 3 MiB, print binary bytes)

**Interfaces:**
- Produces: `runCli(argv: string[], opts?: { cwd?: string, timeoutMs?: number, bin?: string, onStderr?: (line: string) => void }): Promise<{ ok: true, data: unknown } | { ok: false, error: string }>`
  - Spawns `process.execPath [bin ?? <repo>/bin/muhkoo.js, ...argv, "--json"]` with `stdio: ["ignore","pipe","pipe"]`, `detached: true`, and env `{ ...process.env, NO_COLOR: "1", MUHKOO_NONINTERACTIVE: "1" }`.
  - On exit 0: `data` is the parsed stdout JSON. If stdout isn't JSON, `data` is `{ text }`: capped at 1 MiB with `"\n…[truncated: N bytes]"`, or `{ text: "binary output; use vfs_get to save it to a file" }` when it contains NUL bytes.
  - On non-zero exit: `error` is the `{"error"}` message, otherwise the last 2 KB of stderr. If it matches `/401|not signed in|session/i`, append `" — use the login tool to sign in."`.
  - On timeout: kill the process group (`process.kill(-child.pid, "SIGKILL")`) and return `error: "timed out after <s>s"`.

- [ ] **Step 1: Write failing tests**, one per fixture mode: JSON → `ok:true` with the data; text → `{text}`; error → `ok:false` with the message; a 401 error → message ends with `use the login tool to sign in.`; 3 MiB → text length ≤ 1 MiB + note, matches `/truncated/`; binary → the `vfs_get` note; timeout at 300 ms → `timed out after 0.3s`, and the grandchild pid is gone (`process.kill(pid, 0)` throws).
- [ ] **Step 2: Run** `npx vitest run tests/mcpRun.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement `runCli`.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5:** Leave changes in the working tree.

### Task 4: Secret sealing and redaction

**Files:**
- Create: `src/mcp/secrets.js`
- Modify: `src/lib/ui.js` `redact()`: also mask `mk_<x>_at_…` and `mk_<x>_sk_…` fully past the prefix, and any value of a JSON key named `token`, `sessionToken`, `plaintext` (non-pk) or `deviceKey`
- Test: `tests/mcpSecrets.test.js`

**Interfaces:**
- Produces: `sealSecrets(tool: string, data: unknown, ctx: { projectDir?: string, secretsDir?: string }): Promise<unknown>`
  - Walks `data`. Every object with a `plaintext` string whose `type !== "pk"` has its plaintext moved to a file and replaced with `masked: "<first 11 chars>…"` and `savedTo: <path>`.
  - Files:
    - `keys_rotate` / `apps_create` / `provision`: when `projectDir` holds `.muhkoo-app.json`, update its `keys` array (mode 0600, the same write as `provision.js`'s `saveRecord`). Otherwise write `<secretsDir>/<appId>-keys.json`.
    - `tokens_create`: `<secretsDir>/token-<keyId>.txt`.
    - `secretsDir` defaults to `~/.muhkoo/secrets`, created 0700. Files are written 0600.
- Produces: `scrub(data: unknown): unknown`, a deep `redact()` over every string as the final backstop.
- `SECRET_PATTERNS: RegExp[]`, exported for tests.

- [ ] **Step 1: Write failing tests:**
  - An `apps_create`-shaped body with pk+sk keys and no projectDir → the pk plaintext survives; the sk has `masked` + `savedTo`; the file exists with mode `0o600` and holds the sk; `JSON.stringify(result)` matches no `SECRET_PATTERNS`.
  - Same with a temp projectDir that has `.muhkoo-app.json` → the record's sk is updated in place.
  - `tokens_create` body → `token-<keyId>.txt` holds the plaintext.
  - `scrub` masks a session-token-shaped 64-char string inside nested `{ error: "... <token> ..." }`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS, including the existing `redact` users.
- [ ] **Step 5:** Leave changes in the working tree.

### Task 5: Tool table

**Files:**
- Create: `src/mcp/tools.js`
- Test: `tests/mcpTools.test.js`

**Interfaces:**
- Produces: `TOOLS: Array<{ name: string, title: string, description: string, input: Record<string, ZodType>, annotations: { readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint: true }, timeoutMs?: number, argv(args): string[], cwd?(args): string | undefined }>`
- Produces: `EXCLUDED: Record<string, string>`, mapping a CLI usage key (e.g. `"vfs mount"`) to the reason it is excluded.
- Produces: `absolutePath(field: string)`, a zod refinement used by every local-path field. It rejects relative paths and paths starting with `~` with `"<field> must be an absolute path"`.

**Tools** (name = `<group>_<sub>` with `-` → `_`; descriptions written from each command's `help`; arguments mirror the help's flags):
- `login` (`base?`, timeout 5 min), `logout`, `whoami`
- `apps_ls/get/create/slug/rm`, `keys_rotate` (`appId`, `projectDir?`), `tokens_ls/create/revoke`, `devices_ls/rm`
- `provision` (`spec` abs, `projectDir` abs → cwd, `dryRun?`, `enable?`), `tables_ls/get/rm`, `vectors_ls/get/create/rm/notices/query`, `agents_ls/get/rm/enable/disable/models`, `functions_ls/get/code/deploy/rm/enable/disable` (deploy takes `file` abs)
- `vfs_ls/stat/tree/cat/put/get/mkdir/rm/cp/mv/find/history/restore/import/ignore/sweep/rehome`. Muhkoo paths are absolute VFS paths (start with `/`). `put` / `get` / `import` local sides are absolute local paths. `ignore` accepts `dir` and `acceptDigest?` / `draft?` / `write?`, and never `--accept` without a digest.
- `vcs_status/commit/log/show/diff/branch/switch/checkout/merge/restore`, following `vcs.js` help
- `kv_ls`
- `deploy` (`projectDir` abs → cwd, `dist?`, `noFilesystem?`, timeout 10 min), `promote` (`appId?`, `projectDir?`), `hosting_status/rollback/rm_release/unpublish`, `domains_ls/add/rm`
- `logs` (one-shot), `eject` (`file` abs)

**EXCLUDED:** `vfs mount` (long-running), `vfs cd`/`vfs pwd` (shared state), `vfs use-app`/`vfs app` (deprecated), `login --token` and password login (credentials).

- [ ] **Step 1: Write failing tests:**
  - Every name in the Global Constraints destructive list has `destructiveHint: true`, and `deploy` does not.
  - Every read-only-pattern tool has `readOnlyHint: true`, and no tool with an absolute-local-path field does.
  - `argv` snapshots: `deploy({projectDir:"/p"})` → `["deploy"]` with `cwd → "/p"`; `vfs_ls({path:"/apps"})` → `["vfs","ls","/apps"]`; `tokens_create({appId:"a",scopes:["db:read"]})` → `["tokens","create","a","--scopes","db:read"]`; `login({base:"staging"})` → `["login","--web","--base","staging"]`.
  - No tool's input has a `base` field except `login`.
  - Review Focus 4: parsing `deploy` input `{projectDir:"rel/dir"}` and `{projectDir:"~/x"}` fails with `must be an absolute path`.
  - Tool names are unique and match `/^[a-z_]+$/`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, reading each command's `help` for flags.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5:** Leave changes in the working tree.

### Task 6: Drift guard

**Files:**
- Test: `tests/mcpDrift.test.js`

**Interfaces:**
- Consumes: `TOOLS`, `EXCLUDED` (Task 5); each command module's exported `help`.

- [ ] **Step 1: Write the test.** Import every module in `src/index.js`'s `COMMANDS`, take each `help`, and extract the keys with `/^\s+muhkoo ([a-z-]+)(?: ([a-z-]+))?/gm`. Ignore second tokens that start with `-`. Map `X Y` → tool `X_Y` (dashes to `_`), and a bare `X` → tool `X`. Assert that every key is either a tool name or an `EXCLUDED` key. Also assert that every `EXCLUDED` key still appears in some help, so stale exclusions fail.
- [ ] **Step 2: Run** `npx vitest run tests/mcpDrift.test.js`. Expected: PASS. If it fails, add the missing tool in Task 5's table (not an exclusion), unless there's a reason to record.
- [ ] **Step 3:** Leave changes in the working tree.

### Task 7: The server and the `mcp` command

**Files:**
- Create: `src/mcp/server.js`, `src/commands/mcp.js`
- Modify: `src/index.js` (add `mcp` to `COMMANDS` and a "Tools" help line: `mcp  run as an MCP server for Claude (stdio)`), `package.json` (dependency)
- Test: `tests/mcpServer.test.js`

**Interfaces:**
- Consumes: `TOOLS` (Task 5), `runCli` (Task 3), `sealSecrets` / `scrub` (Task 4).
- Produces: `createServer({ run = runCli } = {}): McpServer`. It registers each tool with `server.registerTool(name, { title, description, inputSchema, annotations }, handler)`. The handler does: `run(tool.argv(args), { cwd: tool.cwd?.(args), timeoutMs: tool.timeoutMs ?? 60_000 })` → on ok, `scrub(await sealSecrets(name, data, { projectDir: args.projectDir }))` → `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result }`; on error, `{ isError: true, content: [{ type: "text", text: error }] }`.
- For every tool without `readOnlyHint`, the handler adds `base` (the stored `cfg.base` from `loadConfig()`, resolved with `resolveBaseUrl`) to the result when the CLI's JSON didn't include one, so every change reports where it happened (spec: Platform base).
- Login while the browser can't open: `webLogin` already prints the URL. In JSON mode that goes to stderr, and the runner forwards stderr lines from the `login` tool as MCP `notifications/message` (level `info`), so the developer sees the link while the tool waits.
- Server info: `{ name: "muhkoo", version: <package.json version> }`, plus `instructions` (one paragraph): start with `whoami`; sign in with `login`; `deploy` publishes to test and `promote` to production; secrets are saved to files and never shown.
- `src/commands/mcp.js` default export: create the server and `connect(new StdioServerTransport())`. Never write to stdout except through the transport.

- [ ] **Step 1: Write failing tests** using the SDK's `InMemoryTransport` + `Client`, with `run` stubbed:
  - `listTools` returns `TOOLS.length` tools, and `promote` has `annotations.destructiveHint === true`.
  - Calling `whoami` with the stub returning `{ok:true,data:{username:"dev",base:"https://api.muhkoo.dev"}}` gives `structuredContent.username === "dev"`.
  - A stub returning `apps_create` data with an sk key: the text content matches no `SECRET_PATTERNS` (use a temp `secretsDir` via env `MUHKOO_SECRETS_DIR`, which `sealSecrets` honours).
  - A stub error → `isError: true` with the message.
  - An end-to-end smoke test, skipped unless `MCP_E2E=1`: spawn `node bin/muhkoo.js mcp` with `StdioClientTransport`, `listTools`, call `whoami` against whatever base the local config holds.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3:** `npm i @modelcontextprotocol/sdk@^1.32.0` (and `zod` if npm reports it as an unmet peer), then implement.
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS. Then `MCP_E2E=1 npx vitest run tests/mcpServer.test.js` with the CLI logged into **staging** (`muhkoo login --web --base staging`). Expected: PASS.
- [ ] **Step 5:** Leave changes in the working tree.

### Task 8: Desktop packaging and docs

**Files:**
- Create: `mcpb/manifest.json`, `scripts/build-mcpb.mjs`
- Modify: `package.json` (`"build:mcpb": "node scripts/build-mcpb.mjs"`; keep `mcpb/` out of the npm `files` list), `README.md` (an "Use with Claude" section), `CHANGELOG.md` (Unreleased entry)
- Test: `tests/mcpbManifest.test.js`

**Interfaces:**
- `manifest.json`: `manifest_version` per the current `@anthropic-ai/mcpb` schema; `name: "muhkoo"`; `display_name: "Muhkoo"`; `server: { type: "node", entry_point: "server/bin/muhkoo.js", mcp_config: { command: "node", args: ["${__dirname}/server/bin/muhkoo.js", "mcp"] } }`; `tools` lists every `TOOLS` name with its description; `compatibility.runtimes.node: ">=20"`.
- `build-mcpb.mjs`: copy `bin/`, `src/`, `package.json`, and production `node_modules` into `dist/mcpb/server/`; regenerate the manifest's `tools` from `TOOLS`; run `npx -y @anthropic-ai/mcpb pack dist/mcpb dist/muhkoo.mcpb`.

- [ ] **Step 1: Write a failing test:** the manifest's `tools` names equal the `TOOLS` names after `build-mcpb.mjs --manifest-only` regenerates it; `entry_point` exists relative to the build dir.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, then run `npm run build:mcpb`. Expected: `dist/muhkoo.mcpb` is created.
- [ ] **Step 4: Manual check (report the results to Matt; do not publish).** With the CLI logged into staging, install `dist/muhkoo.mcpb` in Claude Desktop (Settings → Extensions → install from file).
  1. Ask "who am I on Muhkoo".
  2. Ask it to list `/` in the filesystem and `cat` a file.
  3. Ask it to deploy a small built sample app to test and return the URL.
  4. Confirm Desktop asks before `promote`, and decline it.
- [ ] **Step 5:** Leave changes in the working tree. Publishing the CLI or the `.mcpb` is a production release and waits for Matt.
