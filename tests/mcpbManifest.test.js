/**
 * The Claude Desktop extension's manifest is generated from the tool table and
 * package.json, so it can't drift from what the server actually offers.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { TOOLS } from "../src/mcp/tools.js";
import { buildManifest } from "../scripts/build-mcpb.mjs";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

describe(".mcpb manifest", () => {
    const m = buildManifest(pkg);

    it("lists exactly the server's tools", () => {
        expect(m.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
        for (const t of m.tools) expect(t.description.length).toBeGreaterThan(0);
    });

    it("has the fields the manifest schema requires", () => {
        expect(m.manifest_version).toBe("0.3");
        expect(m.name).toBe("muhkoo");
        expect(m.version).toBe(pkg.version);
        expect(typeof m.description).toBe("string");
        expect(m.author.name).toBeTruthy();
    });

    it("runs the bundled CLI's mcp command under Node 20+", () => {
        expect(m.server).toEqual({
            type: "node",
            entry_point: "server/bin/muhkoo.js",
            mcp_config: { command: "node", args: ["${__dirname}/server/bin/muhkoo.js", "mcp"] },
        });
        expect(m.compatibility.runtimes.node).toBe(">=20.0.0");
        // I-6: Windows isn't supported yet (process groups, console windows).
        expect(m.compatibility.platforms).toEqual(["darwin", "linux"]);
    });

    it("says nothing about the infrastructure underneath", () => {
        expect(JSON.stringify(m)).not.toMatch(/cloudflare|workers/i);
    });
});
