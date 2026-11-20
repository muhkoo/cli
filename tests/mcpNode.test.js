/**
 * Which program the MCP server starts the CLI with.
 *
 * Under plain Node it is the running Node. Under Claude Desktop's built-in
 * runtime the running program is the Claude app, which cannot act as Node
 * (its RunAsNode fuse is off), so a real `node` has to be found instead.
 */
import { describe, it, expect } from "vitest";
import { findNode } from "../src/mcp/node.js";
import { runCli } from "../src/mcp/run.js";

const HOME = "/Users/dev";
const base = {
    versions: { node: "22.0.0" },
    execPath: "/usr/local/bin/node",
    env: { PATH: "/usr/bin:/bin" },
    home: HOME,
    isExecutable: () => false,
    listDir: () => [],
    loginShellNode: () => null,
};
const electron = {
    ...base,
    versions: { node: "22.0.0", electron: "38.0.0" },
    execPath: "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper",
};
const only = (...paths) => (p) => paths.includes(p);

describe("findNode", () => {
    it("uses the running Node when it is Node", () => {
        expect(findNode(base)).toBe("/usr/local/bin/node");
    });

    it("never returns the Claude app itself under Electron", () => {
        expect(findNode({ ...electron, isExecutable: () => true, env: { PATH: "" } })).not.toBe(electron.execPath);
    });

    it("finds node on PATH under Electron", () => {
        expect(findNode({ ...electron, env: { PATH: "/usr/bin:/opt/x/bin" }, isExecutable: only("/opt/x/bin/node") })).toBe("/opt/x/bin/node");
    });

    it("finds Homebrew's node when PATH is bare", () => {
        expect(findNode({ ...electron, isExecutable: only("/opt/homebrew/bin/node") })).toBe("/opt/homebrew/bin/node");
    });

    it("finds the newest nvm node", () => {
        const dir = `${HOME}/.nvm/versions/node`;
        const r = findNode({
            ...electron,
            listDir: (d) => (d === dir ? ["v18.20.0", "v22.11.0", "v20.9.0"] : []),
            isExecutable: only(`${dir}/v18.20.0/bin/node`, `${dir}/v22.11.0/bin/node`, `${dir}/v20.9.0/bin/node`),
        });
        expect(r).toBe(`${dir}/v22.11.0/bin/node`);
    });

    it("asks the login shell last", () => {
        const r = findNode({ ...electron, loginShellNode: () => "/custom/node", isExecutable: only("/custom/node") });
        expect(r).toBe("/custom/node");
    });

    it("returns null when there is no node anywhere", () => {
        expect(findNode(electron)).toBeNull();
    });
});

describe("runCli without a node", () => {
    it("says how to fix it instead of failing to start", async () => {
        const r = await runCli(["whoami"], { node: null });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/Node\.js/);
        expect(r.error).toMatch(/Use built-in Node\.js for MCP/);
    });
});
