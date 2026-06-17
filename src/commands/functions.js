/**
 * `muhkoo functions` — list, inspect, remove, and enable/disable serverless
 * functions, plus read deployed source. Deploys happen via `muhkoo provision`.
 */

import { readFile } from "node:fs/promises";
import { devContext } from "../lib/config.js";
import { devCall, ensure } from "../lib/http.js";
import { resolveSpace } from "../lib/spaces.js";
import { table, json, ok, info, die } from "../lib/ui.js";

export const help = `muhkoo functions — manage serverless functions

Usage:
  muhkoo functions ls <appId> [--json]
  muhkoo functions get <appId> <functionId> [--json]
  muhkoo functions code <appId> <functionId>        print the deployed source
  muhkoo functions deploy <appId> --name <n> --file <path> [--http]
  muhkoo functions rm <appId> <functionId>
  muhkoo functions enable  <appId> <functionId> --space <spaceId|#channel>
  muhkoo functions disable <appId> <functionId> --space <spaceId|#channel>`;

export default async function functions(args) {
  const sub = args._[1];
  const ctx = await devContext(args);
  const appId = args._[2] || args.app;
  if (!appId) die("Missing app id. Usage: muhkoo functions <ls|get|code|deploy|rm|enable|disable> <appId>");

  switch (sub) {
    case "ls":
    case undefined:
      return list(ctx, appId, args);
    case "get":
      return get(ctx, appId, args);
    case "code":
      return code(ctx, appId, args);
    case "deploy":
      return deployOne(ctx, appId, args);
    case "rm":
    case "delete":
      return remove(ctx, appId, args);
    case "enable":
      return toggle(ctx, appId, args, "enable");
    case "disable":
      return toggle(ctx, appId, args, "disable");
    default:
      die(`Unknown subcommand "functions ${sub}". See \`muhkoo functions --help\`.`);
  }
}

async function list(ctx, appId, args) {
  const r = ensure(await devCall(ctx, "GET", `/api/apps/${appId}/functions`), "List functions");
  const items = r.body?.functions || [];
  if (args.json) return json(items);
  if (!items.length) return info("No functions. Define them in a provision spec and run `muhkoo provision`.");
  table(
    ["NAME", "FUNCTION ID", "TRIGGERS"],
    items.map((f) => [f.name, f.functionId, Object.keys(f.triggers || {}).join(",") || ""]),
  );
}

async function get(ctx, appId, args) {
  const id = args._[3];
  if (!id) die("Usage: muhkoo functions get <appId> <functionId>");
  const r = ensure(await devCall(ctx, "GET", `/api/apps/${appId}/functions/${id}`), "Get function");
  json(r.body);
}

async function code(ctx, appId, args) {
  const id = args._[3];
  if (!id) die("Usage: muhkoo functions code <appId> <functionId>");
  const r = ensure(await devCall(ctx, "GET", `/api/apps/${appId}/functions/${id}/code`), "Read function code");
  process.stdout.write((r.body?.code ?? "") + "\n");
}

async function deployOne(ctx, appId, args) {
  const name = args.name;
  const file = args.file;
  if (!name || !file) die("Usage: muhkoo functions deploy <appId> --name <n> --file <path> [--http]");
  const source = await readFile(file, "utf8");
  const input = { name, displayName: args.display || name, code: source };
  if (args.http) input.triggers = { http: { enabled: true, methods: ["GET", "POST"] } };
  const list = await devCall(ctx, "GET", `/api/apps/${appId}/functions`);
  const match = (list.ok ? list.body?.functions || [] : []).find((f) => f.name === name);
  const r = match
    ? await devCall(ctx, "PATCH", `/api/apps/${appId}/functions/${match.functionId}`, input)
    : await devCall(ctx, "POST", `/api/apps/${appId}/functions`, input);
  if (r.status === 402) die("Functions need a paid plan.");
  ensure(r, "Deploy function");
  ok(`${match ? "Redeployed" : "Deployed"} ${name} (${r.body.config.functionId}).`);
}

async function remove(ctx, appId, args) {
  const id = args._[3];
  if (!id) die("Usage: muhkoo functions rm <appId> <functionId>");
  ensure(await devCall(ctx, "DELETE", `/api/apps/${appId}/functions/${id}`), "Delete function");
  ok(`Deleted function ${id}.`);
}

async function toggle(ctx, appId, args, action) {
  const id = args._[3];
  if (!id) die(`Usage: muhkoo functions ${action} <appId> <functionId> --space <spaceId|#channel>`);
  const targetSpaceId = await resolveSpace(ctx, args);
  const r = await devCall(ctx, "POST", `/api/apps/${appId}/functions/${id}/${action}`, { targetSpaceId });
  if (r.status === 402) die("Functions need a paid plan.");
  ensure(r, `${action} function`);
  ok(`${action === "enable" ? "Enabled" : "Disabled"} ${id} on ${targetSpaceId}.`);
}
