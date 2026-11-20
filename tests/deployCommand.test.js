/**
 * `muhkoo deploy` copies the project into the deployer's filesystem at
 * /apps/<slug> once the release is live, by running `muhkoo vfs import` in a
 * child process. Over a stubbed `fetch` and `spawn`: when it copies, where to,
 * which key pays for it, and that every reason not to copy is one line rather
 * than a failed deploy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/lib/args.js";

const state = vi.hoisted(() => ({ cfg: {}, spawns: [], exitCode: 0 }));

vi.mock("../src/lib/config.js", async () => {
    const { resolveBaseUrl } = await import("../src/lib/bases.js");
    return {
        loadConfig: async () => state.cfg,
        resolveBase: async (args, cfg) => resolveBaseUrl(args.base ?? cfg?.base),
        resolveToken: async (args, cfg) => args.token ?? cfg?.token,
    };
});

vi.mock("node:child_process", async () => {
    const { EventEmitter } = await import("node:events");
    return {
        spawn: (cmd, argv, opts) => {
            state.spawns.push({ cmd, argv, opts });
            const child = new EventEmitter();
            setImmediate(() => child.emit("exit", state.exitCode));
            return child;
        },
    };
});

const { default: deploy, planCopy } = await import("../src/commands/deploy.js");

const PROD = "https://api.muhkoo.dev";
const STAGING = "https://api.staging.muhkoo.dev";
const PAIRED = { token: "tok", base: "prod", username: "matt", deviceFactorId: "f1", deviceKey: "dk" };

let printed;
let app;   // what GET /api/apps/:appId answers
let dist;
let urls; // every URL fetched, as sent
const out = () => printed.join("\n");

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(async () => {
    printed = [];
    state.cfg = {};
    state.spawns = [];
    state.exitCode = 0;
    app = { status: 200, body: { appId: "a1", slug: "muhkoo-website" } };
    for (const name of ["MUHKOO_DEV_TOKEN", "MUHKOO_SEED", "MUHKOO_APP_KEY", "MUHKOO_DEPLOY_KEY", "MUHKOO_APP_ID", "MUHKOO_API_BASE"]) {
        vi.stubEnv(name, "");
    }
    vi.spyOn(console, "log").mockImplementation((...a) => printed.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => printed.push(a.join(" ")));
    vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`exit ${code}`);
    });
    urls = [];
    vi.stubGlobal("fetch", async (url, init = {}) => {
        urls.push(String(url));
        // Fake hosting routes on the bare path; the env query is checked through `urls`.
        const u = String(url).replace(/\?env=\w+$/, "");
        const method = init.method ?? "GET";
        if (method === "PUT" && u.includes("/hosting/blob/")) return reply({ dedup: false });
        if (method === "POST" && u.endsWith("/hosting/releases")) {
            return reply({ releaseId: "rel_1", bytes: 2048, files: 1, url: "https://muhkoo-website.apps.muhkoo.dev" });
        }
        if (method === "GET" && /\/api\/apps\/[^/]+$/.test(u)) return reply(app.body, app.status);
        return reply({ error: `unexpected ${method} ${u}` }, 500);
    });
    dist = await mkdtemp(join(tmpdir(), "muhkoo-deploy-test-"));
    await writeFile(join(dist, "index.html"), "<h1>hi</h1>\n");
});

afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(dist, { recursive: true, force: true });
});

const run = (...argv) => deploy(parseArgs(["deploy", "--app", "a1", "--key", "mk_test_sk_deploy", "--dist", dist, ...argv]));

describe("muhkoo deploy copies the project to /apps/<slug>", () => {
    it("runs vfs import on this folder, after the release, at the slug the server names", async () => {
        state.cfg = { ...PAIRED, vfsApp: "drive", vfsApps: { drive: "mk_live_pk_drive" } };
        await run();

        expect(state.spawns).toHaveLength(1);
        const [{ cmd, argv, opts }] = state.spawns;
        expect(cmd).toBe(process.execPath);
        expect(argv.slice(1)).toEqual(["vfs", "import", process.cwd(), "--path", "/apps/muhkoo-website", "--base", PROD]);
        expect(argv[0]).toMatch(/bin[\\/]muhkoo\.js$/);
        expect(opts.stdio).toBe("inherit");
        // The session goes through the environment, not argv. No app key: the
        // copy is billed to the signed-in account.
        expect(opts.env.MUHKOO_DEV_TOKEN).toBe("tok");
        expect(opts.env.MUHKOO_APP_KEY).toBeFalsy();
        expect(argv.join(" ")).not.toContain("tok");

        expect(out().indexOf("Deployed.")).toBeLessThan(out().indexOf("Copying the project to /apps/muhkoo-website"));
        expect(out()).not.toContain("billed to drive");
    });

    it("--no-vfs deploys without copying", async () => {
        state.cfg = { ...PAIRED, vfsApps: { "muhkoo-website": "mk_live_pk_site" } };
        await run("--no-vfs");
        expect(out()).toContain("Deployed.");
        expect(state.spawns).toHaveLength(0);
        expect(out()).not.toContain("Copying");
    });

    it("a failed copy is a warning with the retry command, not a failed deploy", async () => {
        state.cfg = { ...PAIRED, vfsApps: { "muhkoo-website": "mk_live_pk_site" } };
        state.exitCode = 1;
        await expect(run()).resolves.toBeUndefined();
        expect(process.exit).not.toHaveBeenCalled();
        expect(out()).toContain("The site is live, but copying the project to /apps/muhkoo-website failed");
        expect(out()).toContain("Retry with: muhkoo vfs import . --path /apps/muhkoo-website");
    });

    it("with no login (CI, an app key only) it deploys and says in one line why it did not copy", async () => {
        state.cfg = {};
        await run();
        expect(out()).toContain("Deployed.");
        expect(out()).toContain("Not signed in, so the project was not copied to your filesystem");
        expect(state.spawns).toHaveLength(0);
    });

    it("a skipped copy is a warning, repeated in the closing summary", async () => {
        state.cfg = {};
        await run();
        const reason = "Not signed in, so the project was not copied to your filesystem";
        expect(printed.filter((l) => l.includes(reason))).toHaveLength(2);
        expect(out()).toContain("⚠");
        expect(out().lastIndexOf(reason)).toBeGreaterThan(out().indexOf("Deployed."));
        expect(out().trimEnd().split("\n").pop()).toContain("Not signed in");
    });

    it("an unpaired, non-interactive deploy says so in the summary", async () => {
        state.cfg = { token: "tok", base: "prod" };
        await run();
        expect(printed.filter((l) => l.includes("This machine is not paired"))).toHaveLength(2);
        expect(state.spawns).toHaveLength(0);
    });

    it("a failed copy is repeated in the closing summary too", async () => {
        state.cfg = { ...PAIRED };
        state.exitCode = 1;
        await run();
        expect(printed.filter((l) => l.includes("copying the project to /apps/muhkoo-website failed"))).toHaveLength(2);
    });
});

describe("planCopy", () => {
    const base = { args: {}, baseUrl: PROD, appId: "a1", dir: "/work/site", env: {}, interactive: false };
    const record = {
        appId: "a1",
        slug: "fick-calc",
        keys: [
            { env: "live", type: "sk", plaintext: "mk_live_sk_secret" },
            { env: "live", type: "pk", plaintext: "mk_live_pk_fick" },
            { env: "test", type: "sk", plaintext: "mk_test_sk_secret" },
            { env: "test", type: "pk", plaintext: "mk_test_pk_fick" },
        ],
    };

    it("skips when signed in to the other environment", async () => {
        const plan = await planCopy({ ...base, cfg: { ...PAIRED, base: "staging" } });
        expect(plan.skip).toContain(`Signed in to ${STAGING}, not ${PROD}`);
    });

    it("takes an explicit token to be for the base being deployed to", async () => {
        const plan = await planCopy({ ...base, args: { token: "t2" }, cfg: { ...PAIRED, base: "staging" } });
        expect(plan.skip).toBeUndefined();
        expect(plan.token).toBe("t2");
    });

    it("with a session and a pairing and NO key, returns a plan; no app key is ever carried", async () => {
        app.body = { slug: "fick-calc" };
        const plan = await planCopy({ ...base, record, cfg: PAIRED });
        expect(plan.skip).toBeUndefined();
        expect(plan).toMatchObject({ root: "/apps/fick-calc", dir: "/work/site", base: PROD, token: "tok" });
        expect(plan).not.toHaveProperty("key");
        expect(plan.note).toBeUndefined();
        const bare = await planCopy({ ...base, cfg: PAIRED });
        expect(bare.skip).toBeUndefined();
        expect(bare.root).toBe("/apps/fick-calc");
    });

    it("falls back to the record's slug when the lookup fails, for the same app only", async () => {
        app = { status: 500, body: { error: "boom" } };
        const same = await planCopy({ ...base, record, cfg: PAIRED });
        expect(same.root).toBe("/apps/fick-calc");

        const other = await planCopy({ ...base, record: { ...record, appId: "other" }, cfg: PAIRED });
        expect(other.skip).toContain("Could not look up the app's slug (500)");
    });

    it("skips an unpaired machine with no terminal; a terminal or MUHKOO_SEED can unlock", async () => {
        const cfg = { token: "tok", base: "prod" };
        const skipped = await planCopy({ ...base, cfg });
        expect(skipped.skip).toContain("This machine is not paired");
        expect(skipped.skip).toContain("muhkoo vfs import . --path /apps/muhkoo-website");

        expect((await planCopy({ ...base, cfg, interactive: true })).skip).toBeUndefined();
        expect((await planCopy({ ...base, cfg, env: { MUHKOO_SEED: "seed" } })).skip).toBeUndefined();
    });
});

describe("muhkoo deploy --json", () => {
    afterEach(async () => (await import("../src/lib/ui.js")).setJsonMode(false));

    it("prints one result object with the release, the URL and the filesystem copy", async () => {
        const ui = await import("../src/lib/ui.js");
        ui.setJsonMode(true);
        state.cfg = { ...PAIRED };
        const stdout = [];
        console.log.mockImplementation((...a) => stdout.push(a.join(" ")));
        await run("--json");
        expect(stdout).toHaveLength(1);
        const result = JSON.parse(stdout[0]);
        expect(result).toMatchObject({
            appId: "a1",
            base: PROD,
            releaseId: "rel_1",
            files: 1,
            url: "https://muhkoo-website.apps.muhkoo.dev",
            filesystem: { copied: true, warnings: [] },
        });
        // The copy's own output must not land in the result's stdout.
        expect(state.spawns[0].opts.stdio).toEqual(["ignore", 2, 2]);
    });

    it("reports a skipped copy in the result", async () => {
        const ui = await import("../src/lib/ui.js");
        ui.setJsonMode(true);
        const stdout = [];
        console.log.mockImplementation((...a) => stdout.push(a.join(" ")));
        await run("--json");
        const result = JSON.parse(stdout[0]);
        expect(result.filesystem.copied).toBe(false);
        expect(result.filesystem.warnings.join(" ")).toMatch(/Not signed in/);
    });
});

describe("C-2: under the MCP server, deploy only ever reaches test", () => {
    beforeEach(() => vi.stubEnv("MUHKOO_NONINTERACTIVE", "1"));

    it("a session deploy asks hosting for the test environment", async () => {
        state.cfg = { token: "tok", base: "prod" };
        await deploy(parseArgs(["deploy", "--app", "a1", "--dist", dist, "--no-vfs"]));
        const hosting = urls.filter((u) => u.includes("/hosting/"));
        expect(hosting.length).toBeGreaterThan(0);
        for (const u of hosting) expect(u).toMatch(/[?&]env=test\b/);
    });

    it("refuses a live secret key", async () => {
        await expect(deploy(parseArgs(["deploy", "--app", "a1", "--key", "mk_live_sk_abcdef", "--dist", dist]))).rejects.toThrow(/exit 1/);
        expect(out()).toMatch(/only deploys to test/);
    });

    it("says test in the result", async () => {
        const ui = await import("../src/lib/ui.js");
        ui.setJsonMode(true);
        const stdout = [];
        console.log.mockImplementation((...a) => stdout.push(a.join(" ")));
        try {
            await run("--json", "--no-vfs");
        } finally {
            ui.setJsonMode(false);
        }
        expect(JSON.parse(stdout[0]).env).toBe("test");
    });
});

describe("deploy goes to test unless --prod", () => {
    const hosting = () => urls.filter((u) => u.includes("/hosting/"));
    const resultOf = async (argv) => {
        const ui = await import("../src/lib/ui.js");
        ui.setJsonMode(true);
        const stdout = [];
        console.log.mockImplementation((...a) => stdout.push(a.join(" ")));
        try {
            await deploy(parseArgs(["deploy", "--app", "a1", "--dist", dist, "--no-vfs", "--json", ...argv]));
        } finally {
            ui.setJsonMode(false);
        }
        return JSON.parse(stdout[0]);
    };

    it("a session deploy from a terminal goes to test", async () => {
        state.cfg = { token: "tok", base: "prod" };
        const r = await resultOf([]);
        expect(hosting().length).toBeGreaterThan(0);
        for (const u of hosting()) expect(u).toMatch(/[?&]env=test\b/);
        expect(r.env).toBe("test");
    });

    it("--prod with a session goes to production", async () => {
        state.cfg = { token: "tok", base: "prod" };
        const r = await resultOf(["--prod"]);
        for (const u of hosting()) expect(u).not.toMatch(/env=test/);
        expect(r.env).toBe("live");
    });

    it("refuses a live secret key without --prod", async () => {
        await expect(deploy(parseArgs(["deploy", "--app", "a1", "--key", "mk_live_sk_abcdef", "--dist", dist]))).rejects.toThrow(/exit 1/);
        expect(out()).toMatch(/--prod/);
        expect(hosting()).toHaveLength(0);
    });

    it("a live secret key with --prod goes to production", async () => {
        const r = await resultOf(["--key", "mk_live_sk_abcdef", "--prod"]);
        expect(r.env).toBe("live");
    });

    it("refuses a test secret key with --prod", async () => {
        await expect(deploy(parseArgs(["deploy", "--app", "a1", "--key", "mk_test_sk_abcdef", "--dist", dist, "--prod"]))).rejects.toThrow(/exit 1/);
        expect(out()).toMatch(/live secret key/);
        expect(hosting()).toHaveLength(0);
    });

    it("--prod in a provisioned app uses the record's live key", async () => {
        const dir = await mkdtemp(join(tmpdir(), "muhkoo-deploy-rec-"));
        await writeFile(join(dir, ".muhkoo-app.json"), JSON.stringify({
            appId: "a1",
            keys: [
                { env: "test", type: "sk", plaintext: "mk_test_sk_fromrecord" },
                { env: "live", type: "sk", plaintext: "mk_live_sk_fromrecord" },
            ],
        }));
        const auths = [];
        const inner = globalThis.fetch;
        vi.stubGlobal("fetch", async (url, init = {}) => {
            auths.push(new Headers(init.headers).get("authorization"));
            return inner(url, init);
        });
        const cwd = process.cwd();
        process.chdir(dir);
        try {
            expect((await resultOf(["--prod"])).env).toBe("live");
        } finally {
            process.chdir(cwd);
            await rm(dir, { recursive: true, force: true });
        }
        expect(auths.filter(Boolean).every((a) => a.includes("mk_live_sk_fromrecord"))).toBe(true);
    });

    it("refuses --prod under the MCP server", async () => {
        vi.stubEnv("MUHKOO_NONINTERACTIVE", "1");
        state.cfg = { token: "tok", base: "prod" };
        await expect(deploy(parseArgs(["deploy", "--app", "a1", "--dist", dist, "--prod"]))).rejects.toThrow(/exit 1/);
        expect(hosting()).toHaveLength(0);
    });
});
