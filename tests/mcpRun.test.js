/**
 * The MCP server's runner: it starts the CLI as a child process and turns
 * what comes back into a result or an error a model can act on.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/mcp/run.js";

const bin = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-cli.mjs");
const run = (argv, opts = {}) => runCli(argv, { bin, ...opts });

const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

describe("runCli", () => {
    it("returns the parsed JSON, with --json appended, non-interactive and colourless", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "runcli-"));
        const r = await run(["json", "a"], { cwd });
        expect(r.ok).toBe(true);
        expect(r.data.argv).toEqual(["json", "a", "--json"]);
        expect(r.data.ni).toBe("1");
        expect(r.data.nc).toBe("1");
        expect(r.data.cwd).toMatch(/runcli-/);
    });

    it("returns text that isn't JSON as {text}", async () => {
        expect(await run(["text"])).toEqual({ ok: true, data: { text: "plain words\n" } });
    });

    it("returns the CLI's {error} message on failure", async () => {
        expect(await run(["error"])).toEqual({ ok: false, error: "App not found" });
    });

    it("points an expired session at the login tool", async () => {
        const r = await run(["unauthorized"]);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/use the login tool to sign in\.$/);
    });

    it("falls back to the tail of stderr when there is no {error}", async () => {
        const r = await run(["stderr-only"]);
        expect(r).toEqual({ ok: false, error: "boom on stderr" });
    });

    it("hands progress lines on stderr to onStderr", async () => {
        const lines = [];
        const r = await run(["progress"], { onStderr: (l) => lines.push(l) });
        expect(r.ok).toBe(true);
        expect(lines).toEqual(["step one", "step two"]);
    });

    it("caps huge output at 1 MiB and says so", async () => {
        const r = await run(["big"]);
        expect(r.ok).toBe(true);
        expect(r.data.text.length).toBeLessThan(1024 * 1024 + 100);
        expect(r.data.text).toMatch(/truncated: 3145728 bytes/);
    });

    it("does not return binary output", async () => {
        const r = await run(["binary"]);
        expect(r).toEqual({ ok: true, data: { text: "binary output; use vfs_get to save it to a file" } });
    });

    it("kills the whole process group on timeout", async () => {
        const pidFile = join(mkdtempSync(join(tmpdir(), "runcli-hang-")), "pid");
        const r = await run(["hang", pidFile], { timeoutMs: 1500 });
        expect(r).toEqual({ ok: false, error: "timed out after 1.5s" });
        expect(existsSync(pidFile)).toBe(true);
        const grandchild = Number(readFileSync(pidFile, "utf8"));
        await new Promise((res) => setTimeout(res, 200));
        expect(alive(grandchild)).toBe(false);
    });
});

describe("review fixes (runner)", () => {
    it("I-1: a command with nothing on stdout returns its progress lines as text", async () => {
        const r = await run(["quiet-ok"]);
        expect(r).toEqual({ ok: true, data: { text: "available  todo" } });
    });
});
