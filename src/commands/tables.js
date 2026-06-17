/**
 * `muhkoo tables` — inspect and remove an app's database tables. Tables are
 * usually created via `muhkoo provision`; this is for listing and teardown.
 */

import { devContext } from "../lib/config.js";
import { devCall, ensure } from "../lib/http.js";
import { table, json, ok, info, die } from "../lib/ui.js";

export const help = `muhkoo tables — inspect app database tables

Usage:
  muhkoo tables ls <appId> [--json]
  muhkoo tables get <appId> <table> [--json]
  muhkoo tables rm <appId> <table>`;

export default async function tables(args) {
  const sub = args._[1];
  const ctx = await devContext(args);
  const appId = args._[2] || args.app;
  if (!appId) die("Missing app id. Usage: muhkoo tables <ls|get|rm> <appId> [table]");

  switch (sub) {
    case "ls":
    case undefined:
      return list(ctx, appId, args);
    case "get":
      return get(ctx, appId, args);
    case "rm":
    case "delete":
      return remove(ctx, appId, args);
    default:
      die(`Unknown subcommand "tables ${sub}". See \`muhkoo tables --help\`.`);
  }
}

async function list(ctx, appId, args) {
  const r = ensure(await devCall(ctx, "GET", `/api/apps/${appId}/db/tables`), "List tables");
  const items = r.body?.tables || r.body || [];
  if (args.json) return json(items);
  if (!items.length) return info("No tables. Define them in a provision spec and run `muhkoo provision`.");
  table(
    ["TABLE", "COLUMNS", "VERSION"],
    items.map((t) => [t.table ?? t.name, (t.columns || []).length, t.version ?? ""]),
  );
}

async function get(ctx, appId, args) {
  const name = args._[3];
  if (!name) die("Usage: muhkoo tables get <appId> <table>");
  const r = ensure(await devCall(ctx, "GET", `/api/apps/${appId}/db/tables/${encodeURIComponent(name)}`), "Get table");
  json(r.body);
}

async function remove(ctx, appId, args) {
  const name = args._[3];
  if (!name) die("Usage: muhkoo tables rm <appId> <table>");
  ensure(await devCall(ctx, "DELETE", `/api/apps/${appId}/db/tables/${encodeURIComponent(name)}`), "Delete table");
  ok(`Deleted table ${name}.`);
}
