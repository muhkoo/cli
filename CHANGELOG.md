# Changelog

All notable changes to `@muhkoo/cli` are documented here.

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
