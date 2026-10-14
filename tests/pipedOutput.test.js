/**
 * Output piped to another program arrives whole.
 *
 * Runs the real binary (`bin/muhkoo.js` → `kv ls` → the real SDK) against a
 * local stand-in for the API, with its stdout a pipe, as in
 * `muhkoo kv ls vfs/ | wc -l` or `muhkoo kv ls vfs/ --json | jq`.
 *
 * Two bugs broke this:
 * - The launcher exited straight after the command returned. On macOS a write
 *   to a pipe is asynchronous, so everything past the first 64 KiB was dropped,
 *   and the exit code was still 0.
 * - The SDK printed `[@muhkoo/connect] initialized — v…` to stdout, in front of
 *   the keys, so `--json` was not JSON and `wc -l` counted it as a key.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "muhkoo.js");

const COMMITMENT = "1234";
/** 20,000 keys of 46 bytes: about 0.9 MB a listing, far past a 64 KiB pipe buffer. Sorted, as the server returns them. */
const KEYS = Array.from({ length: 20000 }, (_, i) => `vfs/d/${i.toString(16).padStart(40, "0")}`);
const PAGE = 1000;

/** The API calls `kv ls` makes: the session check, then the paged personal-space list. */
function api(req, res) {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
        const send = (status, body) => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(body));
        };
        const body = raw ? JSON.parse(raw) : {};
        if (req.method === "POST" && req.url === "/api/auth/verify") return send(200, { username: "someone" });
        if (req.method === "POST" && req.url === `/api/personal/${COMMITMENT}/list`) {
            const prefix = body.prefix ?? "";
            const after = typeof body.cursor === "string" ? Buffer.from(body.cursor, "base64url").toString("utf8") : null;
            const under = KEYS.filter((k) => k.startsWith(prefix) && (after === null || k > after));
            const keys = under.slice(0, PAGE);
            const cursor = under.length > PAGE ? Buffer.from(keys[keys.length - 1], "utf8").toString("base64url") : null;
            return send(200, { keys, cursor });
        }
        send(404, { error: "not found" });
    });
}

let server;
let base;
let home;
beforeAll(async () => {
    server = createServer(api);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    home = mkdtempSync(join(tmpdir(), "muhkoo-pipe-home-"));
    mkdirSync(join(home, ".muhkoo"), { mode: 0o700 });
    writeFileSync(
        join(home, ".muhkoo", "config.json"),
        JSON.stringify({ token: "t".repeat(64), username: "someone", commitment: COMMITMENT }),
        { mode: 0o600 },
    );
});
afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
});

/** Run the CLI with its stdout a pipe, read to the end. Nothing from the caller's own login or MUHKOO_* settings leaks in. */
function cli(...args) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("MUHKOO_")));
    const child = spawn(process.execPath, [bin, ...args, "--base", base], {
        env: { ...env, HOME: home, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    let err = "";
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => (err += d));
    return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: err }));
    });
}

describe("piped output", () => {
    it("`kv ls` prints every key, and only keys, past 64 KiB", async () => {
        const { code, stdout, stderr } = await cli("kv", "ls", "vfs/");
        expect(code, stderr).toBe(0);
        expect(Buffer.byteLength(stdout)).toBeGreaterThan(64 * 1024);
        const lines = stdout.split("\n");
        expect(lines.pop()).toBe("");
        expect(lines.length).toBe(KEYS.length);
        expect(lines).toEqual(KEYS);
    }, 60_000);

    it("`kv ls --json` is one whole JSON array, past 64 KiB", async () => {
        const { code, stdout, stderr } = await cli("kv", "ls", "vfs/", "--json");
        expect(code, stderr).toBe(0);
        expect(Buffer.byteLength(stdout)).toBeGreaterThan(64 * 1024);
        expect(JSON.parse(stdout)).toEqual(KEYS);
    }, 60_000);
});
