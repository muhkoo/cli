#!/usr/bin/env node
/**
 * Keep @muhkoo/cli versioned in lockstep with @muhkoo/connect. The CLI is a thin
 * wrapper over the SDK and ships against an exact SDK version, so its own
 * `version` and its `@muhkoo/connect` dependency must both equal the sibling
 * connect package's version.
 *
 *   node scripts/sync-version.mjs          # rewrite cli to match ../connect
 *   node scripts/sync-version.mjs --check  # fail if they don't match (publish gate)
 *
 * In --check mode, a missing sibling ../connect is treated as "can't verify" and
 * passes (publishing from a checkout that doesn't vendor connect is allowed).
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CHECK = process.argv.includes("--check");
const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPkgPath = join(cliRoot, "package.json");
const connectPkgPath = join(cliRoot, "..", "connect", "package.json");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function connectVersion() {
  try {
    return (await readJson(connectPkgPath)).version;
  } catch {
    return null;
  }
}

const target = await connectVersion();
if (!target) {
  if (CHECK) {
    console.warn("sync-version: ../connect not found — skipping version check.");
    process.exit(0);
  }
  console.error("sync-version: could not read ../connect/package.json. Is the connect repo a sibling?");
  process.exit(1);
}

const cli = await readJson(cliPkgPath);
const depOk = cli.dependencies?.["@muhkoo/connect"] === target;
const verOk = cli.version === target;

if (CHECK) {
  if (verOk && depOk) {
    console.log(`sync-version: OK — @muhkoo/cli and @muhkoo/connect are both ${target}.`);
    process.exit(0);
  }
  console.error(
    `sync-version: version mismatch with @muhkoo/connect (${target}).\n` +
      `  cli version:        ${cli.version}${verOk ? "" : "  ✗"}\n` +
      `  @muhkoo/connect dep: ${cli.dependencies?.["@muhkoo/connect"]}${depOk ? "" : "  ✗"}\n` +
      "Run `npm run sync-version` and re-publish.",
  );
  process.exit(1);
}

cli.version = target;
cli.dependencies = { ...cli.dependencies, "@muhkoo/connect": target };
await writeFile(cliPkgPath, JSON.stringify(cli, null, 2) + "\n");
console.log(`sync-version: set @muhkoo/cli to ${target} (pinned @muhkoo/connect@${target}).`);
