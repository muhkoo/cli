/**
 * `muhkoo logs` — inspect an app's server-log Space.
 *
 * Logs are end-to-end encrypted to the app owner's identity. This command shows
 * the log Space and recent (still-encrypted) history so you can confirm logging
 * is wired up and flowing. Decrypted, live tailing currently lives in the portal
 * Tools panel; CLI-side decryption is a planned follow-up.
 */

import { devContext } from "../lib/config.js";
import { devCall, ensure } from "../lib/http.js";
import { json, info, warn, die, c } from "../lib/ui.js";

export const help = `muhkoo logs — inspect an app's server-log Space

Usage:
  muhkoo logs <appId> [--env live|test] [--limit 50] [--json]

Note: log entries are E2E-encrypted to the owner. This shows the log Space and
recent ciphertext; decrypted viewing is in the portal Tools panel for now.`;

export default async function logs(args) {
  const ctx = await devContext(args);
  const appId = args._[1] || args.app;
  if (!appId) die("Usage: muhkoo logs <appId>");
  const env = args.env || "live";
  const limit = args.limit || 50;

  const space = ensure(
    await devCall(ctx, "GET", `/api/apps/${appId}/logs/space?env=${env}`),
    "Log space",
  );
  const hist = ensure(
    await devCall(ctx, "GET", `/api/apps/${appId}/logs/history?env=${env}&limit=${limit}`),
    "Log history",
  );

  if (args.json) return json({ space: space.body, history: hist.body });

  const entries = hist.body?.messages || hist.body?.entries || [];
  info(`${c.bold("log space")}  ${space.body?.spaceId ?? "(not provisioned yet)"}`);
  info(`${c.bold("env")}        ${env}`);
  info(`${c.bold("entries")}    ${entries.length} (encrypted)`);
  warn("Entries are E2E-encrypted. View decrypted logs in the portal → Tools → Logs.");
}
