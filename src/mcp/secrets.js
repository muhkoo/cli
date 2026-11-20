/**
 * Keep secrets out of tool results.
 *
 * A tool result goes into a conversation and from there to a model, so an sk
 * key, an access token or a session token in one is a leak. Tools that create
 * a secret (apps create, provision, keys rotate, tokens create) save it to an
 * owner-only file, and the result says where, with a masked prefix. pk keys
 * are publishable and are returned: Claude needs them to write client code.
 *
 * `scrub` is the backstop over every result. It masks secret-shaped keys, the
 * credentials this machine holds, and fields named like credentials. It does
 * NOT mask long hex strings in general: commit ids and content hashes are
 * exactly that shape, and the vcs/vfs tools exist to show them.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, chmod, readFile, writeFile } from "node:fs/promises";

/** Secret key shapes. pk keys are not secrets and are deliberately absent. */
export const SECRET_PATTERNS = [/mk_[a-z0-9]+_sk_[A-Za-z0-9_-]{6,}/i, /mk_[a-z0-9]+_at_[A-Za-z0-9_-]{6,}/i];
const SECRET_GLOBAL = SECRET_PATTERNS.map((re) => new RegExp(re.source, "gi"));
const CREDENTIAL_FIELDS = new Set(["token", "sessionToken", "deviceKey", "seed", "password"]);
const REDACTED = "[redacted]";

const mask = (secret) => `${secret.slice(0, 11)}…`;

/** Where secrets go when there is no project record: `~/.muhkoo/secrets` (or $MUHKOO_SECRETS_DIR). */
export function defaultSecretsDir() {
  return process.env.MUHKOO_SECRETS_DIR || join(homedir(), ".muhkoo", "secrets");
}

async function writePrivate(path, text) {
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600); // tighten a file that already existed
}

async function privateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function readRecord(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

const isSecretKey = (k) => k && typeof k === "object" && typeof k.plaintext === "string" && k.type !== "pk";

/**
 * Save the secrets in a tool's result and return the result without them.
 *
 * @param {string} tool the tool name
 * @param {unknown} data the CLI's parsed result
 * @param {{ projectDir?: string, secretsDir?: string }} [ctx]
 */
export async function sealSecrets(tool, data, { projectDir, secretsDir = defaultSecretsDir() } = {}) {
  if (!data || typeof data !== "object") return data;

  // A new access token: the whole result is the token.
  if (tool === "tokens_create" && typeof data.plaintext === "string") {
    await privateDir(secretsDir);
    const path = join(secretsDir, `token-${safeName(data.keyId ?? "new")}.txt`);
    await writePrivate(path, data.plaintext + "\n");
    const { plaintext, ...rest } = data;
    return { ...rest, masked: mask(plaintext), savedTo: path };
  }

  const keys = Array.isArray(data.keys) ? data.keys : null;
  if (!keys || !keys.some(isSecretKey)) return data;

  const savedTo = await saveKeys(tool, data, keys, { projectDir, secretsDir });
  return {
    ...data,
    keys: keys.map((k) => {
      if (!isSecretKey(k)) return k;
      const { plaintext, ...rest } = k;
      return { ...rest, masked: mask(plaintext), savedTo };
    }),
  };
}

/** Write the keys somewhere owner-only and return the path. */
async function saveKeys(tool, data, keys, { projectDir, secretsDir }) {
  // provision has already written them, owner-only, into its record.
  if (tool === "provision" && typeof data.recordPath === "string") return data.recordPath;

  if (projectDir) {
    const recordPath = join(projectDir, ".muhkoo-app.json");
    const record = await readRecord(recordPath);
    if (record && (!record.appId || !data.appId || record.appId === data.appId)) {
      await writePrivate(recordPath, JSON.stringify({ ...record, keys }, null, 2) + "\n");
      return recordPath;
    }
  }

  await privateDir(secretsDir);
  const path = join(secretsDir, `${safeName(data.appId ?? "app")}-keys.json`);
  await writePrivate(path, JSON.stringify({ appId: data.appId, slug: data.slug, keys }, null, 2) + "\n");
  return path;
}

const safeName = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, "_");

/**
 * Mask every secret left anywhere in `data`.
 *
 * @param {unknown} data
 * @param {{ known?: string[] }} [opts] exact credential values to mask (the stored session token, device key)
 */
export function scrub(data, { known = [] } = {}) {
  const exact = known.filter((v) => typeof v === "string" && v.length >= 16);
  const text = (s) => {
    let out = s;
    for (const re of SECRET_GLOBAL) out = out.replace(re, (m) => mask(m));
    for (const v of exact) out = out.split(v).join(REDACTED);
    return out;
  };
  const walk = (v, key) => {
    if (key !== undefined && CREDENTIAL_FIELDS.has(key) && v != null && v !== "") return REDACTED;
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(data);
}
