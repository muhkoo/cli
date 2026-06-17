/**
 * `muhkoo whoami` — show the signed-in developer (plan, email, base).
 */

import { devContext } from "../lib/config.js";
import { devCall, ensure } from "../lib/http.js";
import { json, info, c } from "../lib/ui.js";

export const help = `muhkoo whoami — show the signed-in developer

Usage:
  muhkoo whoami [--json] [--base <env|url>]`;

export default async function whoami(args) {
  const ctx = await devContext(args);
  const me = ensure(await devCall(ctx, "GET", "/api/developer/me"), "whoami");
  if (args.json) return json({ ...me.body, base: ctx.baseUrl });
  if (me.body?.needsBootstrap) {
    info(`${c.yellow("Developer account not set up yet")} on ${ctx.baseUrl}.`);
    info("Create your first app to bootstrap it: `muhkoo apps create --slug <name> --email <you@x.com>`");
    return;
  }
  info(`${c.bold("base")}   ${ctx.baseUrl}`);
  if (me.body?.email) info(`${c.bold("email")}  ${me.body.email}`);
  if (me.body?.tier) info(`${c.bold("plan")}   ${me.body.tier}`);
}
