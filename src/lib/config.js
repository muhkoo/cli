/**
 * Persistent CLI config at `~/.muhkoo/config.json`. Holds the developer session
 * token and the default API base, written by `muhkoo login`. Every value can be
 * overridden per-invocation by a flag or environment variable.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir, rename, chmod } from "node:fs/promises";
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
  // The config holds a session token, so it must never be world-readable —
  // not even briefly. Create the dir owner-only, write to a temp file with
  // mode 0o600, then atomically rename it into place (the renamed file keeps
  // its restrictive perms, with no truncation/permission window).
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await chmod(configDir(), 0o700).catch(() => {}); // tighten an existing dir
  const tmp = join(configDir(), `.config.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, configPath());
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
