/**
 * `muhkoo logout` — clear the stored session token (keeps the default base).
 */

import { loadConfig, saveConfig } from "../lib/config.js";
import { ok } from "../lib/ui.js";

export const help = `muhkoo logout — clear the stored session token`;

export default async function logout() {
  const cfg = await loadConfig();
  delete cfg.token;
  delete cfg.username;
  delete cfg.commitment;
  await saveConfig(cfg);
  ok("Signed out.");
}
