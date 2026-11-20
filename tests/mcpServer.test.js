/**
 * The MCP server end to end, over an in-memory connection with the CLI runner
 * stubbed out; plus an opt-in smoke run of the real `muhkoo mcp`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../src/mcp/server.js";
import { TOOLS } from "../src/mcp/tools.js";
import { SECRET_PATTERNS } from "../src/mcp/secrets.js";

const SK = "mk_test_sk_" + "Q".repeat(32);
const SESSION = "e".repeat(64);

let home, savedHome, calls, reply;
beforeEach(async () => {
    savedHome = process.env.HOME;
    home = await mkdtemp(join(tmpdir(), "mcp-server-home-"));
    process.env.HOME = home;
    process.env.MUHKOO_SECRETS_DIR = join(home, "secrets");
    await mkdir(join(home, ".muhkoo"), { recursive: true });
    await writeFile(join(home, ".muhkoo", "config.json"), JSON.stringify({ base: "staging", token: SESSION, username: "dev" }));
    calls = [];
    reply = () => ({ ok: true, data: {} });
});
afterEach(() => {
    process.env.HOME = savedHome;
    delete process.env.MUHKOO_SECRETS_DIR;
});

async function connect() {
    const run = async (argv, opts) => {
        calls.push({ argv, opts });
        if (opts?.onStderr) opts.onStderr("Open https://auth.muhkoo.dev/signin?x=1 to sign in");
        return reply(argv, opts);
    };
    const server = createServer({ run });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    const logs = [];
    client.setNotificationHandler((await import("@modelcontextprotocol/sdk/types.js")).LoggingMessageNotificationSchema, (n) => {
        logs.push(n.params);
    });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, logs };
}

describe("muhkoo mcp", () => {
    it("lists every tool with its safety markings", async () => {
        const { client } = await connect();
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(TOOLS.length);
        expect(tools.find((t) => t.name === "promote").annotations.destructiveHint).toBe(true);
        expect(tools.find((t) => t.name === "vfs_ls").annotations.readOnlyHint).toBe(true);
    });

    it("runs a tool and returns the CLI's result", async () => {
        reply = () => ({ ok: true, data: { username: "dev", base: "https://api.muhkoo.dev" } });
        const { client } = await connect();
        const r = await client.callTool({ name: "whoami", arguments: {} });
        expect(r.isError).toBeFalsy();
        expect(r.structuredContent.username).toBe("dev");
        expect(calls[0].argv).toEqual(["whoami"]);
        expect(calls[0].opts.timeoutMs).toBe(60_000);
    });

    it("passes the project folder as cwd and the long timeout", async () => {
        const { client } = await connect();
        await client.callTool({ name: "deploy", arguments: { projectDir: "/tmp/proj" } });
        expect(calls[0].opts).toMatchObject({ cwd: "/tmp/proj", timeoutMs: 600_000 });
    });

    it("adds the platform base to a change that didn't report one", async () => {
        reply = () => ({ ok: true, data: { slug: "todo" } });
        const { client } = await connect();
        const r = await client.callTool({ name: "domains_add", arguments: { appId: "a", hostname: "x.com" } });
        expect(r.structuredContent.base).toBe("https://api.staging.muhkoo.dev");
        expect(r.structuredContent.platform).toBe("staging");
    });

    it("whoami names the platform, so Claude can tell production from staging", async () => {
        reply = () => ({ ok: true, data: { username: "dev", base: "https://api.muhkoo.dev" } });
        const { client } = await connect();
        const r = await client.callTool({ name: "whoami", arguments: {} });
        expect(r.structuredContent.platform).toBe("production");
    });

    it("never returns a secret", async () => {
        reply = () => ({
            ok: true,
            data: { appId: "app1", slug: "todo", keys: [{ env: "test", type: "sk", plaintext: SK }], note: `token ${SESSION}` },
        });
        const { client } = await connect();
        const r = await client.callTool({ name: "apps_create", arguments: { slug: "todo" } });
        const text = r.content[0].text;
        for (const re of SECRET_PATTERNS) expect(text).not.toMatch(re);
        expect(text).not.toContain(SESSION);
        expect(text).toContain("savedTo");
    });

    it("returns a CLI failure as a tool error", async () => {
        reply = () => ({ ok: false, error: "App not found" });
        const { client } = await connect();
        const r = await client.callTool({ name: "apps_get", arguments: { appId: "nope" } });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toBe("App not found");
    });

    it("rejects a relative project folder before running anything", async () => {
        const { client } = await connect();
        const r = await client.callTool({ name: "deploy", arguments: { projectDir: "my-app" } });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toMatch(/projectDir must be an absolute path/);
        expect(calls).toHaveLength(0);
    });

    it("shows login's sign-in link while it waits", async () => {
        const { client, logs } = await connect();
        await client.callTool({ name: "login", arguments: {} });
        expect(logs.some((l) => String(l.data).includes("https://auth.muhkoo.dev/signin"))).toBe(true);
    });

    it("wraps a list result so structured content is an object", async () => {
        reply = () => ({ ok: true, data: [{ appId: "a" }] });
        const { client } = await connect();
        const r = await client.callTool({ name: "apps_ls", arguments: {} });
        expect(r.structuredContent).toEqual({ items: [{ appId: "a" }] });
    });
});

const e2e = process.env.MCP_E2E === "1" ? describe : describe.skip;
e2e("muhkoo mcp (real process, real CLI config)", () => {
    it("starts, lists tools and answers whoami", async () => {
        process.env.HOME = savedHome;
        const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "muhkoo.js");
        const transport = new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], env: { ...process.env } });
        const client = new Client({ name: "e2e", version: "0" });
        await client.connect(transport);
        try {
            const { tools } = await client.listTools();
            expect(tools.length).toBe(TOOLS.length);
            const r = await client.callTool({ name: "whoami", arguments: {} });
            expect(r.isError, r.content?.[0]?.text).toBeFalsy();
            const ls = await client.callTool({ name: "vfs_ls", arguments: { path: "/" } });
            expect(ls.isError, ls.content?.[0]?.text).toBeFalsy();
        } finally {
            await client.close();
        }
    }, 120_000);
});

describe("review fixes (server)", () => {
    it("C-1: a flag-looking argument is refused before anything runs", async () => {
        const { client } = await connect();
        const r = await client.callTool({ name: "tables_get", arguments: { appId: "--base", table: "https://evil.example" } });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toMatch(/appId can't start with "-"/);
        expect(calls).toHaveLength(0);
    });
});
