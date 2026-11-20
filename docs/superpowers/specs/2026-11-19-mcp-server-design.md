# Muhkoo MCP server (`muhkoo mcp`): design

Date: 2026-11-19. Status: draft for approval (builder check done, secrets decided).

## Intent

Developers building apps on Muhkoo should be able to do everything the CLI
does from inside Claude (Claude Desktop first, Claude Code too) without
leaving the conversation. In the first ten minutes a new user should be
able to **deploy an app** and **browse their Muhkoo filesystem**.

This server is for **developers**. Regular Muhkoo users (people using apps,
not building them) will get a separate MCP server later. This design does
not cover it.

It ships as a Desktop Extension (`.mcpb`), which is the item in
`accelerator/TODO.md` "Claude Desktop plugin for Muhkoo". The `.mcpb` is a
thin wrapper around `muhkoo mcp`.

## Goals

- Every CLI action is available as an MCP tool. Today that is 20 command
  groups and roughly 60 subcommands.
- Deploying and browsing the filesystem work well first, and the
  descriptions say so.
- Anything that reaches production or destroys something is its own tool,
  marked destructive, so the client asks before running it.
- It uses the same sign-in, config, and staging/production base as the CLI,
  with no second login.
- It stays in step with the CLI as commands are added.

## Non-goals

- End-user features (the separate MCP server).
- Rewriting CLI commands as a library (approach C below). That is possible
  later, one command at a time.
- Hosted/remote MCP. This is a local stdio server only.
- Long-running/background CLI modes. Those are `vfs mount` (keeps a folder
  live) and `logs --follow`-style streaming. They are left out for now
  (see "Excluded").

## Anti-goals (would make it a failure even if it works)

- Claude deploying or promoting to production, or deleting an app, table,
  domain or file, without the developer explicitly approving that call.
- Secrets showing up in tool output: sk keys, session tokens, newly minted
  access tokens beyond the one-time display the CLI already does, or
  `.muhkoo-app.json` contents.
- A CLI error or `process.exit` killing the server.
- Tools silently drifting from the CLI so that some commands can't be
  reached or have stale flags.

## Constraints (from the CLI as it is)

- CLI commands print and call `die()` / `process.exit`. They cannot be
  called in-process from a long-lived server.
- `--json` exists today on 14 of 20 command groups. It is missing on
  **deploy, provision, promote (partial), login, logout, eject**.
- `deploy` (and `provision`) read `.muhkoo-app.json` **from the current
  directory**. Tools that touch a project must run the CLI with `cwd` set
  to the developer's project folder.
- Prompts: `login` (password), `vfs ignore --accept` (y/N), and **every
  vfs command plus deploy's filesystem copy when this machine is not
  paired** (`src/lib/vfs.js` `unlock()` falls back to a username/password
  prompt). `muhkoo login` (web or password) **already pairs the machine**
  (`login.js`, unless `--no-pair`), so after the `login` tool the vfs
  tools need nothing. No subprocess may ever wait on stdin (see Runner).
- The login base is sticky: the CLI remembers the last `--base`
  (staging/prod). The server must say which base it is acting on.
- Node >= 20, plain ESM, zero build. The MCP server follows the same rules.
- Repo rule: publishing `@muhkoo/cli` moves `latest` for every app, so it
  counts as a production release and needs explicit approval.

## Approaches

**A. Typed tools that run the CLI underneath (chosen).** Each CLI action
is its own MCP tool with a real description and input schema. The tool runs
`node bin/muhkoo.js <command> … --json` as a child process and returns the
parsed result. Coverage is complete, sign-in is shared, and each tool can
carry its own destructive/read-only marking. The cost is about 60 tool
definitions, plus adding `--json` to six commands.

**B. One `run_muhkoo` tool taking any command line.** Full coverage for
almost no code. Rejected: every call looks the same to the client, so it
can't ask before a production deploy while auto-allowing a list.

**C. Turn the commands into a shared library used by both the CLI and the
MCP server.** Cleanest long term. Rejected for now: it is a refactor of the
whole CLI (deploy and vfs are the riskiest parts) before anything ships.
A leaves C open.

Matt chose A.

## Design

### Shape

- New command **`muhkoo mcp`** in the CLI (`src/commands/mcp.js` plus
  `src/mcp/`). It speaks MCP over stdio and uses the official
  `@modelcontextprotocol/sdk`. That is the one new runtime dependency.
- A **tool table** (`src/mcp/tools.js`) holds one entry per tool. Each
  entry has the name, description, input schema, annotations, and a
  function that turns arguments into a CLI argv (plus `cwd` when needed).
  Each tool is data, not hand-written handler code.
- A **runner** (`src/mcp/run.js`) spawns the CLI with `process.execPath`
  and the CLI's own `bin/muhkoo.js` (not whatever `muhkoo` is on PATH, so
  versions always match). It sets stdin to ignore, sets `NO_COLOR` and a
  timeout, and captures stdout/stderr. On success it returns the parsed
  JSON. On failure it returns an MCP tool error with the CLI's message.

### Tool naming and grouping

`<group>_<action>`, for example `apps_list`, `apps_create`, `deploy`,
`promote`, `vfs_ls`, `vfs_cat`, `functions_deploy`, `tables_get`. The
descriptions are written for Claude: what the tool does, when to use it,
and which tool comes before or after it (e.g. "deploy publishes to the
app's **test** environment; use `promote` to move it to production").

### Safety markings (MCP tool annotations)

- **readOnlyHint**: every `ls`/`get`/`stat`/`cat`/`tree`/`find`/`history`,
  `whoami`, `logs`, `hosting` status, and `--dry-run` forms.
- **destructiveHint**: `promote`; every `rm` (apps, tables, vectors,
  agents, functions, domains, vfs, tokens revoke, devices rm); `keys
  rotate`; `vfs restore`; `vfs sweep`; `tokens create` (it mints a
  credential); and `functions deploy` (functions go live on the
  base as soon as they deploy).
- `deploy` is **not** destructive: it always publishes to the app's
  **test** environment with the test sk key. Production is only ever
  reached through `promote`. (Builder check: there is no per-call
  production variant of deploy, so no split tool is needed.)
- Everything else gets neither (create/update against test).

Claude Desktop asks before tools without readOnlyHint unless the user has
allowed them. The markings make that prompt meaningful.

### Platform base (staging/production)

The tools take **no `--base` argument**. They inherit the base from the
last `muhkoo login`, which for every outside developer is production
(api.muhkoo.dev). The `login` tool accepts an optional `base`, which is
the only way to switch (used by Muhkoo staff to work against staging).
`whoami` and every mutating result report the base. *(My call: an agent
can't wander onto another platform mid-conversation.)*

### Runner details (my calls, from the builder check)

- stdin is `ignore`, and the runner sets `MUHKOO_NONINTERACTIVE=1`. The
  CLI's `prompt()`/`promptHidden()` must throw a clear error under that flag
  ("not signed in on this machine — use the login tool") instead of reading
  stdin. One change in `ui.js`.
- `--json` mode: progress lines (`step`/`ok`/`warn`/`info`) go to stderr,
  and exactly one JSON object goes to stdout. `die()` under `--json` prints
  `{"error": "…"}` to stdout and exits non-zero. This is implemented once
  in `ui.js` behind a module-level json flag set by the entrypoint, not
  per command.
- Progress is not streamed to the client in v1. Long tools (deploy, vfs
  import, login) get long timeouts: login 5 min, deploy/import 10 min,
  everything else 60 s.
- `deploy` result: `{ appId, base, release, files, url }`, where `url` is
  the app's test hosting URL, built from the app's slug as `hosting`
  reports it.
- Paths: every local path argument (`projectDir`, `vfs put/get` local side,
  provision `spec`) must be **absolute**, otherwise the tool errors. There is
  no root allowlist. The client's approval prompt is the gate, and none of
  the tools that read or write local files are marked read-only. *(My call:
  it's the developer's own machine and their own encrypted filesystem, the
  same trust as the CLI itself.)*

### Sign-in

- The server never asks for a password. If the CLI reports that nobody is
  signed in, the tool error says so and points to the `login` tool.
- `login` tool: runs `muhkoo login --web [--base …]`. That opens the
  browser for password, passkey or Google sign-in, and the tool returns
  when sign-in completes or after 5 minutes. If the browser can't be
  opened, the result includes the sign-in URL for the developer to open.
  Signing in also pairs the machine, which is what the vfs tools need.
- `whoami` returns the signed-in developer **and the base** (staging or
  production). Every result that changes something includes the base it
  acted on.

### First-ten-minutes paths

- **Deploy:** `apps_list` / `apps_create` → (`provision` with a spec) →
  `deploy(projectDir)` → returns the test URL. `promote(appId)` is a
  separate, destructive step.
- **Filesystem:** `vfs_ls`, `vfs_tree`, `vfs_cat`, `vfs_stat`, `vfs_find`,
  `vfs_history`, then the write tools (`vfs_put`, `vfs_get`, `vfs_mkdir`,
  `vfs_mv`, `vfs_cp`, `vfs_rm`). Paths are always absolute in the tools.
  `vfs cd`/`pwd` are not exposed, because shared working-directory state
  across calls confuses an agent.

### CLI changes needed

- Add `--json` to `deploy`, `provision`, `promote`, `login`, `logout`,
  `eject`. Each prints one JSON object on stdout with the result fields and
  never secrets.
- Make sure every command honours `--json` for errors too: a non-zero exit
  plus `{"error": "…"}` on stdout.

### Secrets (Matt chose: never returned)

No tool result ever contains an sk key, a session token, or an access
token. `pk` keys are not secret and are returned, because Claude needs
them to write client code.
- `provision` / `apps create`: keys are saved to the project's
  `.muhkoo-app.json` (owner-only, as `provision` does today). The result
  gives the path, the app id, the pk keys, and masked sk prefixes
  (`mk_xxx_sk_…`).
- `keys rotate`: new keys update `.muhkoo-app.json` in the given
  `projectDir` when one exists. Otherwise they go to an owner-only file
  `~/.muhkoo/secrets/<appId>-keys.json`. The result gives the path and
  masked prefixes.
- `tokens create`: the token goes to `~/.muhkoo/secrets/token-<id>.txt`
  (0600). The result gives the path, the id, the scopes, the expiry, and a
  masked prefix.
- The runner also passes every result through a redaction pass
  (`redact()` from `ui.js`, extended to sk/at key shapes and session
  tokens) as a backstop, and a test asserts that no tool result matches a
  secret pattern.

### Drift guard

A test parses the `muhkoo <group> <sub>` usage lines from every command
module's exported `help` (they are uniform) and fails if one has no tool, unless it is on an explicit "excluded" list with a
reason.

### Excluded (with reasons, listed in the code)

- `vfs mount`: long-running sync process.
- `vfs cd` / `pwd`: shared state (see above).
- `vfs ignore --accept` without a digest: interactive.
- `logs` streaming/follow modes, if any: long-running. One-shot log reads
  are included.
- `login` with a password/token: the server never handles credentials.

### Packaging (Desktop)

- The `.mcpb` **bundles the CLI** (its `node_modules` included) and runs
  `node bin/muhkoo.js mcp`. That way it can be built and tested against
  staging before anything is published, and the version is fixed by the
  bundle. Build with `mcpb pack`. *(My call over `npx`, which can't be
  tested until the CLI is released.)*
- Tool count (~60) is fine for Claude Desktop. No grouping or lazy loading
  in v1.
- Publishing the CLI and the `.mcpb` is a production release and waits for
  Matt's explicit go.

### Testing

- Unit tests: argv building for every tool, annotations on every
  destructive tool, runner error handling (non-zero exit, bad JSON,
  timeout, killed process), secrets redaction.
- An end-to-end test that starts `muhkoo mcp`, lists tools, and calls
  `whoami` and a read tool against **staging**.
- A manual check in Claude Desktop with the `.mcpb` installed against
  staging: deploy a sample app and browse the filesystem.

## Left to the builder

- Exact tool descriptions and schemas for each subcommand, from its help
  text.
- Per-tool timeouts (deploy and vfs import get long ones).
- Whether `eject` is worth exposing, or should be excluded as tied to a
  local scaffold.
