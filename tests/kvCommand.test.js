/**
 * `muhkoo kv ls [prefix] [--json]` over the REAL SDK's `client.kv`, with a
 * fake personal space behind it that pages the way the server's key index
 * does: two keys a page, so every listing here crosses pages. The session is
 * mocked out, because listing keys needs no unlocked vault.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KvNamespace, HttpClient, SessionState } from "@muhkoo/connect";
import { parseArgs } from "../src/lib/args.js";

vi.mock("../src/lib/vfs.js", () => ({
    openSession: async () => globalThis.__muhkooKvClient,
}));

const { default: kvCommand } = await import("../src/commands/kv.js");

const KEYS = ["chat-keys", "notes/n1", "todos/t1", "todos/t2", "todos/t3", "vfs/d/root"];

/** The paged /list contract: sorted, filtered by prefix, two keys a page, opaque cursors. Records each body. */
async function serve(keys) {
    const bodies = [];
    const fetchFn = async (_input, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        const after = typeof body.cursor === "string" ? body.cursor.slice(2) : null;
        const under = [...keys].sort().filter((k) => k.startsWith(body.prefix ?? "") && (after === null || k > after));
        const page = under.slice(0, 2);
        const cursor = under.length > 2 ? `c:${page[page.length - 1]}` : null;
        return new Response(JSON.stringify({ keys: page, cursor }), { headers: { "Content-Type": "application/json" } });
    };
    const session = new SessionState();
    await session.setSession({ token: "t".repeat(64), username: "someone", commitment: "1234" });
    const http = new HttpClient({ baseUrl: "http://muhkoo.test", getSessionToken: () => session.token, fetch: fetchFn });
    globalThis.__muhkooKvClient = { kv: new KvNamespace({ http, session, wsBaseUrl: "ws://muhkoo.test" }) };
    return bodies;
}

let printed;
let errWritten;
/** Everything printed to stdout, one entry per line (`info` prints its lines in one call). */
const out = () => printed.join("\n").split("\n");
/** Everything written straight to stderr via `process.stderr.write` (hints, not `die`). */
const errOut = () => errWritten.join("");
beforeEach(() => {
    printed = [];
    errWritten = [];
    vi.spyOn(console, "log").mockImplementation((...a) => printed.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => printed.push(a.join(" ")));
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        errWritten.push(String(chunk));
        return true;
    });
    vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`exit ${code}`);
    });
});
afterEach(() => vi.restoreAllMocks());

const run = (...argv) => kvCommand(parseArgs(["kv", ...argv]));

describe("muhkoo kv ls", () => {
    it("prints the keys under a prefix, one a line, paging through the SDK", async () => {
        const bodies = await serve(KEYS);
        await run("ls", "todos/");
        expect(out()).toEqual(["todos/t1", "todos/t2", "todos/t3"]);
        expect(bodies).toEqual([{ prefix: "todos/" }, { prefix: "todos/", cursor: "c:todos/t2" }]);
    });

    it("lists every key with no prefix, and with no subcommand", async () => {
        await serve(KEYS);
        await run("ls");
        expect(out()).toEqual([...KEYS].sort());
        printed.length = 0;
        await run();
        expect(out()).toEqual([...KEYS].sort());
    });

    it("--json prints a JSON array", async () => {
        await serve(KEYS);
        await run("ls", "notes/", "--json");
        expect(JSON.parse(printed.join("\n"))).toEqual(["notes/n1"]);
    });

    it("takes the prefix from after --json too (the parser hands it to the flag)", async () => {
        await serve(KEYS);
        await run("ls", "--json", "todos/");
        expect(JSON.parse(printed.join("\n"))).toEqual(["todos/t1", "todos/t2", "todos/t3"]);
    });

    it("says so on stderr when nothing matches, and writes nothing to stdout", async () => {
        await serve(KEYS);
        await run("ls", "nope/");
        expect(printed).toEqual([]);
        expect(errOut()).toEqual('No keys start with "nope/".\n');
    });

    it("says the store is empty on stderr, with no prefix", async () => {
        await serve([]);
        await run("ls");
        expect(printed).toEqual([]);
        expect(errOut()).toEqual("Your personal store is empty.\n");
    });

    it("--json prints [] to stdout for an empty listing, and writes nothing to stderr", async () => {
        await serve(KEYS);
        await run("ls", "nope/", "--json");
        expect(JSON.parse(printed.join("\n"))).toEqual([]);
        expect(errWritten).toEqual([]);
    });

    it("a non-empty listing is unchanged: keys on stdout, nothing on stderr", async () => {
        await serve(KEYS);
        await run("ls", "todos/");
        expect(out()).toEqual(["todos/t1", "todos/t2", "todos/t3"]);
        expect(errWritten).toEqual([]);
    });

    it("escapes control characters in a key instead of handing them to the terminal", async () => {
        await serve(["evil/\u001b]52;c;aGk=\u0007", "evil/ok"]);
        await run("ls", "evil/");
        expect(out()).toEqual(["evil/\\u001b]52;c;aGk=\\u0007", "evil/ok"]);
    });

    it("refuses an unknown subcommand, a second prefix, and --json before the subcommand", async () => {
        await serve(KEYS);
        await expect(run("rm", "todos/t1")).rejects.toThrow("exit 1");
        await expect(run("ls", "a/", "b/")).rejects.toThrow("exit 1");
        // `kv --json ls todos/` parses as json: "ls" and reads as `kv todos/ ls`. Flags go after the subcommand, as with vfs.
        await expect(run("--json", "ls", "todos/")).rejects.toThrow("exit 1");
    });
});
