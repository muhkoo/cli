/**
 * The rest of the commands a program drives with `--json`: each prints exactly
 * one object on stdout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/lib/args.js";
import { setJsonMode } from "../src/lib/ui.js";

let home, savedHome, stdout;
beforeEach(async () => {
    savedHome = process.env.HOME;
    home = await mkdtemp(join(tmpdir(), "muhkoo-json-results-"));
    process.env.HOME = home;
    await mkdir(join(home, ".muhkoo"), { recursive: true });
    await writeFile(join(home, ".muhkoo", "config.json"), JSON.stringify({ base: "https://api.staging.muhkoo.dev", token: "tok", username: "ann" }));
    stdout = [];
    setJsonMode(true);
    vi.spyOn(console, "log").mockImplementation((...a) => stdout.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
    setJsonMode(false);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env.HOME = savedHome;
    await rm(home, { recursive: true, force: true });
});

describe("--json results", () => {
    it("logout", async () => {
        const { default: logout } = await import("../src/commands/logout.js");
        await logout(parseArgs(["logout", "--json"]));
        expect(stdout).toHaveLength(1);
        expect(JSON.parse(stdout[0])).toEqual({ base: "https://api.staging.muhkoo.dev", signedOut: true });
        const cfg = JSON.parse(await readFile(join(home, ".muhkoo", "config.json"), "utf8"));
        expect(cfg.token).toBeUndefined();
    });

    it("promote", async () => {
        vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ report: { hosting: "ok" }, errors: [] }), { status: 200 }));
        const { default: promote } = await import("../src/commands/promote.js");
        await promote(parseArgs(["promote", "app1", "--json"]));
        expect(stdout).toHaveLength(1);
        expect(JSON.parse(stdout[0])).toMatchObject({ report: { hosting: "ok" } });
    });
});
