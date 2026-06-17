/**
 * `muhkoo hosting` — inspect and manage an app's hosted releases.
 */

import { devContext } from "../lib/config.js";
import { devCall, ensure } from "../lib/http.js";
import { table, json, ok, info, die, c } from "../lib/ui.js";

export const help = `muhkoo hosting — manage hosted releases

Usage:
  muhkoo hosting status <appId> [--json]
  muhkoo hosting rollback <appId> --release <releaseId>
  muhkoo hosting rm-release <appId> <releaseId>
  muhkoo hosting unpublish <appId>`;

export default async function hosting(args) {
  const sub = args._[1];
  const ctx = await devContext(args);
  const appId = args._[2] || args.app;
  if (!appId) die("Missing app id. Usage: muhkoo hosting <status|rollback|...> <appId>");

  switch (sub) {
    case "status":
    case undefined:
      return status(ctx, appId, args);
    case "rollback":
      return rollback(ctx, appId, args);
    case "rm-release":
      return rmRelease(ctx, appId, args);
    case "unpublish":
      return unpublish(ctx, appId);
    default:
      die(`Unknown subcommand "hosting ${sub}". See \`muhkoo hosting --help\`.`);
  }
}

async function status(ctx, appId, args) {
  const r = ensure(await devCall(ctx, "GET", `/api/apps/${appId}/hosting`), "Hosting status");
  if (args.json) return json(r.body);
  const h = r.body;
  info(`${c.bold("url")}        ${h.url ?? "(unpublished)"}`);
  info(`${c.bold("published")}  ${h.published ? "yes" : "no"}`);
  if (h.currentReleaseId) info(`${c.bold("current")}    ${h.currentReleaseId}`);
  if (Array.isArray(h.releases) && h.releases.length) {
    info("");
    table(
      ["RELEASE", "FILES", "KiB", "CREATED"],
      h.releases.map((rel) => [
        rel.releaseId + (rel.releaseId === h.currentReleaseId ? " *" : ""),
        rel.files,
        (rel.bytes / 1024).toFixed(0),
        rel.createdAt ? new Date(rel.createdAt).toISOString() : "",
      ]),
    );
  }
}

async function rollback(ctx, appId, args) {
  const releaseId = args.release || args._[3];
  if (!releaseId) die("Usage: muhkoo hosting rollback <appId> --release <releaseId>");
  ensure(await devCall(ctx, "POST", `/api/apps/${appId}/hosting/rollback`, { releaseId }), "Rollback");
  ok(`Rolled back to ${releaseId}.`);
}

async function rmRelease(ctx, appId, args) {
  const releaseId = args._[3];
  if (!releaseId) die("Usage: muhkoo hosting rm-release <appId> <releaseId>");
  ensure(await devCall(ctx, "DELETE", `/api/apps/${appId}/hosting/releases/${releaseId}`), "Delete release");
  ok(`Deleted release ${releaseId}.`);
}

async function unpublish(ctx, appId) {
  ensure(await devCall(ctx, "DELETE", `/api/apps/${appId}/hosting`), "Unpublish");
  ok(`Unpublished ${appId} — the live pointer was removed.`);
}
