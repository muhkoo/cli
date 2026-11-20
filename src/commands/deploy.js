/**
 * `muhkoo deploy` — deploy a built `dist/` to Muhkoo hosting. Content-addressed:
 * each file uploads by its sha256 (only changed files transfer), then a release
 * is committed (an atomic pointer flip; instant + rollback-able).
 *
 * Once the release is live, it copies the project into the deployer's
 * filesystem at /apps/<slug>, where the IDE opens it (`copyToFilesystem`).
 * `--no-vfs` skips that.
 *
 * Auth accepts EITHER an app secret key (--key / $MUHKOO_DEPLOY_KEY) or your
 * developer session (`muhkoo login`). The app id and key are read from
 * .muhkoo-app.json when present, so a provisioned app deploys with no flags.
 */

import { readFile, readdir, stat, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import { resolveBase, loadConfig, resolveToken } from "../lib/config.js";
import { resolveBaseUrl } from "../lib/bases.js";
import { skCall, devCall, ensure } from "../lib/http.js";
import { firstOf } from "../lib/args.js";
import { step, ok, info, warn, die, redact, json, isJsonMode } from "../lib/ui.js";

export const help = `muhkoo deploy — deploy a built client to Muhkoo hosting

Usage:
  muhkoo deploy [--app <appId>] [--key <mk_*_sk_*>] [--dist dist] [--base <env|url>] [--prod] [--no-vfs]

Deploys go to the app's test environment. Check it there, then run
\`muhkoo promote\` to put it into production, or deploy straight to production
with --prod.

Defaults: --app and --key fall back to .muhkoo-app.json (its test secret key,
or its live one with --prod), then $MUHKOO_APP_ID / $MUHKOO_DEPLOY_KEY. With no
app secret key, your developer session is used.

Once the release is live, deploy copies the folder you ran it from into your
filesystem at /apps/<slug>, where the IDE opens it. It is the copy
\`muhkoo vfs import . --path /apps/<slug>\` makes, under the same ignore rules
(see \`muhkoo vfs --help\`): only files changed here upload, and it never
deletes. It needs you signed in to the same environment (\`muhkoo login\`) and
this machine paired, or a terminal to pair it in; without them it says why and
skips. A skipped or failed copy is a warning, printed again in the closing
summary, because the deploy has already succeeded. Storage for the copy is
billed to your account, like the rest of your filesystem; no app key is used.

  --prod     deploy to production instead of test (needs the app's live
             secret key or your developer session)
  --no-vfs   deploy only; skip the copy`;

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

  // Deploys go to the app's TEST environment. Production needs --prod, and a
  // key for it: the app's live secret key, or your developer session.
  const prod = Boolean(args.prod);
  // Under the MCP server (no terminal), deploy must only ever reach TEST:
  // production is `promote`, which the client asks about first.
  const unattended = process.env.MUHKOO_NONINTERACTIVE === "1";
  if (unattended && prod) die("Under the MCP server, deploy only deploys to test. Use promote to reach production.");

  // Auth: an app secret key if available, otherwise the developer session token.
  const skFromRecord = record?.keys?.find((k) => k.type === "sk" && k.env === (prod ? "live" : "test"))?.plaintext;
  let auth = firstOf(args.key, process.env.MUHKOO_DEPLOY_KEY, skFromRecord);
  if (auth && !/_sk_/.test(auth)) die("--key must be an app SECRET key (mk_*_sk_*), not a publishable key.");
  if (auth && !prod && !/_test_sk_/.test(auth)) {
    die(
      unattended
        ? "Under the MCP server, deploy only deploys to test: use the app's TEST secret key (mk_test_sk_…). Use promote to reach production."
        : "That is a live secret key, which deploys straight to production. Pass --prod to do that, or use the app's test secret key (mk_test_sk_…).",
    );
  }
  if (auth && prod && /_test_sk_/.test(auth)) {
    die("--prod needs the app's live secret key (mk_live_sk_…) or your developer session; a test key only deploys to test.");
  }
  if (!auth) auth = await resolveToken(args, cfg); // developer session is accepted by hosting
  const viaKey = /_sk_/.test(auth ?? "");
  // A secret key carries its environment; a session goes to live unless asked for test.
  const envQuery = !viaKey && !prod ? "?env=test" : "";
  const deployEnv = prod ? "live" : "test";

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
    const r = await skCall(baseUrl, auth, "PUT", `/api/apps/${appId}/hosting/blob/${sha}${envQuery}`, bytes, { raw: true });
    if (!r.ok) die(`Upload failed for ${sha} (${r.status}): ${redact(await r.res.text())}`);
    const body = await r.res.json().catch(() => ({}));
    if (body.dedup) deduped++;
    else uploaded++;
  }
  info(`  ${uploaded} uploaded, ${deduped} unchanged (${blobs.size} unique files)`);

  step("Committing release…");
  const rel = ensure(
    await skCall(baseUrl, auth, "POST", `/api/apps/${appId}/hosting/releases${envQuery}`, { manifest }),
    "Release",
  );
  info("");
  ok("Deployed.");
  info(`  env:     ${deployEnv === "live" ? "production" : "test"}${deployEnv === "test" ? " (muhkoo promote puts it into production)" : ""}`);
  info(`  release: ${rel.body.releaseId}`);
  info(`  size:    ${(rel.body.bytes / 1024).toFixed(0)} KiB across ${rel.body.files} files`);
  info(`  url:     ${rel.body.url}`);

  let warnings = [];
  if (!args["no-vfs"]) {
    warnings = await copyToFilesystem({ args, cfg, record, baseUrl, appId });
    // Said once where it happened and again here, because the copy's output
    // sits above the release details and is easy to scroll past.
    if (warnings.length) {
      info("");
      warn("Deployed, but the project was not copied to your filesystem:", ...warnings);
    }
  }
  if (args.json) {
    json({
      appId,
      base: baseUrl,
      env: deployEnv,
      releaseId: rel.body.releaseId,
      bytes: rel.body.bytes,
      files: rel.body.files,
      url: rel.body.url,
      filesystem: { copied: !args["no-vfs"] && warnings.length === 0, warnings },
    });
  }
}

/**
 * Copy the project into the deployer's filesystem at /apps/<slug>, where the
 * portal's "Open in IDE" looks for it, by running `muhkoo vfs import` on the
 * folder deploy ran from.
 *
 * Best effort by design. The site is already live when this runs, so every
 * reason not to copy is one warning, and a failed copy is a warning, never a
 * failed deploy. Resolves to the warning lines, for the closing summary.
 *
 * Import runs in a child process, not in this one, because its failure paths
 * `die()`, which exits the process: an expired session or a revoked pairing
 * would otherwise turn a deploy that succeeded into exit 1.
 */
export async function copyToFilesystem(ctx, { run = runImport } = {}) {
  const plan = await planCopy(ctx);
  if (plan.skip) {
    info("");
    warn(plan.skip);
    return [plan.skip];
  }
  info("");
  step(`Copying the project to ${plan.root} in your filesystem (--no-vfs skips this)…`);
  const code = await run(plan);
  if (code === 0) return [];
  const lines = [
    `The site is live, but copying the project to ${plan.root} failed (see above).`,
    `Retry with: muhkoo vfs import . --path ${plan.root}`,
  ];
  warn(...lines);
  return lines;
}

/**
 * Whether and how to copy: `{ skip }`, the line to print instead, or
 * `{ dir, root, base, token }` for `runImport`.
 *
 * Everything that can be checked without unlocking is checked here, so a
 * deploy from CI (an app key and no login), from a login to the other
 * environment, or from a machine that cannot pair without a terminal says so
 * in one line instead of starting an import that can only fail.
 */
export async function planCopy({
  args,
  cfg,
  record,
  baseUrl,
  appId,
  dir = process.cwd(),
  env = process.env,
  interactive = Boolean(process.stdin.isTTY),
}) {
  const notCopied = "so the project was not copied to your filesystem";

  // The session the import runs on. One passed explicitly is taken to be for
  // the base being deployed to; the stored one belongs to the base `muhkoo
  // login` signed in at, and there is only ever one.
  const explicit = firstOf(args.token, env.MUHKOO_DEV_TOKEN);
  const token = firstOf(explicit, cfg.token);
  if (!token) return { skip: `Not signed in, ${notCopied}. Run \`muhkoo login\` and deploy again to copy it.` };
  if (!explicit) {
    const signedInAt = resolveBaseUrl(cfg.base);
    if (trimSlash(signedInAt) !== trimSlash(baseUrl)) {
      return { skip: `Signed in to ${signedInAt}, not ${baseUrl}, ${notCopied}.` };
    }
  }

  // The app's own slug, from the server: the IDE reads /apps/<slug>, whatever
  // the folder is called (muhkoo.com deploys from a folder named `website`).
  // A record for this same app stands in when the lookup fails.
  const sameApp = Boolean(record) && record.appId === appId;
  const found = await devCall({ baseUrl, token }, "GET", `/api/apps/${appId}`).catch(() => null);
  const slug = (found?.ok && found.body?.slug) || (sameApp && record.slug) || null;
  if (!slug) {
    return { skip: `Could not look up the app's slug${found ? ` (${found.status})` : ""}, ${notCopied}.` };
  }
  const root = `/apps/${slug}`;

  // Unlocking needs MUHKOO_SEED, this machine's pairing, or a terminal to
  // sign in and pair from.
  const paired = Boolean(cfg.deviceFactorId && cfg.deviceKey && cfg.username);
  if (!env.MUHKOO_SEED && !paired && !interactive) {
    return {
      skip: `This machine is not paired, ${notCopied}. Run \`muhkoo vfs import . --path ${root}\` once in a terminal to pair it.`,
    };
  }

  // Storage is billed to the signed-in account, so there is no key to find.
  return { dir, root, base: baseUrl, token };
}

/** Run `muhkoo vfs import <dir> --path <root>` as a child process; resolves to its exit code. */
function runImport({ dir, root, base, token }) {
  const bin = fileURLToPath(new URL("../../bin/muhkoo.js", import.meta.url));
  return new Promise((done) => {
    const child = spawn(process.execPath, [bin, "vfs", "import", dir, "--path", root, "--base", base], {
      // Under --json our stdout is the one result object, so the copy's
      // output goes to stderr with the rest of the progress.
      stdio: isJsonMode() ? ["ignore", 2, 2] : "inherit",
      // The session checked above, in the environment rather than argv so it
      // does not show in the process list.
      env: { ...process.env, MUHKOO_DEV_TOKEN: token },
    });
    child.on("error", () => done(1));
    child.on("exit", (code) => done(code ?? 1));
  });
}

function trimSlash(url) {
  return String(url).replace(/\/+$/, "");
}
