# Changelog

All notable changes to `@muhkoo/cli` are documented here.

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
