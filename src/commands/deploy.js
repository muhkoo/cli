/**
 * `muhkoo deploy` — deploy a built `dist/` to Muhkoo hosting. Content-addressed:
 * each file uploads by its sha256 (only changed files transfer), then a release
 * is committed (an atomic pointer flip; instant + rollback-able).
 *
 * Auth accepts EITHER an app secret key (--key / $MUHKOO_DEPLOY_KEY) or your
 * developer session (`muhkoo login`). The app id and key are read from
 * .muhkoo-app.json when present, so a provisioned app deploys with no flags.
 */

import { readFile, readdir, stat, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { resolveBase, loadConfig, resolveToken } from "../lib/config.js";
import { skCall, ensure } from "../lib/http.js";
import { firstOf } from "../lib/args.js";
import { step, ok, info, die, redact } from "../lib/ui.js";

export const help = `muhkoo deploy — deploy a built client to Muhkoo hosting

Usage:
  muhkoo deploy [--app <appId>] [--key <mk_*_sk_*>] [--dist dist] [--base <env|url>]

Defaults: --app and --key fall back to .muhkoo-app.json, then $MUHKOO_APP_ID /
$MUHKOO_DEPLOY_KEY. With no app secret key, your developer session is used.`;

async function readRecord() {
  try {
    await access(".muhkoo-app.json");
    return JSON.parse(await readFile(".muhkoo-app.json", "utf8"));
  } catch {
    return null;
  }
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export default async function deploy(args) {
  const cfg = await loadConfig();
  const record = await readRecord();
  const baseUrl = args.base ? await resolveBase(args, cfg) : record?.baseUrl || (await resolveBase(args, cfg));
  const appId = firstOf(args.app, process.env.MUHKOO_APP_ID, record?.appId);
  if (!appId) die("Missing app id. Pass --app <appId>, set MUHKOO_APP_ID, or run from a provisioned app dir.");

  // Auth: an app secret key if available, otherwise the developer session token.
  const skFromRecord = record?.keys?.find((k) => k.type === "sk" && k.env === "test")?.plaintext;
  let auth = firstOf(args.key, process.env.MUHKOO_DEPLOY_KEY, skFromRecord);
  if (auth && !/_sk_/.test(auth)) die("--key must be an app SECRET key (mk_*_sk_*), not a publishable key.");
  if (!auth) auth = await resolveToken(args, cfg); // developer session is accepted by hosting

  const dist = args.dist || "dist";
  let files;
  try {
    if (!(await stat(dist)).isDirectory()) throw new Error();
    files = await walk(dist);
  } catch {
    die(`No build output at "${dist}". Build your client first (or pass --dist).`);
  }
  if (!files.length) die(`"${dist}" is empty.`);

  step(`Deploying ${files.length} files from ${dist}/ → ${baseUrl}`);

  const manifest = {};
  const blobs = new Map();
  for (const file of files) {
    const bytes = await readFile(file);
    const sha = createHash("sha256").update(bytes).digest("hex");
    manifest[relative(dist, file).split(sep).join("/")] = sha;
    if (!blobs.has(sha)) blobs.set(sha, bytes);
  }

  let uploaded = 0;
  let deduped = 0;
  for (const [sha, bytes] of blobs) {
    const r = await skCall(baseUrl, auth, "PUT", `/api/apps/${appId}/hosting/blob/${sha}`, bytes, { raw: true });
    if (!r.ok) die(`Upload failed for ${sha} (${r.status}): ${redact(await r.res.text())}`);
    const body = await r.res.json().catch(() => ({}));
    if (body.dedup) deduped++;
    else uploaded++;
  }
  info(`  ${uploaded} uploaded, ${deduped} unchanged (${blobs.size} unique files)`);

  step("Committing release…");
  const rel = ensure(
    await skCall(baseUrl, auth, "POST", `/api/apps/${appId}/hosting/releases`, { manifest }),
    "Release",
  );
  info("");
  ok("Deployed.");
  info(`  release: ${rel.body.releaseId}`);
  info(`  size:    ${(rel.body.bytes / 1024).toFixed(0)} KiB across ${rel.body.files} files`);
  info(`  live at: ${rel.body.url}`);
}
