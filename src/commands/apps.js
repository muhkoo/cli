/**
 * `muhkoo apps` — list, inspect, create, and delete apps, plus key rotation.
 */

import { devContext } from "../lib/config.js";
import { devCall, ensure } from "../lib/http.js";
import { table, json, ok, step, info, die, warn, c } from "../lib/ui.js";
import { appsSuffixFor } from "../lib/bases.js";

export const help = `muhkoo apps — manage your apps

Usage:
  muhkoo apps ls [--json]
  muhkoo apps get <appId> [--json]
  muhkoo apps create --slug <slug> [--email <e>] [--origins <list>] [--json]
  muhkoo apps slug <slug>                 check whether a slug is available
  muhkoo apps rm <appId>                  delete an app and revoke its keys
  muhkoo keys rotate <appId> [--json]     rotate all four app keys`;

export default async function apps(args) {
  const sub = args._[1];
  const ctx = await devContext(args);
  switch (sub) {
    case "ls":
    case undefined:
      return list(ctx, args);
    case "get":
      return get(ctx, args);
    case "create":
      return create(ctx, args);
    case "slug":
      return slug(ctx, args);
    case "rm":
    case "delete":
      return remove(ctx, args);
    default:
      die(`Unknown subcommand "apps ${sub}". See \`muhkoo apps --help\`.`);
  }
}

async function list(ctx, args) {
  const r = ensure(await devCall(ctx, "GET", "/api/apps"), "List apps");
  const apps = r.body?.apps || r.body || [];
  if (args.json) return json(apps);
  if (!apps.length) return info("No apps yet. Create one with `muhkoo apps create --slug <name>`.");
  table(
    ["SLUG", "APP ID", "ORIGINS"],
    apps.map((a) => [a.slug, a.appId, a.allowedOrigins ?? "*"]),
  );
}

async function get(ctx, args) {
  const appId = args._[2] || args.app;
  if (!appId) die("Usage: muhkoo apps get <appId>");
  const r = ensure(await devCall(ctx, "GET", `/api/apps/${appId}`), "Get app");
  if (args.json) return json(r.body);
  const a = r.body;
  info(`${c.bold("slug")}     ${a.slug}`);
  info(`${c.bold("appId")}    ${a.appId}`);
  info(`${c.bold("origins")}  ${a.allowedOrigins ?? "*"}`);
  info(`${c.bold("hosting")}  https://${a.slug}.${appsSuffixFor(ctx.baseUrl)}`);
  if (Array.isArray(a.keys)) {
    info(`${c.bold("keys")}`);
    for (const k of a.keys) info(`  ${k.env}/${k.type}  ${k.keyId}`);
  }
}

async function create(ctx, args) {
  const slugName = args.slug || args._[2];
  if (!slugName) die("Usage: muhkoo apps create --slug <slug> [--email <e>]");
  const body = { slug: slugName, allowedOrigins: args.origins || "*" };
  if (args.email) body.email = args.email;
  step(`Creating app "${slugName}"…`);
  let r = await devCall(ctx, "POST", "/api/apps", body);
  if (!r.ok && r.status === 402 && args.email) {
    step("Bootstrapping developer account…");
    ensure(await devCall(ctx, "POST", "/api/developer/bootstrap", { email: args.email }), "Bootstrap");
    r = await devCall(ctx, "POST", "/api/apps", body);
  }
  if (!r.ok && r.status === 402) {
    die("This developer account needs a billing email. Re-run with `--email you@example.com`.");
  }
  ensure(r, "Create app");
  if (args.json) return json(r.body);
  const keys = r.body.keys || [];
  ok(`Created ${c.bold(r.body.slug)} (${r.body.appId})`);
  info(`  hosting: https://${r.body.slug}.${appsSuffixFor(ctx.baseUrl)}`);
  info("  keys:");
  for (const k of keys) info(`    ${k.env}/${k.type}  ${k.plaintext}`);
  warn("Save the secret (sk) keys now — they are shown only once.");
}

async function slug(ctx, args) {
  const name = args._[2] || args.slug;
  if (!name) die("Usage: muhkoo apps slug <slug>");
  const r = ensure(
    await devCall(ctx, "GET", `/api/apps/slug-available?slug=${encodeURIComponent(name)}`),
    "Slug check",
  );
  info(r.body?.available ? `${c.green("available")}  ${name}` : `${c.red("taken")}      ${name}`);
}

async function remove(ctx, args) {
  const appId = args._[2] || args.app;
  if (!appId) die("Usage: muhkoo apps rm <appId>");
  ensure(await devCall(ctx, "DELETE", `/api/apps/${appId}`), "Delete app");
  ok(`Deleted app ${appId} and revoked its keys.`);
}

/** `muhkoo keys rotate <appId>` — routed here from index.js. */
export async function keysRotate(args) {
  const ctx = await devContext(args);
  const appId = args._[2] || args.app;
  if (!appId) die("Usage: muhkoo keys rotate <appId>");
  const r = ensure(await devCall(ctx, "POST", `/api/apps/${appId}/keys/rotate`), "Rotate keys");
  if (args.json) return json(r.body);
  ok(`Rotated keys for ${appId} — old keys are now revoked.`);
  for (const k of r.body.keys || []) info(`  ${k.env}/${k.type}  ${k.plaintext}`);
}
