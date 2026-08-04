/**
 * `muhkoo tokens` — create, list, and revoke scoped access tokens for an app.
 * Access tokens are non-ZK machine credentials (mk_<env>_at_<hex>) that are
 * scoped and expiring. The plaintext is shown only once, on creation.
 */

import { devContext } from "../lib/config.js";
import { devCall, ensure } from "../lib/http.js";
import { table, json, ok, info, warn, die, c } from "../lib/ui.js";

/** Valid token scopes, surfaced in help so callers know the vocabulary. */
const SCOPES = [
  "db:read",
  "db:write",
  "kv:read",
  "kv:write",
  "storage:read",
  "storage:write",
  "messages:read",
  "messages:write",
  "functions:invoke",
  "ai:infer",
];

const DEFAULT_SCOPES = ["db:read", "db:write"];

export const help = `muhkoo tokens — manage scoped access tokens

Usage:
  muhkoo tokens ls <appId> [--json]
  muhkoo tokens create <appId> [--scopes db:read,db:write] [--env test|live] [--expires-in <days>] [--label <name>] [--json]
  muhkoo tokens revoke <appId> <keyId>

Scopes:
  ${SCOPES.join(", ")}`;

export default async function tokens(args) {
  const sub = args._[1];
  const ctx = await devContext(args);
  const appId = args._[2] || args.app;
  if (!appId) die("Missing app id. Usage: muhkoo tokens <ls|create|revoke> <appId>");

  switch (sub) {
    case "ls":
    case undefined:
      return list(ctx, appId, args);
    case "create":
      return create(ctx, appId, args);
    case "revoke":
    case "rm":
      return revoke(ctx, appId, args);
    default:
      die(`Unknown subcommand "tokens ${sub}". See \`muhkoo tokens --help\`.`);
  }
}

async function list(ctx, appId, args) {
  const r = ensure(await devCall(ctx, "GET", `/api/apps/${appId}/access-tokens`), "List tokens");
  if (args.json) return json(r.body);
  const items = r.body?.tokens || [];
  if (!items.length) {
    return info("No access tokens. Create one with `muhkoo tokens create <appId>`.");
  }
  table(
    ["LABEL", "KEY ID", "ENV", "SCOPES", "EXPIRES", "STATUS"],
    items.map((t) => [
      t.label || "",
      truncate(t.keyId),
      t.env ?? "",
      Array.isArray(t.scopes) ? t.scopes.join(",") : t.scopes ?? "",
      fmtDate(t.expiresAt),
      statusOf(t),
    ]),
  );
}

async function create(ctx, appId, args) {
  const scopes = args.scopes
    ? String(args.scopes)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_SCOPES;

  const body = { scopes };
  body.env = args.env === "test" ? "test" : "live";
  if (args["expires-in"] !== undefined) body.expiresInDays = Number(args["expires-in"]);
  if (args.label) body.label = args.label;

  const r = await devCall(ctx, "POST", `/api/apps/${appId}/access-tokens`, body);
  if (r.status === 402) die("Access tokens need a paid plan.");
  ensure(r, "Create token");
  if (args.json) return json(r.body);

  const t = r.body;
  ok(`Created ${t.env} access token${t.label ? ` ${c.bold(t.label)}` : ""} (${t.keyId})`);
  info(`  scopes:  ${(t.scopes || scopes).join(", ")}`);
  if (t.expiresAt) info(`  expires: ${fmtDate(t.expiresAt)}`);
  info(`\n  ${c.bold(t.plaintext)}`);
  warn("Save this token now — it is shown only once.");
}

async function revoke(ctx, appId, args) {
  const keyId = args._[3] || args.keyId;
  if (!keyId) die("Usage: muhkoo tokens revoke <appId> <keyId>");
  ensure(
    await devCall(ctx, "DELETE", `/api/apps/${appId}/access-tokens/${encodeURIComponent(keyId)}`),
    "Revoke token",
  );
  ok(`Revoked token ${keyId}.`);
}

function statusOf(t) {
  if (t.revoked) return c.red("revoked");
  if (t.expired) return c.yellow("expired");
  return c.green("active");
}

function truncate(keyId, n = 20) {
  const s = String(keyId ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function fmtDate(v) {
  if (!v) return "never";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
}
