/**
 * Internal runner for `muhkoo eject`. Prints the system prompt + tools config for
 * a `@Muhkoo*`-decorated agent description module. Run under `tsx` so it can
 * import a TypeScript target with `experimentalDecorators` enabled.
 *
 * Two supported shapes:
 *   1. The module exports `agentPrompt()` + `agentTools()` helpers — used directly.
 *   2. The module exports the decorated class — we resolve `@muhkoo/connect` from
 *      the target's own project and eject from the class.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

async function main() {
  const target = process.argv[2];
  const exportName = process.argv[3];
  if (!target) {
    console.error("usage: _eject-runner.mjs <file.ts> [ExportName]");
    process.exit(1);
  }
  const targetAbs = resolve(target);
  const mod = await import(pathToFileURL(targetAbs).href);

  let prompt;
  let tools;

  if (typeof mod.agentPrompt === "function" && typeof mod.agentTools === "function") {
    prompt = mod.agentPrompt();
    tools = mod.agentTools();
  } else {
    const require = createRequire(targetAbs);
    const connectUrl = pathToFileURL(require.resolve("@muhkoo/connect")).href;
    const { ejectAgentPrompt, ejectAgentTools } = await import(connectUrl);

    let cls;
    if (exportName) cls = mod[exportName];
    else if (typeof mod.default === "function") cls = mod.default;
    else cls = Object.values(mod).find((v) => typeof v === "function");

    if (typeof cls !== "function") {
      console.error(
        `No decorated class or agentPrompt/agentTools exports found in ${target}. ` +
          "Export the class (default or named, or pass its name) or the helper functions.",
      );
      process.exit(1);
    }
    prompt = ejectAgentPrompt(cls);
    tools = ejectAgentTools(cls);
  }

  console.log("\n===================== system prompt =====================\n");
  console.log(prompt);
  console.log("\n====================== tools config =====================\n");
  console.log(JSON.stringify(tools, null, 2));
  console.log("");
}

void main();
