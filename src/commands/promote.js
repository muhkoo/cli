/**
 * `muhkoo promote` — promote an app's TEST environment to PRODUCTION, in place.
 *
 * `muhkoo deploy` publishes to the app's TEST hosting; once it looks good, this
 * copies the test hosting release (and functions) onto the SAME app's prod env,
 * so the live app starts running what you tested. Production DATA is never
 * touched, and app config (CORS origins + redirect URIs) is per-env by design,
 * so it is intentionally NOT promoted.
 *
 * Owner-only: authenticates with your developer session (`muhkoo login`), not an
 * app key. The app id falls back to .muhkoo-app.json, so a provisioned app dir
 * promotes with no flags.
 */

import { readFile, access } from "node:fs/promises";
import { loadConfig, resolveBase, resolveToken } from "../lib/config.js";
import { devCall, ensure } from "../lib/http.js";
import { firstOf } from "../lib/args.js";
import { step, ok, info, die, c } from "../lib/ui.js";

export const help = `muhkoo promote — promote an app's TEST hosting to PRODUCTION

Usage:
  muhkoo promote [<appId>] [--base <env|url>]

Promotes the app's test hosting release + functions onto its prod environment,
in place (an atomic pointer flip — instant and rollback-able). Production data
is never touched; per-env app config (CORS + redirect URIs) is not promoted.

Owner-only: uses your developer session (run \`muhkoo login\` first). The app id
falls back to .muhkoo-app.json / $MUHKOO_APP_ID.`;

async function readRecord() {
  try {
    await access(".muhkoo-app.json");
    return JSON.parse(await readFile(".muhkoo-app.json", "utf8"));
  } catch {
    return null;
  }
}

export default async function promote(args) {
  const cfg = await loadConfig();
  const record = await readRecord();
  const appId = firstOf(args._[1], args.app, process.env.MUHKOO_APP_ID, record?.appId);
  if (!appId) die("Missing app id. Pass `muhkoo promote <appId>`, set MUHKOO_APP_ID, or run from a provisioned app dir.");

  // Prefer an explicit --base, else the app's recorded base, else the default.
  const baseUrl = args.base ? await resolveBase(args, cfg) : record?.baseUrl || (await resolveBase(args, cfg));
  const ctx = { baseUrl, token: await resolveToken(args, cfg) };

  step(`Promoting ${appId} — test → production on ${baseUrl}`);
  const r = ensure(await devCall(ctx, "POST", `/api/apps/${appId}/promote`), "Promote");
  const { report = {}, errors = [] } = r.body || {};

  if (args.json) {
    info("");
    console.log(JSON.stringify(r.body, null, 2));
  } else {
    info("");
    ok("Promoted test → production.");
    if (report.hosting) info(`  ${c.bold("hosting")}    ${report.hosting}`);
    if (report.functions) info(`  ${c.bold("functions")}  ${report.functions}`);
    if (report.config) info(`  ${c.bold("config")}     ${report.config}`);
  }

  if (Array.isArray(errors) && errors.length) {
    info("");
    for (const e of errors) info(c.yellow(`  ! ${e}`));
    // Partial promote (e.g. a function failed) — signal non-zero so CI notices.
    process.exitCode = 1;
  }
}
