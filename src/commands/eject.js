/**
 * `muhkoo eject` — print the system prompt + tools config that a `@Muhkoo*`-
 * decorated agent description compiles to. Useful for reviewing what an agent
 * will actually be told and allowed to do before provisioning it.
 *
 * Runs the target through `tsx` (so decorators + TypeScript work) against the
 * `@muhkoo/connect` installed in the target's own project.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { die } from "../lib/ui.js";

export const help = `muhkoo eject — preview an agent's compiled prompt + tools

Usage:
  muhkoo eject <path/to/agentApp.ts> [ExportName]

Requires the target project to have @muhkoo/connect installed and a tsconfig
with experimentalDecorators enabled. Uses tsx (via npx) to run.`;

export default async function eject(args) {
  const target = args._[1];
  if (!target) die("Usage: muhkoo eject <path/to/agentApp.ts> [ExportName]");
  const exportName = args._[2];

  const runner = join(dirname(fileURLToPath(import.meta.url)), "_eject-runner.mjs");
  const argv = ["--yes", "tsx", runner, target];
  if (exportName) argv.push(exportName);

  await new Promise((resolve) => {
    const child = spawn("npx", argv, { stdio: "inherit" });
    child.on("error", (e) => die(`Could not run tsx via npx: ${e.message}`));
    child.on("exit", (code) => {
      if (code !== 0) process.exit(code ?? 1);
      resolve();
    });
  });
}
