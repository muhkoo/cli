/**
 * `muhkoo login` pairs the machine with the seed the login produced, so the
 * first `muhkoo vfs` command needs no password. The seed source, the pairing
 * and the network are stand-ins; the config is the real one under a test HOME.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/lib/args.js";

let webResult;
let pairThrows = null;
let infos;
const pairCalls = [];
vi.mock("../src/lib/webLogin.js", () => ({
    DEFAULT_CLI_APP_ID: "muhkoo-cli",
    webLogin: async () => webResult,
}));
vi.mock("../src/lib/auth.js", () => ({
    zkLogin: async () => ({ token: "pw-token", commitment: "c2", username: "bob", seed: "cHctc2VlZA==" }),
}));
vi.mock("../src/lib/http.js", () => ({
    devCall: async () => ({ ok: true, status: 200, body: { tier: "free" } }),
}));
vi.mock("../src/lib/ui.js", async (importOriginal) => ({
    ...(await importOriginal()),
    prompt: async () => "bob",
    promptHidden: async () => "pw",
    step: () => {},
    ok: () => {},
    info: (...a) => void infos.push(a.join(" ")),
}));
vi.mock("../src/lib/vfs.js", async () => {
    const { saveConfig } = await import("../src/lib/config.js");
    return {
        pairWithSeed: async (a) => {
            pairCalls.push(a);
            if (pairThrows) throw new Error(pairThrows);
            await saveConfig({ ...a.cfg, username: a.username, deviceFactorId: "factor-9", deviceKey: "dk-9", seed: undefined });
            return { factorId: "factor-9", label: "me@box" };
        },
    };
});

const { default: login } = await import("../src/commands/login.js");

let home, savedHome;
const readCfg = async () => JSON.parse(await readFile(join(home, ".muhkoo", "config.json"), "utf8"));

beforeEach(async () => {
    savedHome = process.env.HOME;
    home = await mkdtemp(join(tmpdir(), "muhkoo-login-home-"));
    process.env.HOME = home;
    await mkdir(join(home, ".muhkoo"), { recursive: true });
    await writeFile(join(home, ".muhkoo", "config.json"), JSON.stringify({ seed: "old-seed" }));
    infos = [];
    pairThrows = null;
    pairCalls.length = 0;
    webResult = { token: "web-token", username: "ann", commitment: "c1", seed: "d2ViLXNlZWQ=" };
});
afterEach(async () => {
    process.env.HOME = savedHome;
    await rm(home, { recursive: true, force: true });
});

describe("muhkoo login", () => {
    it("--web with a seed pairs the machine and stores no seed", async () => {
        await login(parseArgs(["login", "--web", "--base", "https://api.test"]));
        expect(pairCalls).toHaveLength(1);
        expect(pairCalls[0]).toMatchObject({ token: "web-token", username: "ann", seed: "d2ViLXNlZWQ=" });
        const cfg = await readCfg();
        expect(cfg).toMatchObject({ token: "web-token", deviceFactorId: "factor-9", deviceKey: "dk-9" });
        expect(cfg.seed).toBeUndefined();
        expect(infos.join("\n")).toContain('Paired this machine as "me@box". Revoke it any time: muhkoo devices rm factor-9');
    });

    it("--no-pair signs in and pairs nothing", async () => {
        await login(parseArgs(["login", "--web", "--no-pair", "--base", "https://api.test"]));
        expect(pairCalls).toHaveLength(0);
        const cfg = await readCfg();
        expect(cfg.token).toBe("web-token");
        expect(cfg.deviceFactorId).toBeUndefined();
        expect(cfg.deviceKey).toBeUndefined();
    });

    it("--web without a seed says the machine is not paired, and still succeeds", async () => {
        webResult = { ...webResult, seed: null };
        await login(parseArgs(["login", "--web", "--base", "https://api.test"]));
        expect(pairCalls).toHaveLength(0);
        expect((await readCfg()).token).toBe("web-token");
        expect(infos.join("\n")).toContain("Signed in, but this machine is not paired");
        expect(infos.join("\n")).toContain("muhkoo vfs ls");
    });

    it("a password login pairs with the seed its ZK login recovered", async () => {
        await login(parseArgs(["login", "--username", "bob", "--password", "pw", "--base", "https://api.test"]));
        expect(pairCalls[0]).toMatchObject({ token: "pw-token", seed: "cHctc2VlZA==" });
    });

    it("a failed pairing still leaves the login succeeded (exit 0), with a note", async () => {
        pairThrows = "vault down";
        await login(parseArgs(["login", "--web", "--base", "https://api.test"]));
        const cfg = await readCfg();
        expect(cfg.token).toBe("web-token");
        expect(cfg.deviceFactorId).toBeUndefined();
        expect(infos.join("\n")).toContain("Signed in, but pairing this machine failed: vault down");
        expect(infos.join("\n")).toContain("plan: free");
    });

    it("clears a legacy seed on --no-pair and on a null seed", async () => {
        await login(parseArgs(["login", "--web", "--no-pair", "--base", "https://api.test"]));
        expect((await readCfg()).seed).toBeUndefined();
        await writeFile(join(home, ".muhkoo", "config.json"), JSON.stringify({ seed: "old-seed" }));
        webResult = { ...webResult, seed: null };
        await login(parseArgs(["login", "--web", "--base", "https://api.test"]));
        expect((await readCfg()).seed).toBeUndefined();
    });

    it("does not enrol again when this machine is already paired for the same user and base", async () => {
        await writeFile(join(home, ".muhkoo", "config.json"), JSON.stringify({ base: "https://api.test", username: "ann", deviceFactorId: "f-old", deviceKey: "k-old" }));
        await login(parseArgs(["login", "--web", "--base", "https://api.test"]));
        expect(pairCalls).toHaveLength(0);
        expect(await readCfg()).toMatchObject({ deviceFactorId: "f-old", deviceKey: "k-old", token: "web-token" });
        expect(infos.join("\n")).toContain("This machine is already paired.");
    });

    it("enrols when the existing pairing is for another user or base", async () => {
        await writeFile(join(home, ".muhkoo", "config.json"), JSON.stringify({ base: "https://other.test", username: "ann", deviceFactorId: "f-old", deviceKey: "k-old" }));
        await login(parseArgs(["login", "--web", "--base", "https://api.test"]));
        expect(pairCalls).toHaveLength(1);
        await writeFile(join(home, ".muhkoo", "config.json"), JSON.stringify({ base: "https://api.test", username: "zed", deviceFactorId: "f-old", deviceKey: "k-old" }));
        await login(parseArgs(["login", "--web", "--base", "https://api.test"]));
        expect(pairCalls).toHaveLength(2);
    });
    describe("a login as someone else, or elsewhere, that pairs nothing drops the old pairing", () => {
        const oldPairing = { base: "https://api.test", username: "zed", deviceFactorId: "f-old", deviceKey: "k-old" };
        const cases = [
            ["--no-pair", ["login", "--web", "--no-pair", "--base", "https://api.test"]],
            ["--token", ["login", "--token", "tok-x", "--base", "https://api.test"]],
            ["no seed", ["login", "--web", "--base", "https://api.test"], () => { webResult = { ...webResult, seed: null }; }],
            ["failed pairing", ["login", "--web", "--base", "https://api.test"], () => { pairThrows = "vault down"; }],
            ["another base", ["login", "--web", "--no-pair", "--base", "https://other.test"], () => { webResult = { ...webResult, username: "zed" }; }],
        ];
        for (const [name, argv, arrange] of cases) {
            it(name, async () => {
                await writeFile(join(home, ".muhkoo", "config.json"), JSON.stringify(oldPairing));
                arrange?.();
                await login(parseArgs(argv));
                const cfg = await readCfg();
                expect(cfg.deviceFactorId).toBeUndefined();
                expect(cfg.deviceKey).toBeUndefined();
            });
        }

        it("keeps the pairing on --no-pair for the same user and base", async () => {
            await writeFile(join(home, ".muhkoo", "config.json"), JSON.stringify({ ...oldPairing, username: "ann" }));
            await login(parseArgs(["login", "--web", "--no-pair", "--base", "https://api.test"]));
            expect(await readCfg()).toMatchObject({ deviceFactorId: "f-old", deviceKey: "k-old" });
        });
    });
});

describe("muhkoo login --json", () => {
    it("reports the base, user and pairing, and never the session token", async () => {
        const stdout = [];
        const spy = vi.spyOn(console, "log").mockImplementation((...a) => stdout.push(a.join(" ")));
        try {
            await login(parseArgs(["login", "--web", "--base", "staging", "--json"]));
        } finally {
            spy.mockRestore();
        }
        expect(stdout).toHaveLength(1);
        const result = JSON.parse(stdout[0]);
        expect(result).toMatchObject({ base: "https://api.staging.muhkoo.dev", username: "ann", paired: true, deviceFactorId: "factor-9" });
        expect(stdout[0]).not.toContain("web-token");
        expect(stdout[0]).not.toContain("dk-9");
    });
});
