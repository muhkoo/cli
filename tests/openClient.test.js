/**
 * Opening a session for a command, and what that may store on this machine.
 *
 * Unlocking pairs a machine that is not paired yet: it enrols a device factor
 * on the server and saves its key to ~/.muhkoo/config.json. It also resets a
 * stale VFS working directory there, and forgets a revoked pairing. A dry run
 * promises to write nothing, so it opens read-only; `--no-pair` asks for the
 * pairing alone to be skipped.
 *
 * The SDK is a stand-in that records what it was asked; the config is the
 * real one, under a HOME of the test's own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/lib/args.js";

vi.mock("../src/lib/auth.js", () => ({
    loadClient: async () => globalThis.__muhkooFakeClient,
    downloadCircuits: async () => ({}),
}));
vi.mock("../src/lib/ui.js", async (importOriginal) => ({
    ...(await importOriginal()),
    prompt: async () => "someone",
    promptHidden: async () => "password",
}));

/** What the stand-in SDK was asked to do, in order. */
let events;
/** Set to a message to make the stored device key fail with it. */
let deviceFails;
globalThis.__muhkooFakeClient = class {
    constructor() {
        this.auth = {
            zk: {
                restore: async () => ({ username: "someone" }),
                unlockWithDevice: async () => {
                    if (deviceFails) throw new Error(deviceFails);
                    events.push("unlockWithDevice");
                },
                login: async () => void events.push("login"),
                seedBase64: "c2VlZA==",
                enrollDevice: async () => {
                    events.push("enrollDevice");
                    return { factorId: "factor-1", deviceKey: "device-key-1" };
                },
                unlockWithSeed: () => void events.push("unlockWithSeed"),
            },
        };
        this.vfs = {
            cd: async (path) => {
                throw new Error(`${path} is gone`);
            },
        };
    }
};

const { openClient, openSession } = await import("../src/lib/vfs.js");

let home;
let saved;
const configFile = () => join(home, ".muhkoo", "config.json");
async function withConfig(cfg) {
    await mkdir(join(home, ".muhkoo"), { recursive: true });
    await writeFile(configFile(), JSON.stringify(cfg, null, 2) + "\n");
    return readFile(configFile(), "utf8");
}

beforeEach(async () => {
    saved = { HOME: process.env.HOME, MUHKOO_SEED: process.env.MUHKOO_SEED, MUHKOO_DEV_TOKEN: process.env.MUHKOO_DEV_TOKEN };
    home = await mkdtemp(join(tmpdir(), "muhkoo-open-home-"));
    process.env.HOME = home;
    delete process.env.MUHKOO_SEED;
    delete process.env.MUHKOO_DEV_TOKEN;
    events = [];
    deviceFails = null;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await rm(home, { recursive: true, force: true });
});

describe("openClient on a machine not paired yet", () => {
    it("pairs it, and saves the pairing, by default", async () => {
        await withConfig({ token: "t", username: "someone" });
        await openClient(parseArgs(["vfs", "ls"]));
        expect(events).toEqual(["login", "enrollDevice", "unlockWithSeed"]);
        expect(JSON.parse(await readFile(configFile(), "utf8"))).toMatchObject({ deviceFactorId: "factor-1", deviceKey: "device-key-1" });
    });

    it("read-only (a dry run): signs in for this command, and enrols and saves nothing", async () => {
        const before = await withConfig({ token: "t", username: "someone" });
        await openClient({ _: ["vfs", "mount"], pair: false, readOnly: true });
        expect(events).toEqual(["login", "unlockWithSeed"]);
        expect(await readFile(configFile(), "utf8")).toBe(before);
    });

    it("`--no-pair`, as the CLI parses it, pairs nothing", async () => {
        // The parser gives `--no-pair` as `"no-pair": true`; only `pair: false`
        // was ever read, so the flag the help documents did nothing.
        const before = await withConfig({ token: "t", username: "someone" });
        await openClient(parseArgs(["vfs", "ls", "--no-pair"]));
        expect(events).not.toContain("enrollDevice");
        expect(await readFile(configFile(), "utf8")).toBe(before);
    });
});

describe("openClient on a paired machine", () => {
    const paired = { token: "t", username: "someone", deviceFactorId: "factor-0", deviceKey: "device-key-0" };

    it("resets a working directory that is gone, by default", async () => {
        await withConfig({ ...paired, vfsCwd: "/apps/gone" });
        await openClient(parseArgs(["vfs", "ls"]));
        expect(JSON.parse(await readFile(configFile(), "utf8")).vfsCwd).toBe("/");
    });

    it("read-only, leaves it as it is", async () => {
        const before = await withConfig({ ...paired, vfsCwd: "/apps/gone" });
        await openClient({ _: ["vfs", "mount"], pair: false, readOnly: true });
        expect(events).toEqual(["unlockWithDevice"]);
        expect(await readFile(configFile(), "utf8")).toBe(before);
    });

    it("read-only, a stored key that fails signs in without re-pairing", async () => {
        deviceFails = "the device key did not unwrap";
        const before = await withConfig(paired);
        await openClient({ _: ["vfs", "mount"], pair: false, readOnly: true });
        expect(events).toEqual(["login", "unlockWithSeed"]);
        expect(await readFile(configFile(), "utf8")).toBe(before);
    });

    it("read-only, a revoked pairing stops the command and leaves the config as it is", async () => {
        deviceFails = "this device was revoked";
        const before = await withConfig(paired);
        vi.spyOn(process, "exit").mockImplementation((code) => {
            throw new Error(`exit ${code}`);
        });
        await expect(openClient({ _: ["vfs", "mount"], pair: false, readOnly: true })).rejects.toThrow("exit 1");
        expect(await readFile(configFile(), "utf8")).toBe(before);
    });
});

describe("openSession", () => {
    it("restores the session and unlocks nothing: no prompt, no pairing, nothing saved", async () => {
        const before = await withConfig({ token: "t", username: "someone", commitment: "123" });
        // Wrap the fake for this test only, to record that `restore()` ran
        // rather than assert something always-true about the returned client.
        const Fake = globalThis.__muhkooFakeClient;
        globalThis.__muhkooFakeClient = class extends Fake {
            constructor(o) {
                super(o);
                const r = this.auth.zk.restore;
                this.auth.zk.restore = async () => (events.push("restore"), r());
            }
        };
        try {
            await openSession(parseArgs(["kv", "ls"]));
            expect(events).toEqual(["restore"]);
            expect(await readFile(configFile(), "utf8")).toBe(before);
        } finally {
            globalThis.__muhkooFakeClient = Fake;
        }
    });
});
