#!/usr/bin/env node
/**
 * Build the Claude Desktop extension: dist/muhkoo.mcpb.
 *
 * The extension bundles this CLI (with its production dependencies) and runs
 * `muhkoo mcp`, so it can be built and tried before anything is published and
 * always matches the CLI it was built from. The manifest's tool list comes
 * from src/mcp/tools.js, never by hand.
 *
 *   node scripts/build-mcpb.mjs                  build dist/muhkoo.mcpb
 *   node scripts/build-mcpb.mjs --manifest-only  write dist/mcpb/manifest.json only
 *
 * Building is local. Publishing the .mcpb (or the CLI) is a release.
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../src/mcp/tools.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist", "mcpb");
const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";

/** The extension manifest (schema 0.3) for this package. */
export function buildManifest(pkg) {
  return {
    manifest_version: "0.3",
    name: "muhkoo",
    display_name: "Muhkoo",
    version: pkg.version,
    description: "Build and run apps on Muhkoo: create apps, deploy, manage functions, databases and domains, and browse your files.",
    long_description:
      "Gives Claude a tool for every Muhkoo CLI action, signed in as you. Deploys go to your app's test environment; promoting to production, deleting, and minting credentials are marked so Claude asks first. Secret keys and access tokens are saved to private files on your computer and never shown in the conversation.",
    author: { name: "Muhkoo", url: "https://muhkoo.com" },
    homepage: pkg.homepage,
    documentation: "https://docs.muhkoo.dev/guides/cli",
    repository: { type: "git", url: String(pkg.repository?.url ?? "").replace(/^git\+/, "") },
    license: pkg.license,
    keywords: ["muhkoo", "deploy", "apps", "serverless"],
    server: {
      type: "node",
      entry_point: "server/bin/muhkoo.js",
      mcp_config: { command: "node", args: ["${__dirname}/server/bin/muhkoo.js", "mcp"] },
    },
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
    compatibility: { platforms: ["darwin", "linux"], runtimes: { node: ">=20.0.0" } },
  };
}

async function main() {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const manifestOnly = process.argv.includes("--manifest-only");

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "manifest.json"), JSON.stringify(buildManifest(pkg), null, 2) + "\n");
  if (manifestOnly) return console.log(`wrote ${join(OUT, "manifest.json")}`);

  const server = join(OUT, "server");
  await mkdir(server, { recursive: true });
  for (const entry of ["bin", "src", "package.json", "package-lock.json", "LICENSE", "README.md"]) {
    await cp(join(ROOT, entry), join(server, entry), { recursive: true });
  }
  // Production dependencies only, exactly as locked.
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: server, stdio: "inherit" });

  const target = join(ROOT, "dist", "muhkoo.mcpb");
  execFileSync("npx", ["-y", MCPB_CLI, "pack", OUT, target], { stdio: "inherit" });
  console.log(`built ${target}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
