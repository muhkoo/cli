/**
 * The Muhkoo MCP server: every CLI action as a tool Claude can call.
 *
 * Each call runs the CLI underneath (`run.js`), saves any secret the result
 * carries to a private file (`secrets.js`), masks anything secret-shaped that
 * is left, and returns the rest. Which tools exist, and how they are marked,
 * is `tools.js`.
 */

import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS, flagLikeArgument } from "./tools.js";
import { runCli } from "./run.js";
import { sealSecrets, scrub } from "./secrets.js";
import { loadConfig } from "../lib/config.js";
import { resolveBaseUrl, platformFor } from "../lib/bases.js";

const INSTRUCTIONS = `Muhkoo tools for building and running apps on Muhkoo.
Start with whoami to see who is signed in and which platform the tools act on; if nobody is, call login.
deploy publishes a built client to the app's TEST environment and returns its address; promote is the only way to put it into PRODUCTION.
Secret keys and access tokens are never shown: tools that create them save them to a private file and return its path.
Local paths must be absolute. Filesystem (vfs_*) paths are absolute paths in the user's Muhkoo filesystem, where projects live under /apps.`;

async function version() {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  return pkg.version;
}

/**
 * @param {{ run?: typeof runCli, version?: string }} [opts]
 * @returns {McpServer}
 */
export function createServer({ run = runCli, version: v = "0.0.0" } = {}) {
  const server = new McpServer(
    { name: "muhkoo", title: "Muhkoo", version: v },
    { capabilities: { logging: {} }, instructions: INSTRUCTIONS },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: tool.annotations },
      async (args) => {
        const flagLike = flagLikeArgument(args);
        if (flagLike) {
          return { isError: true, content: [{ type: "text", text: `${flagLike} can't start with "-"` }] };
        }
        // Login prints the sign-in link while it waits; pass progress on so
        // the developer can open it if the browser didn't.
        const onStderr =
          tool.name === "login"
            ? (line) => server.sendLoggingMessage({ level: "info", logger: "muhkoo", data: line }).catch(() => {})
            : undefined;

        const r = await run(tool.argv(args), {
          cwd: tool.cwd?.(args),
          timeoutMs: tool.timeoutMs ?? 60_000,
          onStderr,
        });

        const cfg = await loadConfig();
        const known = [cfg.token, cfg.deviceKey, cfg.seed];
        if (!r.ok) return { isError: true, content: [{ type: "text", text: scrub(r.error, { known }) }] };

        let data = await sealSecrets(tool.name, r.data, { projectDir: args.projectDir });
        data = scrub(data, { known });
        let result = Array.isArray(data) || data === null || typeof data !== "object" ? { items: data } : data;
        // Every change says where it happened (production or staging).
        if (!tool.annotations.readOnlyHint && result.base === undefined) {
          result = { ...result, base: resolveBaseUrl(cfg.base) };
        }
        // A URL alone doesn't tell a model which one is production.
        if (typeof result.base === "string") result = { ...result, platform: platformFor(result.base) };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
      },
    );
  }
  return server;
}

/** Start the server on stdio (what `muhkoo mcp` does). */
export async function serveStdio() {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = createServer({ version: await version() });
  await server.connect(new StdioServerTransport());
  return server;
}
