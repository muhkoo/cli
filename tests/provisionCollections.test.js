/**
 * `muhkoo provision` collections step over a stubbed `fetch`: the PUTs it
 * sends after the tables, the 402 skip, the 409 die, --dry-run and the record.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/lib/args.js";

vi.mock("../src/lib/config.js", () => ({
    devContext: async () => ({ baseUrl: "http://x", token: "t" }),
    resolveBase: async () => "http://x",
}));

const { default: provision } = await import("../src/commands/provision.js");

let printed;
let requests;
let route;
let dir;
const out = () => printed.join("\n");

const DOCS = { name: "docs", mode: "text", model: "bge-base-en-v1.5", fields: [{ name: "category", type: "string" }], access: "app" };
const NOTES = { name: "notes", mode: "vectors", dimensions: 384 };

beforeEach(async () => {
    printed = [];
    requests = [];
    route = () => ({ status: 202, body: {} });
    dir = await mkdtemp(join(tmpdir(), "prov-"));
    vi.spyOn(console, "log").mockImplementation((...a) => printed.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => printed.push(a.join(" ")));
    vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`exit ${code}`);
    });
    vi.stubGlobal("fetch", async (url, init) => {
        const path = url.replace("http://x", "");
        const req = { path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
        requests.push(req);
        let r;
        if (path === "/api/developer/me") r = { status: 200, body: {} };
        else if (path.includes("/db/tables/")) r = { status: 200, body: { version: 1 } };
        else if (path.endsWith("/functions") && req.method === "GET") r = { status: 200, body: { functions: [] } };
        else if (path.endsWith("/functions")) r = { status: 200, body: { config: { functionId: "fn1" } } };
        else r = route(req);
        return new Response(JSON.stringify(r.body), { status: r.status });
    });
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function run(spec, ...extra) {
    const specPath = join(dir, "app.json");
    const outPath = join(dir, "out.json");
    await writeFile(specPath, JSON.stringify(spec));
    // A prior record means the app is reused: no create call.
    await writeFile(outPath, JSON.stringify({ appId: "app1", slug: "s", keys: [] }));
    await provision(parseArgs(["provision", "--spec", specPath, "--out", outPath, ...extra]));
    return outPath;
}

const tableSpec = { table: "t1", columns: [] };
const collPuts = () => requests.filter((r) => r.path.includes("/vectors/collections/"));

describe("muhkoo provision collections", () => {
    it("provision PUTs each collection after the tables", async () => {
        route = (req) => ({ status: req.path.endsWith("/docs") ? 202 : 200, body: {} });
        await run({ tables: [tableSpec], collections: [DOCS, NOTES] });
        const puts = collPuts();
        expect(puts.map((r) => [r.method, r.path])).toEqual([
            ["PUT", "/api/apps/app1/vectors/collections/docs"],
            ["PUT", "/api/apps/app1/vectors/collections/notes"],
        ]);
        const { name, ...def } = DOCS;
        expect(puts[0].body).toEqual(def);
        const tableIdx = requests.findIndex((r) => r.path.includes("/db/tables/"));
        expect(tableIdx).toBeLessThan(requests.indexOf(puts[0]));
        expect(out()).toContain("✓ docs (202)");
        expect(out()).toContain("✓ notes (200)");
    });

    it("402 warns, skips, records paid-tier, and later steps still run", async () => {
        route = () => ({ status: 402, body: { error: "paid", requiresPaidTier: true, tier: "free", upgradeUrl: "u" } });
        const outPath = await run({ collections: [DOCS], functions: [{ name: "f1" }] });
        expect(out()).toContain("Vector search needs a paid plan — skipped docs. (Config saved for later.)");
        expect(requests.some((r) => r.path === "/api/apps/app1/functions" && r.method === "POST")).toBe(true);
        const rec = JSON.parse(await readFile(outPath, "utf8"));
        expect(rec.collections).toEqual([{ name: "docs", skipped: "paid-tier" }]);
        expect(rec.functions[0].functionId).toBe("fn1");
    });

    it("409 dies with the rm command in the message", async () => {
        route = () => ({
            status: 409,
            body: { error: 'Collection "docs" already exists with a different definition.', code: "collection_exists" },
        });
        await expect(run({ collections: [DOCS] })).rejects.toThrow("exit 1");
        expect(out()).toContain(
            'Collection "docs" already exists with a different definition. Definitions can\'t change: run `muhkoo vectors rm app1 docs` (deletes its entries), then provision again.',
        );
    });

    it("other errors die through ensure", async () => {
        route = () => ({ status: 409, body: { error: "This app has reached its collection limit.", code: "collection_limit" } });
        await expect(run({ collections: [DOCS] })).rejects.toThrow("exit 1");
        expect(out()).toContain('Collection "docs" failed (409)');
        expect(out()).toContain("This app has reached its collection limit.");
        expect(out()).toContain("collection_limit");
        expect(out()).not.toContain("muhkoo vectors rm");
    });

    it("--dry-run calls nothing for collections", async () => {
        await run({ collections: [DOCS, NOTES] }, "--dry-run");
        expect(collPuts()).toEqual([]);
        expect(out()).toContain('Collection "docs"');
        expect(out()).toContain('Collection "notes"');
    });

    it("the record written to --out holds collections", async () => {
        const outPath = await run({ collections: [DOCS] });
        const rec = JSON.parse(await readFile(outPath, "utf8"));
        expect(rec.collections).toEqual([{ name: "docs", status: 202 }]);
        expect(out()).toMatch(/collections:\s+docs \(202\)/);
    });
});
