/**
 * Persistent CLI config at `~/.muhkoo/config.json`. Holds the developer session
 * token and the default API base, written by `muhkoo login`. Every value can be
 * overridden per-invocation by a flag or environment variable.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { resolveBaseUrl } from "./bases.js";
import { firstOf } from "./args.js";
import { die } from "./ui.js";

export function configDir() {
  return join(homedir(), ".muhkoo");
}
export function configPath() {
  return join(configDir(), "config.json");
}

export async function loadConfig() {
  try {
    return JSON.parse(await readFile(configPath(), "utf8"));
  } catch {
    return {};
  }
}

export async function saveConfig(next) {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(next, null, 2) + "\n");
  // Contains a session token — keep it owner-only.
  await chmod(configPath(), 0o600).catch(() => {});
}

/**
 * Resolve the API base URL for this invocation:
 *   --base flag → $MUHKOO_API_BASE → stored config → prod
 */
export async function resolveBase(args, cfg) {
  cfg = cfg ?? (await loadConfig());
  return resolveBaseUrl(firstOf(args.base, process.env.MUHKOO_API_BASE, cfg.base, "prod"));
}

/**
 * Resolve a developer session token:
 *   --token flag → $MUHKOO_DEV_TOKEN → stored config token
 * Exits with a clear hint if none is found.
 */
export async function resolveToken(args, cfg) {
  cfg = cfg ?? (await loadConfig());
  const token = firstOf(args.token, process.env.MUHKOO_DEV_TOKEN, cfg.token);
  if (!token) {
    die(
      "Not signed in. Run `muhkoo login`, or pass `--token <sessionToken>` " +
        "(or set MUHKOO_DEV_TOKEN). Copy a token from the portal after signing in.",
    );
  }
  return token;
}

/** Build the `{ baseUrl, token }` context that dev-session commands need. */
export async function devContext(args) {
  const cfg = await loadConfig();
  return { baseUrl: await resolveBase(args, cfg), token: await resolveToken(args, cfg) };
}
