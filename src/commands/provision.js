/**
 * `muhkoo provision` — create or update an app's backend from a design spec
 * (tables, agents, functions), then optionally enable agents/functions on their
 * channels. Idempotent: re-running updates rather than duplicating. Writes the
 * app id + issued keys to an output file so re-runs and deploys can read them.
 *
 * Spec (JSON):
 *   {
 *     "slug": "team-standup",
 *     "allowedOrigins": "*",
 *     "email": "you@example.com",            // only to bootstrap a new developer
 *     "tables":    [ <DbTableSpec>, ... ],
 *     "agents":    [ { ...AgentCreateInput, "enableChannel": "general" }, ... ],
 *     "functions": [ { ...FunctionDeployInput, "enableChannel": "general"? }, ... ]
 *   }
 */

import { readFile, writeFile, access, chmod } from "node:fs/promises";
import { devContext } from "../lib/config.js";
import { devCall, appKeyGet } from "../lib/http.js";
import { appsSuffixFor } from "../lib/bases.js";
import { step, ok, warn, info, die, c } from "../lib/ui.js";

export const help = `muhkoo provision — provision an app backend from a spec

Usage:
  muhkoo provision --spec app.json [--out .muhkoo-app.json] [--dry-run]
  muhkoo provision --spec app.json --enable        enable agents/functions on channels

Auth: a developer session (run \`muhkoo login\`, or pass --token / set MUHKOO_DEV_TOKEN).`;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function writeJson(path, obj) {
  // .muhkoo-app.json carries the app's secret (sk) keys — keep it owner-only.
  await writeFile(path, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {}); // tighten if the file already existed
}
async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export default async function provision(args) {
  if (!args.spec) die("Missing --spec <file.json>.");
  const DRY = !!args["dry-run"];
  const OUT = args.out || ".muhkoo-app.json";
  const spec = await readJson(args.spec);
  const prior = (await fileExists(OUT)) ? await readJson(OUT) : null;
  const ctx = await devContext(args);
  info(`API base: ${ctx.baseUrl}${DRY ? "   (dry run)" : ""}\n`);

  if (args.enable) {
    if (!prior?.appId) die(`--enable needs a prior ${OUT} from a provisioning run.`);
    await enableOnChannels(ctx, prior);
    ok("Done.");
    return;
  }

  await ensureDeveloper(ctx, spec.email, DRY);
  const app = await createOrReuseApp(ctx, spec, prior, DRY);
  const tables = await putTables(ctx, app.appId, spec.tables, DRY);
  const agents = await createAgents(ctx, app.appId, spec.agents, DRY);
  const functions = await deployFunctions(ctx, app.appId, spec.functions, DRY);

  const hostingUrl = `https://${app.slug}.${appsSuffixFor(ctx.baseUrl)}`;
  const record = {
    appId: app.appId,
    slug: app.slug,
    baseUrl: ctx.baseUrl,
    hostingUrl,
    keys: app.keys?.length ? app.keys : prior?.keys || [],
    tables,
    agents,
    functions,
  };
  if (!DRY) await writeJson(OUT, record);

  const pk = record.keys.find((k) => k.env === "test" && k.type === "pk")?.plaintext;
  info("");
  ok("Provisioned.");
  info(`  appId:   ${record.appId}`);
  info(`  slug:    ${record.slug}`);
  if (pk) info(`  test pk: ${pk}`);
  info(`  tables:  ${tables.join(", ") || "(none)"}`);
  info(`  hosting: ${hostingUrl}  (run \`muhkoo deploy\` once your client is built)`);
  if ((agents || []).some((a) => a.enableChannel) || (functions || []).some((f) => f.enableChannel)) {
    info("\nNext: run the app once so its channels exist, then:");
    info(`  muhkoo provision --spec ${args.spec} --enable`);
  }
}

async function ensureDeveloper(ctx, email, DRY) {
  const me = await devCall(ctx, "GET", "/api/developer/me");
  if (me.ok && !me.body?.needsBootstrap) return;
  if (!email) {
    die('Developer account not set up. Add an "email" to the spec to bootstrap it.');
  }
  step(`Bootstrapping developer account (${email})…`);
  if (DRY) return;
  const r = await devCall(ctx, "POST", "/api/developer/bootstrap", { email });
  if (!r.ok) die(`Developer bootstrap failed (${r.status}): ${JSON.stringify(r.body)}`);
}

async function createOrReuseApp(ctx, spec, prior, DRY) {
  if (prior?.appId) {
    step(`Reusing existing app ${prior.slug} (${prior.appId}).`);
    return prior;
  }
  step(`Creating app "${spec.slug}"…`);
  if (DRY) return { appId: "<dry-run>", slug: spec.slug, keys: [] };
  const body = { slug: spec.slug, allowedOrigins: spec.allowedOrigins || "*" };
  if (spec.email) body.email = spec.email;
  let r = await devCall(ctx, "POST", "/api/apps", body);
  if (!r.ok && r.status === 402 && spec.email) {
    await ensureDeveloper(ctx, spec.email, DRY);
    r = await devCall(ctx, "POST", "/api/apps", body);
  }
  if (!r.ok) die(`Create app failed (${r.status}): ${JSON.stringify(r.body)}`);
  const keys = r.body.keys || [];
  const pk = keys.find((k) => k.env === "test" && k.type === "pk")?.plaintext;
  info(`  ${c.green("✓")} appId ${r.body.appId}` + (pk ? `   test pk ${pk.slice(0, 18)}…` : ""));
  return { appId: r.body.appId, slug: r.body.slug, keys };
}

async function putTables(ctx, appId, tables, DRY) {
  const done = [];
  for (const spec of tables || []) {
    step(`Table "${spec.table}" (${(spec.columns || []).length} cols)…`);
    if (DRY) {
      done.push(spec.table);
      continue;
    }
    const r = await devCall(ctx, "PUT", `/api/apps/${appId}/db/tables/${encodeURIComponent(spec.table)}`, spec);
    if (!r.ok) die(`Table "${spec.table}" failed (${r.status}): ${JSON.stringify(r.body)}`);
    info(`  ${c.green("✓")} ${spec.table}${r.body?.version ? ` v${r.body.version}` : ""}`);
    done.push(spec.table);
  }
  return done;
}

async function createAgents(ctx, appId, agents, DRY) {
  const created = [];
  if (!(agents || []).length) return created;
  const list = await devCall(ctx, "GET", `/api/apps/${appId}/agents`);
  const existing = list.ok ? list.body?.agents || [] : [];
  for (const a of agents) {
    const { enableChannel, ...input } = a;
    step(`Agent ${input.handle}…`);
    if (DRY) {
      created.push({ handle: input.handle, enableChannel });
      continue;
    }
    const match = existing.find((e) => e.handle === input.handle);
    const r = match
      ? await devCall(ctx, "PATCH", `/api/apps/${appId}/agents/${match.agentId}`, input)
      : await devCall(ctx, "POST", `/api/apps/${appId}/agents`, input);
    if (r.status === 402) {
      warn(`Agents need a paid plan — skipped ${input.handle}. (Config saved for later.)`);
      created.push({ handle: input.handle, enableChannel, skipped: "paid-tier", input });
      continue;
    }
    if (!r.ok) die(`Agent ${input.handle} failed (${r.status}): ${JSON.stringify(r.body)}`);
    const agentId = r.body.config.agentId;
    info(`  ${c.green("✓")} ${input.handle} (${agentId})${match ? " [updated]" : ""}`);
    created.push({ handle: input.handle, agentId, enableChannel });
  }
  return created;
}

async function deployFunctions(ctx, appId, fns, DRY) {
  const deployed = [];
  if (!(fns || []).length) return deployed;
  const list = await devCall(ctx, "GET", `/api/apps/${appId}/functions`);
  const existing = list.ok ? list.body?.functions || [] : [];
  for (const f of fns) {
    const { enableChannel, ...input } = f;
    step(`Function ${input.name}…`);
    if (DRY) {
      deployed.push({ name: input.name, enableChannel });
      continue;
    }
    const match = existing.find((e) => e.name === input.name);
    const r = match
      ? await devCall(ctx, "PATCH", `/api/apps/${appId}/functions/${match.functionId}`, input)
      : await devCall(ctx, "POST", `/api/apps/${appId}/functions`, input);
    if (r.status === 402) {
      warn(`Functions need a paid plan — skipped ${input.name}. (Config saved for later.)`);
      deployed.push({ name: input.name, enableChannel, skipped: "paid-tier", input });
      continue;
    }
    if (!r.ok) die(`Function ${input.name} failed (${r.status}): ${JSON.stringify(r.body)}`);
    const functionId = r.body.config.functionId;
    info(`  ${c.green("✓")} ${input.name} (${functionId})${match ? " [redeployed]" : ""}`);
    deployed.push({ name: input.name, functionId, enableChannel });
  }
  return deployed;
}

/** Resolve channel names → spaceIds (app-key route) and enable agents/functions. */
async function enableOnChannels(ctx, record) {
  step("Enabling agents/functions on their channels…");
  const appKey = record.keys?.find((k) => k.env === "test" && k.type === "pk")?.plaintext;
  if (!appKey) die("No test publishable key on record — cannot resolve channels.");
  const resolve = async (name) => {
    const r = await appKeyGet(ctx.baseUrl, appKey, `/api/app/channels/${encodeURIComponent(name)}`);
    return r?.spaceId || null;
  };
  for (const a of record.agents || []) {
    if (!a.agentId || !a.enableChannel) continue;
    const spaceId = await resolve(a.enableChannel);
    if (!spaceId) {
      warn(`channel "${a.enableChannel}" not found yet — run the app once, then re-run with --enable.`);
      continue;
    }
    const r = await devCall(ctx, "POST", `/api/apps/${record.appId}/agents/${a.agentId}/enable`, { targetSpaceId: spaceId });
    info(r.ok ? `  ${c.green("✓")} enabled ${a.handle} on #${a.enableChannel}` : `  ${c.red("✗")} enable ${a.handle}: ${r.status}`);
  }
  for (const f of record.functions || []) {
    if (!f.functionId || !f.enableChannel) continue;
    const spaceId = await resolve(f.enableChannel);
    if (!spaceId) {
      warn(`channel "${f.enableChannel}" not found yet — run the app once, then re-run with --enable.`);
      continue;
    }
    const r = await devCall(ctx, "POST", `/api/apps/${record.appId}/functions/${f.functionId}/enable`, { targetSpaceId: spaceId });
    info(r.ok ? `  ${c.green("✓")} enabled fn ${f.name} on #${f.enableChannel}` : `  ${c.red("✗")} enable ${f.name}: ${r.status}`);
  }
}
