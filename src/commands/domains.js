/**
 * `muhkoo domains` — attach and manage custom domains for an app's hosted site.
 * Custom domains require a paid plan. Adding one returns the DNS records to set.
 */

import { devContext } from "../lib/config.js";
import { devCall, ensure } from "../lib/http.js";
import { table, json, ok, info, warn, die, c } from "../lib/ui.js";

export const help = `muhkoo domains — manage custom domains

Usage:
  muhkoo domains ls <appId> [--json]
  muhkoo domains add <appId> <hostname> [--json]
  muhkoo domains rm <appId> <hostname>`;

export default async function domains(args) {
  const sub = args._[1];
  const ctx = await devContext(args);
  const appId = args._[2] || args.app;
  if (!appId) die("Missing app id. Usage: muhkoo domains <ls|add|rm> <appId> [hostname]");

  switch (sub) {
    case "ls":
    case undefined:
      return list(ctx, appId, args);
    case "add":
      return add(ctx, appId, args);
    case "rm":
    case "remove":
      return remove(ctx, appId, args);
    default:
      die(`Unknown subcommand "domains ${sub}". See \`muhkoo domains --help\`.`);
  }
}

async function list(ctx, appId, args) {
  const r = ensure(await devCall(ctx, "GET", `/api/apps/${appId}/hosting/domains`), "List domains");
  if (args.json) return json(r.body);
  const items = r.body?.domains || [];
  if (!items.length) return info("No custom domains. Add one with `muhkoo domains add <appId> <hostname>`.");
  table(
    ["HOSTNAME", "STATUS", "SSL", "VERIFIED"],
    items.map((d) => [d.hostname, d.status ?? "", d.sslStatus ?? "", d.verified ? "yes" : "no"]),
  );
}

async function add(ctx, appId, args) {
  const hostname = args._[3] || args.hostname;
  if (!hostname) die("Usage: muhkoo domains add <appId> <hostname>");
  const r = await devCall(ctx, "POST", `/api/apps/${appId}/hosting/domains`, { hostname });
  if (r.status === 402) die("Custom domains need a paid plan.");
  ensure(r, "Add domain");
  if (args.json) return json(r.body);
  ok(`Attached ${c.bold(hostname)}.`);
  const records = r.body?.records || r.body?.dnsRecords || [];
  if (records.length) {
    info("\nAdd these DNS records at your registrar:");
    table(
      ["TYPE", "NAME", "VALUE"],
      records.map((d) => [d.type, d.name, d.value]),
    );
  }
  warn("SSL is issued after DNS validates — this can take a few minutes.");
}

async function remove(ctx, appId, args) {
  const hostname = args._[3] || args.hostname;
  if (!hostname) die("Usage: muhkoo domains rm <appId> <hostname>");
  ensure(
    await devCall(ctx, "DELETE", `/api/apps/${appId}/hosting/domains/${encodeURIComponent(hostname)}`),
    "Remove domain",
  );
  ok(`Removed ${hostname}.`);
}
