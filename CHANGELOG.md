# Changelog

All notable changes to `@muhkoo/cli` are documented here.

## 0.13.2-alpha.0 — `mount` and `import` read in parallel (2026-08-29)

### Fixed

- **`scanRemote` reads files concurrently instead of one at a time**, which is what made `muhkoo vfs mount` look like it had hung on anything of size. Each read is an independent round trip (a manifest lookup plus its shards), so doing them in series cost the sum of the latencies. Measured on doodledottie — 38 files, 16.5MB — the scan went from **10974ms to 3143ms**. Affects `mount` and `import` alike, and the filters now run once up front rather than being interleaved with the reads.

## 0.13.1-alpha.0 — faster `vfs tree`, `mount` and `import` (2026-08-29)

### Fixed

- Picks up `@muhkoo/connect@0.13.1-alpha.0`, where `vfs.walk` lists sibling directories concurrently rather than one at a time. Every command that enumerates the filesystem — `tree`, `find`, `mount`, `import`, `sweep` — spent 1–2s walking before it did anything. Output order is unchanged.

## 0.13.0-alpha.0 — the sync no longer trusts what comes down (2026-08-24)

### Security

`vfs mount` writes the remote filesystem onto local disk, so anything able to write a user's VFS could choose both the bytes and the path of a file landing on their machine. Today that includes **every app the user signs into**, because hosted auth hands the app the master seed (tracked as SEC-3 in `accelerator/SECURITY-FOLLOWUPS.md`).

- **The ignore rules apply in both directions.** They previously decided only what LEFT the machine — nothing filtered what arrived, so a remote `/.git/config` was written straight into the developer's repository. `core.pager`, `alias.*` and `core.fsmonitor` are shell commands git runs itself on an ordinary `git status`, and need no execute bit, which the 0644 the sync writes would otherwise have denied.
- **An always-refused list that no flag overrides**: `.git/`, `.ssh/`, `.muhkoo/`, `.vscode/`, `.idea/`, `node_modules/`, `.envrc`, `.npmrc`, `.netrc` and shell rc files. `--hidden` means "sync dot-files", not "let a remote party rewrite my git config".
- **Writes and deletes refuse anything that is not a regular file.** `writeFile` opens with `O_CREAT|O_TRUNC` and follows symlinks, so a link anywhere in the mounted tree redirected remote content to whatever it pointed at — the one way content genuinely escaped the mount directory, on every platform. `scanLocal` already refused to *read* non-regular files; the two directions now agree.
- **A containment check** so a synced path cannot resolve outside the mount, applied to every action. Traversal was not reachable through the normal remote path (the SDK collapses `..` before a path leaves `walk()`), but nothing here relied on that, and the state file is a second source of keys that never passes through it.
- **`delete-local` is gated behind `--allow-delete`**, like the remote direction. Anything able to delete a file from the filesystem previously deleted it from the developer's disk with no flag and no prompt.

Covered by the new `tests/mount.test.js` — 11 of its cases fail against the previous release.

## 0.12.0-alpha.0 — `muhkoo vcs`, bulk import, and `.vcsignore` (2026-08-24)

### Added

- **`muhkoo vcs` — version control for a project.** `status`, `commit -m`, `log`, `show`, `diff`, `branch`, `switch`, `checkout`, `merge`, `restore`. The project comes from your VFS working directory, so `muhkoo vfs cd /apps/my-app` then `muhkoo vcs log` does what you would expect; `--project <slug>` overrides it. Drives `client.vcs` through the SDK, because commit hashes come from a canonical encoding and a second implementation here would only have to agree with it byte-for-byte forever.
- **`muhkoo vfs import <dir…>` — upload whole projects in one pass.** Several directories in ONE process on purpose: every invocation of the CLI unlocks the vault, and a shell loop over a dozen projects trips the auth rate limiter before it finishes. `--dry-run` lists what would go up and the total size before spending metered bytes.
  - The destination defaults to the slug the project declares in `.muhkoo-app.json`, falling back to the directory name. This matters because the portal opens the IDE at `?app=<slug>` and the IDE reads `/apps/<slug>` — a project imported under its directory name is invisible to both wherever the two differ.
- **`.vcsignore` — what not to sync.** Same syntax as `.gitignore` (`!` negation with last-match-wins, trailing `/` for directories, leading `/` to anchor, `*`, `**`, `?`, character classes), layered on top of built-in Node defaults. Resolution is `.vcsignore`, else `.gitignore`, else the defaults alone — so a project works before it opts in. `muhkoo vfs ignore [dir] [--write]` drafts one from the defaults plus the project's own `.gitignore`.
  - Defaults cover dependencies, build output, logs, and `.env` / `.env.*` with `!.env.example` — uploading a `.env` by accident is the expensive mistake here.
  - `.vcsignore` and `.gitignore` now travel with the project; every other dot-entry is still treated as machine state.

### Fixed

- **Sync state is scoped to the remote root.** It recorded which paths were in sync but not *where*, and `planSync` reads "present locally, in the state, absent remotely" as deleted on the other side — so re-pointing a directory at a different `--path` made every local file look deleted, and with `--allow-delete` they would have been. State from a different root is now ignored.
- `-m`, `-n` and `-r` are read from the positionals. The shared argument parser only understands `--flags`, so `muhkoo vcs commit -m "…"` silently lost its message and `muhkoo vfs rm <path> -r` silently refused to recurse.
- `muhkoo vfs ignore` no longer opens a client. Unlocking the vault to write a file on your own disk is both pointless and, in a loop, enough to trip the auth rate limiter.

## 0.10.11-alpha.0 — Access tokens + `muhkoo login` fix (2026-07-29)

### Fixed

- **`muhkoo login` no longer fails with `ERR_MODULE_NOT_FOUND: snarkjs`.** The ZK login path needs `snarkjs` at runtime, but it was never declared as a dependency — so a clean `npm i -g @muhkoo/cli` couldn't sign in (the workaround was installing `snarkjs` globally by hand). It's now a direct dependency.

### Added

- `muhkoo tokens ls|create|revoke <appId>` — manage **[access tokens](https://docs.muhkoo.dev/concepts/access-tokens/)**, the scoped, expiring credential a machine (CI, a server, a function) presents instead of a ZK sign-in. `create` takes `--scopes` (comma-separated, default `db:read,db:write`), `--env`, `--expires-in <days>`, and `--label`; the secret is printed once. `ls` shows label, env, scopes, expiry, and status.

> Versioned in lockstep with `@muhkoo/connect@0.10.11-alpha.0`.

## 0.10.9-alpha.0 — `promote` command (2026-07-06)

### Added

- `muhkoo promote [<appId>]` — promote an app's **test** hosting release (and functions) to **production**, in place. Complements `muhkoo deploy` (which publishes to the test env): deploy → verify on the test URL → `promote`. Owner-only (uses your developer session); the app id falls back to `.muhkoo-app.json`. Production data and per-env app config (CORS + redirect URIs) are not touched. `--json` for machine-readable output; a partial promote exits non-zero.

> Versioned in lockstep with `@muhkoo/connect@0.10.9-alpha.0` (passkey platform-authenticator fix).

## 0.7.0-alpha.5 — Security hardening (2026-06-18)

### Security

- Write `~/.muhkoo/config.json` (session token) and `.muhkoo-app.json` (app secret keys) with `0600` permissions — config via temp-file + atomic rename, directory `0700` — so there's no world-readable window.
- HTML-escape the loopback sign-in page, and redact app keys / long tokens from echoed server error bodies (login, deploy, and generic request errors).
- Added `SECURITY.md`.

> Versioned in lockstep with `@muhkoo/connect`; the jump to `0.7.0-alpha.5` keeps the two aligned.

## 0.1.0-alpha.0 — Initial release

First public alpha of the `muhkoo` CLI. Built on `@muhkoo/connect`.

### Added

- **Account:** `login` (zero-knowledge developer login → stored session token),
  `login --web` (browser sign-in via auth.muhkoo.dev over a localhost loopback —
  password/passkey/Google, no credentials touch the CLI), `logout`, `whoami`.
  Token also resolvable via `--token` / `$MUHKOO_DEV_TOKEN`.
- **Apps:** `apps ls|get|create|slug|rm`, `keys rotate`.
- **Backend provisioning:** `provision --spec <file>` — idempotently create/update
  database tables, agents, and serverless functions from one JSON spec; `--enable`
  to wire agents/functions onto channels; `--dry-run` to preview.
- **Hosting:** `deploy` (content-addressed blob upload + atomic release; accepts a
  developer session or an app secret key), `hosting status|rollback|rm-release|unpublish`.
- **Custom domains:** `domains ls|add|rm`.
- **Inspection:** `tables ls|get|rm`, `agents ls|get|rm|enable|disable|models`,
  `functions ls|get|code|deploy|rm|enable|disable`, `logs`.
- **Tools:** `eject` — preview an agent's compiled system prompt + tools config.
- **Environments:** `--base prod|staging|local|<url>` on every command;
  `--json` output on read commands.
