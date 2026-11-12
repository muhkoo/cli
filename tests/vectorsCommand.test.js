/**
 * `muhkoo vectors` owner commands over a stubbed `fetch`: the requests they
 * send, what they print, and how `create` waits.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseArgs } from "../src/lib/args.js";

vi.mock("../src/lib/config.js", () => ({
    devContext: async () => ({ baseUrl: "http://x", token: "t" }),
    resolveBase: async () => "http://x",
}));

const { default: vectors } = await import("../src/commands/vectors.js");

let printed;
let requests;
let replies;
const out = () => printed.join("\n");

/** Each fetch takes the next scripted reply ({ status, body }); the last one repeats. */
function script(...list) {
    replies = list;
}

beforeEach(() => {
    printed = [];
    requests = [];
    replies = [];
    vi.spyOn(console, "log").mockImplementation((...a) => printed.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => printed.push(a.join(" ")));
    vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`exit ${code}`);
    });
    vi.stubGlobal("fetch", async (url, init) => {
        requests.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
        const r = replies.length > 1 ? replies.shift() : replies[0];
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const run = (...argv) => vectors(parseArgs(["vectors", ...argv]));

const env = (status, entries, error = null) => ({ status, entries, notices: { spaces: [], defaultSpace: null }, error });
const info = (name, status, envs) => ({
    name, mode: "text", model: "bge-base-en-v1.5", dimensions: 768, metric: "cosine", fields: [], access: "app",
    createdAt: 1, status, envs: envs ?? { live: env(status, null), test: env(status, null) },
});

describe("muhkoo vectors", () => {
    it("ls prints a table with entry counts", async () => {
        script({ body: { collections: [info("docs", "ready", { live: env("ready", 12), test: env("ready", null) })] } });
        await run("ls", "app1");
        expect(requests[0].url).toBe("http://x/api/apps/app1/vectors/collections");
        expect(requests[0].method).toBe("GET");
        expect(out()).toMatch(/NAME\s+MODE\s+MODEL\/DIMS\s+ACCESS\s+STATUS\s+LIVE\s+TEST/);
        expect(out()).toMatch(/docs\s+text\s+bge-base-en-v1\.5\s+app\s+ready\s+12\s+—/);
        expect(out()).not.toContain("t\n");
    });

    it("ls --json prints the array", async () => {
        const c = info("docs", "ready");
        script({ body: { collections: [c] } });
        await run("ls", "app1", "--json");
        expect(JSON.parse(out())).toEqual([c]);
    });

    it("ls with no collections says how to create one", async () => {
        script({ body: { collections: [] } });
        await run("ls", "app1");
        expect(out()).toContain("No collections. Create one with `muhkoo vectors create`.");
    });

    it("create maps flags to the definition body", async () => {
        script({ status: 202, body: info("docs", "creating") });
        await run("create", "app1", "docs", "--mode", "vectors", "--dimensions", "384", "--fields", "a:string,b:number", "--no-wait");
        expect(requests).toHaveLength(1);
        expect(requests[0].method).toBe("PUT");
        expect(requests[0].url).toBe("http://x/api/apps/app1/vectors/collections/docs");
        expect(requests[0].body).toEqual({ mode: "vectors", dimensions: 384, fields: [{ name: "a", type: "string" }, { name: "b", type: "number" }] });
    });

    it("create dies naming a malformed field", async () => {
        await expect(run("create", "app1", "docs", "--mode", "text", "--fields", "a:string,oops")).rejects.toThrow("exit 1");
        expect(out()).toContain('"oops"');
        expect(requests).toHaveLength(0);
    });

    it("create --no-wait returns after the PUT", async () => {
        script({ status: 202, body: info("docs", "creating") });
        await run("create", "app1", "docs", "--mode", "text", "--no-wait");
        expect(requests).toHaveLength(1);
        expect(requests[0].body).toEqual({ mode: "text" });
    });

    it("create on a Free plan prints the server's error and exits 1", async () => {
        script({ status: 402, body: { error: "Vector search requires a paid plan. Upgrade to create or use collections.", requiresPaidTier: true, tier: "free", upgradeUrl: "/x" } });
        await expect(run("create", "app1", "docs", "--mode", "text")).rejects.toThrow("exit 1");
        expect(out()).toContain("Vector search requires a paid plan.");
        expect(requests).toHaveLength(1);
    });

    it("create waits through creating to ready", async () => {
        vi.useFakeTimers();
        script(
            { status: 202, body: info("docs", "creating") },
            { body: info("docs", "creating") },
            { body: info("docs", "ready") },
        );
        const p = run("create", "app1", "docs", "--mode", "text");
        await vi.runAllTimersAsync();
        await p;
        expect(requests.map((r) => r.method)).toEqual(["PUT", "GET", "GET"]);
        expect(requests[1].url).toBe("http://x/api/apps/app1/vectors/collections/docs");
        expect(out()).toContain("creating");
        expect(out()).toContain("Collection docs is ready.");
    });

    it("create on a collection that ends failed prints each env's error and exits 1", async () => {
        vi.useFakeTimers();
        script(
            { status: 202, body: info("docs", "creating") },
            { body: info("docs", "failed", { live: env("failed", null, "live broke"), test: env("failed", null, "test broke") }) },
        );
        const p = run("create", "app1", "docs", "--mode", "text");
        const done = expect(p).rejects.toThrow("exit 1");
        await vi.runAllTimersAsync();
        await done;
        expect(out()).toContain("live broke");
        expect(out()).toContain("test broke");
    });

    it("create gives up after 10 minutes", async () => {
        vi.useFakeTimers();
        script({ status: 202, body: info("docs", "creating") }, { body: info("docs", "creating") });
        const p = run("create", "app1", "docs", "--mode", "text");
        const done = expect(p).rejects.toThrow("exit 1");
        await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
        await done;
        expect(out()).toContain("Still creating after 10 minutes; check with `muhkoo vectors get app1 docs`.");
        const gets = requests.filter((r) => r.method === "GET").length;
        expect(gets).toBeGreaterThan(250);
        expect(gets).toBeLessThanOrEqual(301);
    });

    it("rm sends DELETE", async () => {
        script({ status: 202, body: { name: "docs", status: "dropping" } });
        await run("rm", "app1", "docs");
        expect(requests[0].method).toBe("DELETE");
        expect(requests[0].url).toBe("http://x/api/apps/app1/vectors/collections/docs");
        expect(out()).toContain("Dropping collection docs; its entries in test and live are deleted.");
    });

    it("create on a 409 collection_exists prints the server's sentence and code", async () => {
        script({ status: 409, body: { error: 'Collection "docs" already exists with a different definition.\u001b[31m', code: "collection_exists" } });
        await expect(run("create", "app1", "docs", "--mode", "text")).rejects.toThrow("exit 1");
        expect(out()).toContain('Create collection failed (409): Collection "docs" already exists with a different definition.\\u001b[31m (collection_exists)');
        expect(out()).not.toContain('{"error"');
    });

    it("rm on a 503 vectors_unavailable prints the server's sentence and code", async () => {
        script({ status: 503, body: { error: "Vector search is unavailable right now.", code: "vectors_unavailable" } });
        await expect(run("rm", "app1", "docs")).rejects.toThrow("exit 1");
        expect(out()).toContain("Drop collection failed (503): Vector search is unavailable right now. (vectors_unavailable)");
    });

    it("a 429 vector_rate_limited shows its Retry-After", async () => {
        script({ status: 429, headers: { "Retry-After": "7" }, body: { error: "Too many collection changes.", code: "vector_rate_limited" } });
        await expect(run("create", "app1", "docs", "--mode", "text")).rejects.toThrow("exit 1");
        expect(out()).toContain("Create collection failed (429): Too many collection changes. (vector_rate_limited) Retry after 7 seconds.");
    });

    it("notices sends the env and body, and --default must be listed", async () => {
        script({ body: { env: "test", spaces: ["s1", "s2"], defaultSpace: "s2" } });
        await run("notices", "app1", "docs", "--env", "test", "--spaces", "s1,s2", "--default", "s2");
        expect(requests[0].method).toBe("PATCH");
        expect(requests[0].url).toBe("http://x/api/apps/app1/vectors/collections/docs/notices?env=test");
        expect(requests[0].body).toEqual({ spaces: ["s1", "s2"], defaultSpace: "s2" });

        requests = [];
        await expect(run("notices", "app1", "docs", "--env", "test", "--spaces", "s1", "--default", "s9")).rejects.toThrow("exit 1");
        expect(requests).toHaveLength(0);
    });

    it('notices --spaces "" clears the list', async () => {
        script({ body: { env: "live", spaces: [], defaultSpace: null } });
        await run("notices", "app1", "docs", "--env", "live", "--spaces", "");
        expect(requests[0].body).toEqual({ spaces: [], defaultSpace: null });
    });

    it("notices refuses an env other than live or test", async () => {
        await expect(run("notices", "app1", "docs", "--env", "prod", "--spaces", "s1")).rejects.toThrow("exit 1");
        expect(requests).toHaveLength(0);
    });

    it("-k is refused with the two-dash hint", async () => {
        await expect(run("ls", "app1", "-k", "mk_test_x_y")).rejects.toThrow("exit 1");
        expect(out()).toContain('Unknown option "-k". Options use two dashes, e.g. --key.');
        expect(requests).toHaveLength(0);
    });
});

describe("muhkoo vectors query", () => {
    const KEY = "mk_test_app1_secretsecret";
    afterEach(() => {
        delete process.env.MUHKOO_APP_KEY;
    });

    it("query sends Bearer <key> to /api/vectors/docs/query with text, topK and filter", async () => {
        script({ body: { matches: [{ id: "a", score: 0.9, data: { k: 1 } }] } });
        await run("query", "docs", "--text", "hello", "--topk", "3", "--filter", '{"k":1}', "--key", KEY);
        expect(requests[0].url).toBe("http://x/api/vectors/docs/query");
        expect(requests[0].method).toBe("POST");
        expect(requests[0].headers.Authorization ?? requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
        expect(requests[0].body).toEqual({ text: "hello", topK: 3, filter: { k: 1 } });
        expect(out()).toMatch(/ID\s+SCORE\s+DATA/);
        expect(out()).not.toContain(KEY);
    });

    it("--with-text asks for text and shows a TEXT column", async () => {
        script({ body: { matches: [{ id: "a", score: 0.5, data: {}, text: "the body" }] } });
        await run("query", "docs", "--vector", "[0.1,0.2]", "--with-text", "--key", KEY);
        expect(requests[0].body).toEqual({ vector: [0.1, 0.2], includeText: true });
        expect(out()).toMatch(/ID\s+SCORE\s+DATA\s+TEXT/);
        expect(out()).toContain("the body");
    });

    it("--json prints matches", async () => {
        const matches = [{ id: "a", score: 0.5, data: {} }];
        script({ body: { matches } });
        await run("query", "docs", "--text", "q", "--key", KEY, "--json");
        expect(JSON.parse(out())).toEqual(matches);
    });

    it("MUHKOO_APP_KEY is used when --key is absent", async () => {
        process.env.MUHKOO_APP_KEY = KEY;
        script({ body: { matches: [] } });
        await run("query", "docs", "--text", "q");
        expect(requests[0].headers.Authorization ?? requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
    });

    it("no key dies with the tokens hint", async () => {
        await expect(run("query", "docs", "--text", "q")).rejects.toThrow("exit 1");
        expect(out()).toContain("No app key. Pass --key <mk_…> or set MUHKOO_APP_KEY (`muhkoo tokens create` mints one).");
        expect(requests).toHaveLength(0);
    });

    it("bad --filter JSON dies naming the flag", async () => {
        await expect(run("query", "docs", "--text", "q", "--filter", "{nope", "--key", KEY)).rejects.toThrow("exit 1");
        expect(out()).toMatch(/--filter is not valid JSON: \S/);
        expect(requests).toHaveLength(0);
    });

    it("bad --vector JSON dies naming the flag", async () => {
        await expect(run("query", "docs", "--vector", "[1,", "--key", KEY)).rejects.toThrow("exit 1");
        expect(out()).toMatch(/--vector is not valid JSON: \S/);
        expect(requests).toHaveLength(0);
    });

    it("both --text and --vector dies", async () => {
        await expect(run("query", "docs", "--text", "q", "--vector", "[1]", "--key", KEY)).rejects.toThrow("exit 1");
        expect(requests).toHaveLength(0);
    });

    it("neither --text nor --vector dies", async () => {
        await expect(run("query", "docs", "--key", KEY)).rejects.toThrow("exit 1");
        expect(requests).toHaveLength(0);
    });

    it("output truncates DATA to 60 chars", async () => {
        const long = "x".repeat(100);
        script({ body: { matches: [{ id: "a", score: 0.5, data: { long } }] } });
        await run("query", "docs", "--text", "q", "--key", KEY);
        const shown = JSON.stringify({ long }).slice(0, 59) + "…";
        expect(out()).toContain(shown);
        expect(out()).not.toContain(JSON.stringify({ long }).slice(0, 61));
    });

    it("a server error prints its message, escaped, and exits 1", async () => {
        script({ status: 409, body: { error: "not ready\u001b[31m", code: "collection_not_ready" } });
        await expect(run("query", "docs", "--text", "q", "--key", KEY)).rejects.toThrow("exit 1");
        expect(out()).toContain("not ready\\u001b[31m");
        expect(out()).not.toContain(KEY);
    });
});
