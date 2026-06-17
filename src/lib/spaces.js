/**
 * Resolve a `--space` / `--channel` flag to a concrete spaceId.
 *
 * A raw spaceId is returned as-is. A channel name (via `--channel`, or a
 * `--space #name`) is resolved through the app-key channel registry, which needs
 * a publishable key — read from the local `.muhkoo-app.json` written by
 * `muhkoo provision`. If no pk is available, the caller must pass a spaceId.
 */

import { readFile, access } from "node:fs/promises";
import { appKeyGet } from "./http.js";
import { die } from "./ui.js";

async function recordPk() {
  try {
    await access(".muhkoo-app.json");
    const rec = JSON.parse(await readFile(".muhkoo-app.json", "utf8"));
    return (rec.keys || []).find((k) => k.env === "test" && k.type === "pk")?.plaintext || null;
  } catch {
    return null;
  }
}

export async function resolveSpace(ctx, args) {
  const space = args.space;
  const channel =
    args.channel || (typeof space === "string" && space.startsWith("#") ? space.slice(1) : null);
  if (space && !channel) return space;
  if (!channel) die("Pass --space <spaceId> or --channel <name>.");

  const pk = await recordPk();
  if (!pk) {
    die(
      `Can't resolve channel "${channel}" without a publishable key. ` +
        "Run from a provisioned app dir (.muhkoo-app.json), or pass --space <spaceId>.",
    );
  }
  const res = await appKeyGet(ctx.baseUrl, pk, `/api/app/channels/${encodeURIComponent(channel)}`);
  if (!res?.spaceId) die(`Channel "${channel}" not found — run the app once so it exists, then retry.`);
  return res.spaceId;
}
