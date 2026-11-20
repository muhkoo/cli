/**
 * Every CLI command is reachable from Claude, or says why not.
 *
 * Reads the `muhkoo <group> <sub>` usage lines from each command's help and
 * checks each one against the MCP tool table. A new CLI command fails this
 * until it gets a tool (src/mcp/tools.js) or an EXCLUDED reason.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_BY_NAME, EXCLUDED } from "../src/mcp/tools.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function usageKeys() {
    // The command modules, as the entrypoint routes them.
    const index = await readFile(join(root, "src", "index.js"), "utf8");
    const files = [...new Set([...index.matchAll(/import\("\.\/commands\/([a-z_-]+)\.js"\)/g)].map((m) => m[1]))];
    const keys = new Set();
    for (const file of files) {
        if (file === "mcp") continue; // the server itself
        const { help } = await import(join(root, "src", "commands", `${file}.js`));
        for (const m of String(help ?? "").matchAll(/^\s+muhkoo ([a-z-]+)(?: ([a-z][a-z-]*))?/gm)) {
            keys.add(m[2] ? `${m[1]} ${m[2]}` : m[1]);
        }
    }
    return keys;
}

const toolFor = (key) => key.replace(/[ -]/g, "_");

describe("CLI ↔ MCP tools", () => {
    it("every CLI command has a tool or an exclusion", async () => {
        const missing = [...(await usageKeys())].filter((k) => !TOOL_BY_NAME.has(toolFor(k)) && !(k in EXCLUDED));
        expect(missing).toEqual([]);
    });

    it("every exclusion still names a real command", async () => {
        const keys = await usageKeys();
        expect(Object.keys(EXCLUDED).filter((k) => !keys.has(k))).toEqual([]);
    });

    it("a command with no tool would be caught", () => {
        expect(TOOL_BY_NAME.has(toolFor("vfs frobnicate"))).toBe(false);
    });
});
