/**
 * muhkoo CLI entrypoint — argv routing, help, and version. Commands are loaded
 * lazily so startup stays fast and the SDK is only imported when actually needed
 * (login / eject).
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "./lib/args.js";
import { c, die } from "./lib/ui.js";

const COMMANDS = {
  login: () => import("./commands/login.js"),
  logout: () => import("./commands/logout.js"),
  whoami: () => import("./commands/whoami.js"),
  apps: () => import("./commands/apps.js"),
  keys: () => import("./commands/apps.js"), // `keys rotate` lives in apps.js
  provision: () => import("./commands/provision.js"),
  deploy: () => import("./commands/deploy.js"),
  hosting: () => import("./commands/hosting.js"),
  domains: () => import("./commands/domains.js"),
  tables: () => import("./commands/tables.js"),
  agents: () => import("./commands/agents.js"),
  functions: () => import("./commands/functions.js"),
  logs: () => import("./commands/logs.js"),
  eject: () => import("./commands/eject.js"),
};

const TOP_HELP = `${c.bold("muhkoo")} — command-line interface for the Muhkoo platform

Usage:
  muhkoo <command> [subcommand] [options]

Account
  login                  sign in as a developer (stores a session token)
  logout                 clear the stored session
  whoami                 show the signed-in developer

Apps
  apps ls|get|create|slug|rm     manage apps
  keys rotate <appId>            rotate an app's keys

Backend
  provision --spec <f>   create/update tables, agents, functions from a spec
  tables ls|get|rm       inspect database tables
  agents ls|get|rm|enable|disable|models
  functions ls|get|code|deploy|rm|enable|disable

Hosting
  deploy                 deploy a built client to Muhkoo hosting
  hosting status|rollback|rm-release|unpublish
  domains ls|add|rm      manage custom domains

Tools
  logs <appId>           inspect an app's server-log Space
  eject <agentApp.ts>    preview an agent's compiled prompt + tools

Global options
  --base <env|url>       prod (default) | staging | local | a literal URL
  --token <t>            developer session token (overrides stored/login)
  --json                 machine-readable output where supported
  -h, --help             help for a command
  -v, --version          print the CLI version

Run \`muhkoo <command> --help\` for details on a command.`;

async function version() {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  return pkg.version;
}

export async function run(argv) {
  // Normalize -h/-v before the positional parse.
  const wantsVersion = argv.includes("--version") || argv.includes("-v");
  const wantsHelp = argv.includes("--help") || argv.includes("-h");
  const args = parseArgs(argv.map((a) => (a === "-h" ? "--help" : a === "-v" ? "--version" : a)));
  const name = args._[0];

  if (wantsVersion) return console.log(await version());
  if (!name || name === "help") return console.log(TOP_HELP);

  const loader = COMMANDS[name];
  if (!loader) {
    die(`Unknown command "${name}". Run \`muhkoo --help\` for the command list.`);
  }

  const mod = await loader();

  // Per-command help.
  if (wantsHelp) {
    // `keys` reuses apps.js, which documents `keys rotate` in its own help.
    console.log(mod.help || TOP_HELP);
    return;
  }

  // `keys rotate <appId>` dispatches to the named export in apps.js.
  if (name === "keys") {
    if (args._[1] !== "rotate") die("Usage: muhkoo keys rotate <appId>");
    return mod.keysRotate(args);
  }

  return mod.default(args);
}
