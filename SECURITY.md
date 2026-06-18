# Security Policy

The `muhkoo` CLI handles developer credentials: it stores a session token in
`~/.muhkoo/config.json`, runs a browser-based (loopback OAuth + PKCE) sign-in,
and reads app secret keys from `.muhkoo-app.json` to deploy. We take
vulnerabilities seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's **[Private Vulnerability Reporting](https://github.com/muhkoo/cli/security/advisories/new)**
(Security → Report a vulnerability). If that is unavailable, email
**security@muhkoo.com** with:

- a description of the issue and its impact,
- steps to reproduce (a minimal proof-of-concept if possible),
- affected version(s) and environment (OS, Node version).

We aim to acknowledge reports within **3 business days** and to provide a
remediation timeline after initial assessment. We will credit reporters in the
release notes unless you prefer to remain anonymous.

## Supported versions

This CLI is in **alpha** (`0.x`) and versioned in lockstep with
[`@muhkoo/connect`](https://www.npmjs.com/package/@muhkoo/connect). Security
fixes land on the latest published version; there are no LTS branches yet.

## Scope

In scope:

- Leakage of the stored session token, app keys, or other credentials (e.g.
  insecure file permissions, secrets written to logs/argv).
- Flaws in the browser loopback sign-in: PKCE/`state` handling, the localhost
  callback server, or the authorization-code exchange.
- Command/argument injection, path traversal, or unsafe handling of
  server-supplied data.

Out of scope:

- Vulnerabilities in the Muhkoo Accelerator service or the `@muhkoo/connect`
  SDK — report those to the same contact, noting the component (the SDK has its
  own `SECURITY.md`).
- Issues requiring an already-compromised host, a malicious local process with
  the same user privileges, or a dependency the user installed themselves.
- Sending credentials to a non-default `--base` the operator explicitly chose.

## Notes

This code has **not** undergone a formal third-party security audit. Until it
does, treat it as suitable for evaluation and development. Keep
`~/.muhkoo/config.json` and `.muhkoo-app.json` owner-only (the CLI writes them
with `0600`), and prefer `--base` targets served over HTTPS.
