/**
 * `muhkoo logout` — clear the stored session token (keeps the default base).
 */

import { loadConfig, saveConfig } from "../lib/config.js";
import { ok, json } from "../lib/ui.js";
import { resolveBaseUrl } from "../lib/bases.js";

export const help = `muhkoo logout — clear the stored session token`;

export default async function logout(args = {}) {
  const cfg = await loadConfig();
  delete cfg.token;
  delete cfg.username;
  delete cfg.commitment;
  await saveConfig(cfg);
  ok("Signed out.");
  if (args.json) json({ base: resolveBaseUrl(cfg.base), signedOut: true });
}
