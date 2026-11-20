/**
 * `--json` is a contract with programs (the MCP server above all): stdout is
 * exactly one JSON object, failures included, and nothing ever waits on a
 * terminal that isn't there.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "muhkoo.js");

function cli(...argv) {
    const home = mkdtempSync(join(tmpdir(), "muhkoo-json-"));
    return spawnSync(process.execPath, [bin, ...argv], {
        env: { ...process.env, HOME: home, NO_COLOR: "1" },
        encoding: "utf8",
        timeout: 20_000,
    });
}

describe("--json failures", () => {
    it("a failing command prints one {error} object on stdout and exits 1", () => {
        const r = cli("apps", "bogus", "--json");
        expect(r.status).toBe(1);
        const out = JSON.parse(r.stdout);
        expect(typeof out.error).toBe("string");
        expect(out.error.length).toBeGreaterThan(0);
    });

    it("a thrown error (not a die()) is an {error} too, without a stack", () => {
        const r = cli("whoami", "--json", "--token", "t", "--base", "http://127.0.0.1:1");
        expect(r.status).toBe(1);
        const out = JSON.parse(r.stdout);
        expect(out.error).toMatch(/fetch failed/);
        expect(out.error).not.toMatch(/node:internal/);
    });

    it("an unknown command is an {error} too", () => {
        const r = cli("nosuchcommand", "--json");
        expect(r.status).toBe(1);
        expect(JSON.parse(r.stdout).error).toMatch(/Unknown command/);
    });
});

describe("in-process JSON mode", () => {
    afterEach(async () => {
        const ui = await import("../src/lib/ui.js");
        ui.setJsonMode(false);
        vi.restoreAllMocks();
        delete process.env.MUHKOO_NONINTERACTIVE;
    });

    it("progress lines go to stderr, never stdout", async () => {
        const ui = await import("../src/lib/ui.js");
        const out = vi.spyOn(console, "log").mockImplementation(() => {});
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        ui.setJsonMode(true);
        ui.info("hi");
        ui.step("going");
        ui.ok("done");
        ui.warn("careful");
        expect(out).not.toHaveBeenCalled();
        expect(err).toHaveBeenCalledTimes(4);
        expect(ui.isJsonMode()).toBe(true);
    });

    it("json() still goes to stdout", async () => {
        const ui = await import("../src/lib/ui.js");
        const out = vi.spyOn(console, "log").mockImplementation(() => {});
        ui.setJsonMode(true);
        ui.json({ a: 1 });
        expect(JSON.parse(out.mock.calls[0][0])).toEqual({ a: 1 });
    });

    it("a prompt fails at once when nothing can answer it", async () => {
        const ui = await import("../src/lib/ui.js");
        process.env.MUHKOO_NONINTERACTIVE = "1";
        const started = Date.now();
        await expect(ui.prompt("Username: ")).rejects.toThrow(/use the login tool/);
        await expect(ui.promptHidden("Password: ")).rejects.toThrow(/use the login tool/);
        expect(Date.now() - started).toBeLessThan(1000);
    });
});
