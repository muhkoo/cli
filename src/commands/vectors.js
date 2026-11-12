/**
 * `muhkoo vectors` — manage an app's vector search collections (owner
 * session). Collections can also be created via `muhkoo provision`.
 */

import { devContext, resolveBase } from "../lib/config.js";
import { devCall, skCall, ensure } from "../lib/http.js";
import { table, json, ok, info, step, die, printable, redact } from "../lib/ui.js";

export const help = `muhkoo vectors — vector search collections

Usage:
  muhkoo vectors ls <appId> [--json]
  muhkoo vectors get <appId> <name> [--json]
  muhkoo vectors create <appId> <name> --mode text|vectors [--model <id>] [--dimensions <n>] [--metric cosine|euclidean|dot-product] [--fields name:type,...] [--access app|backend] [--no-wait]
  muhkoo vectors rm <appId> <name>
  muhkoo vectors notices <appId> <name> --env live|test --spaces <id,...> [--default <id>]
  muhkoo vectors query <name> (--text <query> | --vector <json>) [--topk <n>] [--filter <json>] [--with-text] [--key <app key>] [--json]`;

const POLL_MS = 2000;
const WAIT_MS = 10 * 60 * 1000;

export default async function vectors(args) {
  for (const p of args._) {
    if (p.startsWith("-")) die(`Unknown option "${printable(p)}". Options use two dashes, e.g. --key.`);
  }
  const sub = args._[1];
  if (sub === "query") return query(args);

  const appId = args._[2] || args.app;
  if (!appId) die("Missing app id. Usage: muhkoo vectors <ls|get|create|rm|notices> <appId> [name]");

  switch (sub) {
    case "ls":
    case undefined:
      return list(await devContext(args), appId, args);
    case "get":
      return get(await devContext(args), appId, args);
    case "create":
      return create(args, appId);
    case "rm":
      return remove(await devContext(args), appId, args);
    case "notices":
      return notices(args, appId);
    default:
      die(`Unknown subcommand "vectors ${sub}". See \`muhkoo vectors --help\`.`);
  }
}

const base = (appId) => `/api/apps/${encodeURIComponent(appId)}/vectors/collections`;
const one = (appId, name) => `${base(appId)}/${encodeURIComponent(name)}`;
const count = (n) => (n === null || n === undefined ? "—" : String(n));

function nameArg(args, usage) {
  const name = args._[3];
  if (!name) die(`Usage: ${usage}`);
  return name;
}

async function list(ctx, appId, args) {
  const r = ensure(await devCall(ctx, "GET", base(appId)), "List collections");
  const items = r.body?.collections || [];
  if (args.json) return json(items);
  if (!items.length) return info("No collections. Create one with `muhkoo vectors create`.");
  table(
    ["NAME", "MODE", "MODEL/DIMS", "ACCESS", "STATUS", "LIVE", "TEST"],
    items.map((c) => [
      c.name,
      c.mode,
      c.mode === "text" ? c.model : c.dimensions,
      c.access,
      c.status,
      count(c.envs?.live?.entries),
      count(c.envs?.test?.entries),
    ]),
  );
}

async function get(ctx, appId, args) {
  const name = nameArg(args, "muhkoo vectors get <appId> <name>");
  const r = ensure(await devCall(ctx, "GET", one(appId, name)), "Get collection");
  json(r.body);
}

function parseFields(spec) {
  if (spec === true) die("--fields needs a value, e.g. --fields category:string,year:number");
  return String(spec)
    .split(",")
    .filter((s) => s !== "")
    .map((item) => {
      const m = /^([^:]+):([^:]+)$/.exec(item);
      if (!m) die(`Malformed field "${printable(item)}" in --fields. Use name:type, e.g. category:string.`);
      return { name: m[1], type: m[2] };
    });
}

function definition(args) {
  if (!args.mode || args.mode === true) die("Missing --mode text|vectors.");
  const body = { mode: args.mode };
  if (args.model !== undefined) body.model = args.model;
  if (args.dimensions !== undefined) {
    const n = Number(args.dimensions);
    if (!Number.isFinite(n)) die(`--dimensions must be a number, not "${printable(args.dimensions)}".`);
    body.dimensions = n;
  }
  if (args.metric !== undefined) body.metric = args.metric;
  if (args.fields !== undefined) body.fields = parseFields(args.fields);
  if (args.access !== undefined) body.access = args.access;
  return body;
}

/** Like ensure(), but a `{ error, code }` body prints the server's sentence
 *  and code (plus Retry-After on a 429) instead of raw JSON. */
function serverFail(r, what) {
  if (r.ok) return r;
  const b = r.body;
  if (!b || typeof b !== "object" || !b.error) return ensure(r, what);
  let msg = `${what} failed (${r.status}): ${redact(String(b.error))}`;
  if (b.code) msg += ` (${redact(String(b.code))})`;
  if (r.status === 429 && r.retryAfter != null) msg += ` Retry after ${redact(String(r.retryAfter))} seconds.`;
  die(msg);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function create(args, appId) {
  const usage = "muhkoo vectors create <appId> <name> --mode text|vectors";
  const name = nameArg(args, usage);
  const body = definition(args);
  const ctx = await devContext(args);
  const put = await devCall(ctx, "PUT", one(appId, name), body);
  if (put.status === 402) die(String(put.body?.error || "Vector search requires a paid plan."));
  serverFail(put, "Create collection");
  if (args["no-wait"]) return ok(`Creating collection ${name}.`);

  let last = null;
  const started = Date.now();
  let c = put.body;
  for (;;) {
    const status = c?.status;
    if (status !== last) {
      step(`${name}: ${status}`);
      last = status;
    }
    if (status === "ready") return ok(`Collection ${name} is ready.`);
    if (status === "failed") {
      for (const [env, e] of Object.entries(c.envs || {})) {
        if (e?.error) info(`  ${env}: ${e.error}`);
      }
      die(`Collection ${name} failed to create.`);
    }
    if (Date.now() - started >= WAIT_MS) break;
    await sleep(POLL_MS);
    c = ensure(await devCall(ctx, "GET", one(appId, name)), "Get collection").body;
  }
  die(`Still creating after 10 minutes; check with \`muhkoo vectors get ${appId} ${name}\`.`);
}

async function remove(ctx, appId, args) {
  const name = nameArg(args, "muhkoo vectors rm <appId> <name>");
  serverFail(await devCall(ctx, "DELETE", one(appId, name)), "Drop collection");
  ok(`Dropping collection ${name}; its entries in test and live are deleted.`);
}

function jsonFlag(args, flag) {
  const raw = args[flag];
  if (raw === true) die(`--${flag} needs a JSON value.`);
  try {
    return JSON.parse(String(raw));
  } catch (e) {
    die(`--${flag} is not valid JSON: ${e.message}`);
  }
}

const cut = (s, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Debugging search over the data API, with an app key (no session). */
async function query(args) {
  const name = args._[2];
  if (!name) die("Usage: muhkoo vectors query <name> (--text <query> | --vector <json>)");
  const hasText = args.text !== undefined;
  const hasVector = args.vector !== undefined;
  if (hasText === hasVector) die("Pass exactly one of --text and --vector.");
  const key = args.key && args.key !== true ? String(args.key) : process.env.MUHKOO_APP_KEY;
  if (!key) die("No app key. Pass --key <mk_…> or set MUHKOO_APP_KEY (`muhkoo tokens create` mints one).");

  const body = {};
  if (hasText) {
    if (args.text === true) die("--text needs a value.");
    body.text = String(args.text);
  } else {
    body.vector = jsonFlag(args, "vector");
  }
  if (args.topk !== undefined) {
    const n = Number(args.topk);
    if (args.topk === true || !Number.isFinite(n)) die(`--topk must be a number, not "${printable(args.topk)}".`);
    body.topK = n;
  }
  if (args.filter !== undefined) body.filter = jsonFlag(args, "filter");
  if (args["with-text"]) body.includeText = true;

  const baseUrl = await resolveBase(args);
  const r = await skCall(baseUrl, key, "POST", `/api/vectors/${encodeURIComponent(name)}/query`, body);
  if (!r.ok) {
    const msg = r.body && typeof r.body === "object" && r.body.error ? r.body.error : r.body;
    die(`Query failed (${r.status}): ${redact(msg ?? "no response body")}`);
  }
  const matches = r.body?.matches || [];
  if (args.json) return json(matches);
  if (!matches.length) return info("No matches.");
  const withText = Boolean(args["with-text"]);
  const headers = withText ? ["ID", "SCORE", "DATA", "TEXT"] : ["ID", "SCORE", "DATA"];
  table(
    headers,
    matches.map((m) => {
      const row = [m.id, String(m.score), m.data === undefined ? "" : cut(JSON.stringify(m.data))];
      if (withText) row.push(m.text == null ? "" : cut(String(m.text)));
      return row;
    }),
  );
}

async function notices(args, appId) {
  const name = nameArg(args, "muhkoo vectors notices <appId> <name> --env live|test --spaces <id,...>");
  if (args.env !== "live" && args.env !== "test") die("--env must be live or test.");
  if (args.spaces === undefined || args.spaces === true) die('Missing --spaces <id,...> (pass --spaces "" to clear).');
  const spaces = String(args.spaces).split(",").filter((s) => s !== "");
  let defaultSpace = null;
  if (args.default !== undefined) {
    defaultSpace = String(args.default);
    if (!spaces.includes(defaultSpace)) die(`--default "${printable(defaultSpace)}" must be one of the --spaces.`);
  }
  const ctx = await devContext(args);
  ensure(
    await devCall(ctx, "PATCH", `${one(appId, name)}/notices?env=${args.env}`, { spaces, defaultSpace }),
    "Set notice Spaces",
  );
  ok(`Notice Spaces for ${name} (${args.env}): ${spaces.length ? spaces.join(", ") : "none"}.`);
}
