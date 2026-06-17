/**
 * `muhkoo agents` — list, inspect, remove, and enable/disable an app's agents.
 * Agents are usually created via `muhkoo provision`; this manages them after.
 */

import { devContext } from "../lib/config.js";
import { devCall, ensure } from "../lib/http.js";
import { resolveSpace } from "../lib/spaces.js";
import { table, json, ok, info, die } from "../lib/ui.js";

export const help = `muhkoo agents — manage programmable agents

Usage:
  muhkoo agents ls <appId> [--json]
  muhkoo agents get <appId> <agentId> [--json]
  muhkoo agents rm <appId> <agentId>
  muhkoo agents enable  <appId> <agentId> --space <spaceId>
  muhkoo agents disable <appId> <agentId> --space <spaceId>
  muhkoo agents models                      list models that support agents`;

export default async function agents(args) {
  const sub = args._[1];
  if (sub === "models") return models(args);
  const ctx = await devContext(args);
  const appId = args._[2] || args.app;
  if (!appId) die("Missing app id. Usage: muhkoo agents <ls|get|rm|enable|disable> <appId>");

  switch (sub) {
    case "ls":
    case undefined:
      return list(ctx, appId, args);
    case "get":
      return get(ctx, appId, args);
    case "rm":
    case "delete":
      return remove(ctx, appId, args);
    case "enable":
      return toggle(ctx, appId, args, "enable");
    case "disable":
      return toggle(ctx, appId, args, "disable");
    default:
      die(`Unknown subcommand "agents ${sub}". See \`muhkoo agents --help\`.`);
  }
}

async function list(ctx, appId, args) {
  const r = ensure(await devCall(ctx, "GET", `/api/apps/${appId}/agents`), "List agents");
  const items = r.body?.agents || [];
  if (args.json) return json(items);
  if (!items.length) return info("No agents. Define them in a provision spec and run `muhkoo provision`.");
  table(
    ["HANDLE", "AGENT ID", "MODEL"],
    items.map((a) => [a.handle, a.agentId, a.model ?? ""]),
  );
}

async function get(ctx, appId, args) {
  const agentId = args._[3];
  if (!agentId) die("Usage: muhkoo agents get <appId> <agentId>");
  const r = ensure(await devCall(ctx, "GET", `/api/apps/${appId}/agents/${agentId}`), "Get agent");
  json(r.body);
}

async function remove(ctx, appId, args) {
  const agentId = args._[3];
  if (!agentId) die("Usage: muhkoo agents rm <appId> <agentId>");
  ensure(await devCall(ctx, "DELETE", `/api/apps/${appId}/agents/${agentId}`), "Delete agent");
  ok(`Deleted agent ${agentId}.`);
}

/** Enable/disable an agent on a Space. `--space` may be a spaceId or `#channel`. */
async function toggle(ctx, appId, args, action) {
  const agentId = args._[3];
  if (!agentId) die(`Usage: muhkoo agents ${action} <appId> <agentId> --space <spaceId|#channel>`);
  const targetSpaceId = await resolveSpace(ctx, args);
  const r = await devCall(ctx, "POST", `/api/apps/${appId}/agents/${agentId}/${action}`, { targetSpaceId });
  if (r.status === 402) die("Agents need a paid plan.");
  ensure(r, `${action} agent`);
  ok(`${action === "enable" ? "Enabled" : "Disabled"} ${agentId} on ${targetSpaceId}.`);
}

async function models(args) {
  const ctx = await devContext(args);
  const r = ensure(await devCall(ctx, "GET", "/api/apps/agent-models"), "Agent models");
  if (args.json) return json(r.body);
  info("Function-calling models (usable by agents):");
  for (const m of r.body?.fnCallingModels || []) info(`  ${m}`);
}
