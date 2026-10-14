/**
 * End-to-end reproductions of the 2026-09 audit of `vfs mount` / `vfs import`.
 *
 * Each case is the audit's own scenario (ids in brackets), run against the REAL
 * `VfsNamespace` wherever the bug lived in how the two packages meet — a fake
 * whose `exists("/")` is true is exactly how the root-"/" bug slipped through.
 *
 * Threat model, as in mount.test.js: anything able to write a user's VFS (every
 * app they sign into holds the seed) chooses remote paths, names and bytes. It
 * cannot touch local disk directly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import {
    mkdtemp, mkdir, writeFile, readFile, symlink, link, rm, readdir, lstat, chmod, truncate, stat, appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { VfsNamespace } from "@muhkoo/connect";
import { reconcile, importOnce, mount, previewMount, acceptIgnores, heldBack, PULL_BUDGET, scanRemote, SCAN_CONCURRENCY, SCAN_WINDOW_BYTES } from "../src/lib/mount.js";
import { ignoreFileProblem } from "../src/lib/ignore.js";
import { filesOf } from "../src/lib/syncPlan.js";

const enc = (s) => new TextEncoder().encode(s);
/** The state's files: folders are recorded too, under a trailing slash. */
const fileKeys = (state) => Object.keys(state).filter((k) => !k.endsWith("/"));
const dec = (b) => new TextDecoder().decode(b);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** `vfs ignore <dir> --accept`, then `--accept <digest>` with the digest it showed. */
const accept = async (dir) => acceptIgnores(dir, (await heldBack(dir)).digest);

/** The real VfsNamespace over an in-memory record store and content store. */
function realVfs() {
    const records = new Map();
    const store = {
        async get(k) { return records.get(k) ?? null; },
        async put(k, v) { records.set(k, v); },
        async delete(k) { records.delete(k); },
        async list() { return [...records.keys()]; },
    };
    const blobs = new Map();
    let n = 0;
    const content = {
        blobs,
        async write(data, meta) {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
            const id = `m${++n}`;
            blobs.set(id, { bytes: new Uint8Array(bytes), refs: 1 });
            return { manifest: { id, name: meta.name, size: bytes.length, type: meta.type }, size: bytes.length };
        },
        async read(m) {
            const e = blobs.get(m.id);
            if (!e) throw new Error("content missing");
            return e.bytes;
        },
        async retain(m) { const e = blobs.get(m.id); if (e) e.refs++; },
        async release(m) { const e = blobs.get(m.id); if (e && --e.refs <= 0) blobs.delete(m.id); },
    };
    const seed = new Uint8Array(32).fill(9);
    return { vfs: new VfsNamespace({ store, content, seed: () => seed }), content };
}

/** Count calls through to a vfs, without changing what they do. */
function counting(vfs) {
    const calls = { walk: 0, readFile: 0, readByManifest: 0, writeFile: 0, delete: 0, stat: 0 };
    const wrapped = new Proxy(vfs, {
        get(target, key) {
            const value = target[key];
            if (typeof value !== "function") return value;
            return (...args) => {
                if (key in calls) calls[key]++;
                return value.apply(target, args);
            };
        },
    });
    return { vfs: wrapped, calls };
}

/** A small in-memory vfs, for sizes and failures the real one makes expensive. */
function memVfs(files = {}, { sizes = {}, unreadable = [] } = {}) {
    const data = new Map(Object.entries(files).map(([k, v]) => [k, enc(v)]));
    const calls = { readFile: [], delete: [], writeFile: [] };
    const under = (root) => (p) => root === "/" || root === "" || p.startsWith(root + "/");
    return {
        data,
        calls,
        async exists(p) { return p === "/" || [...data.keys()].some((k) => k === p || k.startsWith(p + "/")); },
        async walk(root) { return [...data.keys()].filter(under(root)).sort(); },
        async stat(p) {
            if (!data.has(p)) throw new Error(`no such file ${p}`);
            return { path: p, kind: "file", size: sizes[p] ?? data.get(p).length };
        },
        async readFile(p) {
            calls.readFile.push(p);
            if (unreadable.includes(p)) throw new Error("content missing");
            if (sizes[p] !== undefined) throw new Error(`read ${p}, which is over the size limit`);
            return data.get(p);
        },
        async writeFile(p, b) { calls.writeFile.push(p); data.set(p, b); },
        async delete(p) { calls.delete.push(p); data.delete(p); },
        watch() { return () => {}; },
    };
}

async function put(root, rel, text) {
    const p = join(root, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text);
}
const exists = (p) => lstat(p).then(() => true, () => false);
const read = (p) => readFile(p, "utf8");

/** Every console line the sync prints, for asserting on warnings. */
let lines;
beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation((...a) => lines.push(a.join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// The ignore ratchet keeps a copy of its rules under ~/.muhkoo: a HOME of
// our own, so no test reads or writes the real one.
let realHome;
beforeAll(async () => {
    realHome = process.env.HOME;
    process.env.HOME = await mkdtemp(join(tmpdir(), "muhkoo-audit-home-"));
});
afterAll(async () => {
    const fake = process.env.HOME;
    process.env.HOME = realHome;
    await rm(fake, { recursive: true, force: true });
});

const temps = [];
async function tmp(label) {
    const d = await mkdtemp(join(tmpdir(), `muhkoo-${label}-`));
    temps.push(d);
    return d;
}
afterEach(async () => {
    while (temps.length) await rm(temps.pop(), { recursive: true, force: true });
});

/** Does this temp volume fold case / Unicode normalization the way APFS does? */
async function probeVolume() {
    const d = await mkdtemp(join(tmpdir(), "muhkoo-probe-"));
    try {
        await writeFile(join(d, "probe"), "x");
        await writeFile(join(d, "caf\u00e9"), "x");
        const ci = await lstat(join(d, "PROBE")).then(() => true, () => false);
        const ni = await lstat(join(d, "cafe\u0301")).then(() => true, () => false);
        return { ci, ni };
    } finally {
        await rm(d, { recursive: true, force: true });
    }
}
const volume = await probeVolume();

/** Run a mount for `ms`, then stop it and wait for it to finish. */
async function mountFor(ms, args) {
    const controller = new AbortController();
    // Settle-handler attached at once: a mount that refuses to start rejects
    // before the sleep ends, and must not surface as an unhandled rejection.
    const settled = mount({ ...args, signal: controller.signal }).then(() => null, (err) => err ?? new Error("rejected"));
    await Promise.race([sleep(ms), settled]);
    controller.abort();
    const err = await settled;
    if (err) throw err;
}

// ---------------------------------------------------------------------------

describe("the default root \"/\" [N1]", () => {
    it("pulls the remote tree and never reads its own uploads as remote deletions", async () => {
        const { vfs } = realVfs();
        await vfs.writeFile("/notes/todo.md", enc("remote note"));
        const dir = await tmp("n1");
        await put(dir, "a.txt", "local A");
        await put(dir, "b.txt", "local B");

        let state = await reconcile({ vfs, dir, root: "/", state: {}, opts: { allowDelete: true } });
        expect(await read(join(dir, "notes", "todo.md"))).toBe("remote note");
        state = await reconcile({ vfs, dir, root: "/", state, opts: { allowDelete: true } });
        state = await reconcile({ vfs, dir, root: "/", state, opts: { allowDelete: true } });

        expect(await read(join(dir, "a.txt"))).toBe("local A");
        expect(await read(join(dir, "b.txt"))).toBe("local B");
        expect((await vfs.walk("/")).sort()).toEqual(["/a.txt", "/b.txt", "/notes/todo.md"]);
        expect(fileKeys(state).sort()).toEqual(["/a.txt", "/b.txt", "/notes/todo.md"]);
    });

    it("does not re-upload the project on every pass", async () => {
        const { vfs } = realVfs();
        const { vfs: counted, calls } = counting(vfs);
        const dir = await tmp("n1-loop");
        await put(dir, "a.ts", "export const a = 1;\n");
        let state = {};
        for (let i = 0; i < 4; i++) state = await reconcile({ vfs: counted, dir, root: "/", state });
        expect(calls.writeFile).toBe(1);
    });

    it("mount() at \"/\" with --allow-delete leaves the project on disk", async () => {
        const { vfs } = realVfs();
        await vfs.writeFile("/notes/todo.md", enc("remote note"));
        const dir = await tmp("n1-mount");
        await put(dir, "a.txt", "local A");
        await mountFor(1200, { client: { vfs }, dir, root: "/", opts: { allowDelete: true } });
        expect(await read(join(dir, "a.txt"))).toBe("local A");
        expect(await read(join(dir, "notes", "todo.md"))).toBe("remote note");
    });
});

describe("refused paths are refused in BOTH directions [G7]", () => {
    async function project() {
        const dir = await tmp("g7");
        await put(dir, "index.js", "console.log(1)\n");
        await put(dir, ".git/HEAD", "ref: refs/heads/main\n");
        await put(dir, ".git/config", "[remote \"origin\"]\n\turl = https://x-access-token:ghp_SECRET@github.com/o/r.git\n");
        await put(dir, ".npmrc", "//registry.npmjs.org/:_authToken=npm_SECRET\n");
        await put(dir, ".netrc", "machine github.com login me password hunter2\n");
        return dir;
    }

    it("--hidden never uploads .git, .npmrc or .netrc, and does not loop", async () => {
        const { vfs } = realVfs();
        const { vfs: counted, calls } = counting(vfs);
        const dir = await project();
        let state = {};
        for (let i = 0; i < 4; i++) state = await reconcile({ vfs: counted, dir, root: "/apps/p", state, opts: { hidden: true } });
        expect(await vfs.walk("/apps/p")).toEqual(["/apps/p/index.js"]);
        expect(calls.writeFile).toBe(1);
    });

    it("--hidden --allow-delete never deletes the local repository", async () => {
        const { vfs } = realVfs();
        const dir = await project();
        let state = {};
        for (let i = 0; i < 3; i++) {
            state = await reconcile({ vfs, dir, root: "/apps/p", state, opts: { hidden: true, allowDelete: true } });
        }
        expect(await exists(join(dir, ".git", "config"))).toBe(true);
        expect(await exists(join(dir, ".git", "HEAD"))).toBe(true);
        expect(await exists(join(dir, ".npmrc"))).toBe(true);
    });

    it("an old state entry for a refused path deletes nothing", async () => {
        // A previous release uploaded these with --hidden, so real state files
        // name them. Refusing them now must not read as "deleted here".
        const { vfs } = realVfs();
        const dir = await project();
        await vfs.writeFile("/apps/p/.npmrc", enc("//registry.npmjs.org/:_authToken=npm_SECRET\n"));
        const state = { "/.npmrc": sha("//registry.npmjs.org/:_authToken=npm_SECRET\n") };
        await reconcile({ vfs, dir, root: "/apps/p", state, opts: { hidden: true, allowDelete: true } });
        expect(await exists(join(dir, ".npmrc"))).toBe(true);
        expect(await vfs.exists("/apps/p/.npmrc")).toBe(true);
    });
});

describe("what one side filters is not deleted on the other [N5]", () => {
    it("a remote file over the size limit is never read, pulled, or deleted", async () => {
        const big = "/apps/p/assets/demo.mp4";
        const vfs = memVfs({ [big]: "x", "/apps/p/src/a.ts": "a" }, { sizes: { [big]: 106 * 1024 * 1024 } });
        const dir = await tmp("n5-big");
        let state = { "/assets/demo.mp4": sha("x") };   // as if pulled by an older release
        for (let i = 0; i < 3; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, opts: { allowDelete: true } });

        expect(vfs.calls.readFile).not.toContain(big);
        expect(vfs.calls.delete).toEqual([]);
        expect(await exists(join(dir, "assets", "demo.mp4"))).toBe(false);
        expect(lines.some((l) => l.includes("assets/demo.mp4") && l.includes("MB"))).toBe(true);
    });

    it("a local file over the size limit is never deleted remotely", async () => {
        const vfs = memVfs({ "/apps/p/big.bin": "small remote copy" });
        const dir = await tmp("n5-local");
        await writeFile(join(dir, "big.bin"), "");
        await truncate(join(dir, "big.bin"), 101 * 1024 * 1024);   // sparse: costs nothing
        const state = { "/big.bin": sha("small remote copy") };
        await reconcile({ vfs, dir, root: "/apps/p", state, opts: { allowDelete: true } });
        expect(vfs.calls.delete).toEqual([]);
    });

    it("a file cannot be re-included under an excluded directory, on either side", async () => {
        const { vfs } = realVfs();
        await vfs.writeFile("/apps/p/logs/README.md", enc("how to read the logs"));
        const dir = await tmp("n5-neg");
        await put(dir, ".gitignore", "logs/\n!logs/README.md\n");
        let state = {};
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, opts: { allowDelete: true } });
        expect(await vfs.exists("/apps/p/logs/README.md")).toBe(true);
        expect(await exists(join(dir, "logs", "README.md"))).toBe(false);
    });
});

describe("an unreadable remote file [N8]", () => {
    async function planted() {
        const { vfs, content } = realVfs();
        await vfs.writeFile("/apps/p/good.ts", enc("good"));
        await vfs.writeFile("/apps/p/zz-bad.ts", enc("bad"));
        const { manifest } = await vfs.statManifest("/apps/p/zz-bad.ts");
        content.blobs.delete(manifest.id);   // the entry now points at nothing
        return vfs;
    }

    it("is reported by name and does not stop the rest of the sync", async () => {
        const vfs = await planted();
        const dir = await tmp("n8");
        await put(dir, "mine.ts", "local edit that should upload");
        await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        expect(dec(await vfs.readFile("/apps/p/mine.ts"))).toBe("local edit that should upload");
        expect(await read(join(dir, "good.ts"))).toBe("good");
        expect(lines.some((l) => l.includes("zz-bad.ts"))).toBe(true);
    });

    it("is never read as a remote deletion", async () => {
        const vfs = await planted();
        const dir = await tmp("n8-del");
        await put(dir, "zz-bad.ts", "bad");
        await reconcile({ vfs, dir, root: "/apps/p", state: { "/zz-bad.ts": sha("bad") }, opts: { allowDelete: true } });
        expect(await read(join(dir, "zz-bad.ts"))).toBe("bad");
    });

    it("does not stop mount from starting", async () => {
        const vfs = await planted();
        const dir = await tmp("n8-mount");
        await expect(mountFor(300, { client: { vfs }, dir, root: "/apps/p" })).resolves.toBeUndefined();
    });

    it("but a walk that fails still fails the pass, and the mount", async () => {
        const vfs = memVfs({ "/apps/p/a": "a" });
        vfs.walk = async () => { throw new Error("vault locked"); };
        const dir = await tmp("n8-walk");
        await expect(reconcile({ vfs, dir, root: "/apps/p", state: {} })).rejects.toThrow("vault locked");
        await expect(mountFor(100, { client: { vfs }, dir, root: "/apps/p" })).rejects.toThrow("vault locked");
    });
});

describe("the mass-delete circuit breaker [N1]", () => {
    async function synced(n) {
        const { vfs } = realVfs();
        const dir = await tmp("breaker");
        for (let i = 0; i < n; i++) await put(dir, `src/f${i}.ts`, `f${i}`);
        const state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        return { vfs, dir, state };
    }

    it("holds local deletes when the remote root is suddenly empty", async () => {
        const { vfs, dir, state } = await synced(10);
        await vfs.rename("/apps/p", "/apps/renamed");
        let next = state;
        const session = {};   // what one running mount keeps in memory
        for (let i = 0; i < 2; i++) {
            next = await reconcile({ vfs, dir, root: "/apps/p", state: next, opts: { allowDelete: true }, session });
        }
        expect((await readdir(join(dir, "src"))).length).toBe(10);
        expect(Object.keys(next).sort()).toEqual(Object.keys(state).sort());
        expect(lines.filter((l) => /refusing to delete 10 of 10/.test(l))).toHaveLength(1);
    });

    it("holds remote deletes when the local tree is suddenly empty", async () => {
        const { vfs, dir, state } = await synced(10);
        await rm(join(dir, "src"), { recursive: true });
        await reconcile({ vfs, dir, root: "/apps/p", state, opts: { allowDelete: true } });
        expect((await vfs.walk("/apps/p")).length).toBe(10);
    });

    it("still lets ordinary deletions through", async () => {
        const { vfs, dir, state } = await synced(10);
        await vfs.delete("/apps/p/src/f0.ts");
        await vfs.delete("/apps/p/src/f1.ts");
        await reconcile({ vfs, dir, root: "/apps/p", state, opts: { allowDelete: true } });
        expect((await readdir(join(dir, "src"))).length).toBe(8);
    });
});

describe("aliases the local volume folds [G1, N2]", () => {
    it("a remote Node_Modules/ never reaches the real node_modules (any volume)", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("g1-nm");
        await put(dir, "package.json", "{}");
        await put(dir, "node_modules/lodash/index.js", "module.exports = 'genuine';\n");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.writeFile("/apps/p/Node_Modules/lodash/index.js", enc("ATTACKER"));
        await vfs.writeFile("/apps/p/node_module\u017f/lodash/index.js", enc("ATTACKER"));
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await read(join(dir, "node_modules", "lodash", "index.js"))).toBe("module.exports = 'genuine';\n");
        expect((await readdir(dir)).sort()).toEqual([".muhkoo", "node_modules", "package.json"]);
    });

    it("--hidden: a remote .GIT/config never reaches .git/config", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("g1-git");
        await put(dir, ".git/config", "[core]\n");
        let state = await reconcile({ vfs, dir, root: "/apps/q", state: {}, opts: { hidden: true } });
        await vfs.writeFile("/apps/q/.GIT/config", enc("[core]\n\tfsmonitor = touch /tmp/pwned\n"));
        state = await reconcile({ vfs, dir, root: "/apps/q", state, opts: { hidden: true } });
        expect(await read(join(dir, ".git", "config"))).toBe("[core]\n");
        expect(await vfs.walk("/apps/q")).toEqual(["/apps/q/.GIT/config"]);   // nothing pushed back up
    });

    it.skipIf(!volume.ci)("a remote case alias does not overwrite unsynced local edits", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("n2");
        await put(dir, "src/app.ts", "v1\n");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await writeFile(join(dir, "src", "app.ts"), "UNSYNCED LOCAL EDIT\n");
        await vfs.writeFile("/apps/p/src/App.ts", enc("REMOTE\n"));
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await read(join(dir, "src", "app.ts"))).toBe("UNSYNCED LOCAL EDIT\n");
        expect(dec(await vfs.readFile("/apps/p/src/app.ts"))).toBe("UNSYNCED LOCAL EDIT\n");
    });

    it.skipIf(!volume.ci)("a remote case alias does not clobber an ignored, local-only file", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("g1-key");
        await put(dir, ".gitignore", "config/master.key\n");
        await put(dir, "config/master.key", "LOCAL-ONLY-MASTER-KEY");
        await put(dir, "config/app.json", "{}");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.writeFile("/apps/p/Config/Master.key", enc("ATTACKER"));
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await read(join(dir, "config", "master.key"))).toBe("LOCAL-ONLY-MASTER-KEY");
    });

    it.skipIf(!volume.ni)("a Unicode-normalization alias does not overwrite the local file", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("n2-nfd");
        await put(dir, "caf\u00e9.md", "synced v1\n");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await writeFile(join(dir, "caf\u00e9.md"), "UNSYNCED LOCAL EDIT\n");
        await vfs.writeFile("/apps/p/cafe\u0301.md", enc("REMOTE\n"));
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await read(join(dir, "caf\u00e9.md"))).toBe("UNSYNCED LOCAL EDIT\n");
    });

    it.skipIf(!volume.ci)("two remote keys that fold equal are both refused", async () => {
        const { vfs } = realVfs();
        await vfs.writeFile("/apps/p/README.md", enc("one"));
        await vfs.writeFile("/apps/p/readme.md", enc("two"));
        const dir = await tmp("fold-pair");
        await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        expect((await readdir(dir)).filter((n) => n.toLowerCase() === "readme.md")).toEqual([]);
        expect(lines.filter((l) => /fold/.test(l) && /readme\.md/i.test(l)).length).toBeGreaterThan(0);
    });
});

describe("the write boundary, end to end [G2, N11]", () => {
    it("never writes through a symlinked directory inside the mount", async () => {
        const { vfs } = realVfs();
        const outside = await tmp("g2-outside");
        await put(outside, "victim.txt", "ORIGINAL OUTSIDE CONTENT");
        const dir = await tmp("g2");
        await put(dir, "src/a.ts", "export {}\n");
        await symlink(outside, join(dir, "shared"));
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.writeFile("/apps/p/shared/victim.txt", enc("REMOTE"));
        await vfs.writeFile("/apps/p/shared/sub/new.txt", enc("REMOTE"));
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await read(join(outside, "victim.txt"))).toBe("ORIGINAL OUTSIDE CONTENT");
        expect(await exists(join(outside, "sub"))).toBe(false);
    });

    it("replaces a hard-linked file without changing its twin", async () => {
        const { vfs } = realVfs();
        const outside = await tmp("g2-hl");
        await put(outside, "hl-target.txt", "hardlinked ORIGINAL");
        const dir = await tmp("g2-hl-mount");
        await link(join(outside, "hl-target.txt"), join(dir, "hl.txt"));
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.writeFile("/apps/p/hl.txt", enc("REMOTE via hard link"));
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await read(join(dir, "hl.txt"))).toBe("REMOTE via hard link");
        expect(await read(join(outside, "hl-target.txt"))).toBe("hardlinked ORIGINAL");
    });

    it("keeps the executable bit of the file it replaces", async () => {
        // An edit to scripts/deploy.sh made on another machine must still run
        // here. Stripping the bit would break every such edit.
        const { vfs } = realVfs();
        const dir = await tmp("n11-mode");
        await put(dir, "scripts/deploy.sh", "#!/bin/sh\necho v1\n");
        await chmod(join(dir, "scripts", "deploy.sh"), 0o755);
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.writeFile("/apps/p/scripts/deploy.sh", enc("#!/bin/sh\necho v2\n"));
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await read(join(dir, "scripts", "deploy.sh"))).toBe("#!/bin/sh\necho v2\n");
        expect((await stat(join(dir, "scripts", "deploy.sh"))).mode & 0o777).toBe(0o755);
    });

    it("--hidden: never writes the newly refused agent and hook directories", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("n11");
        await put(dir, "package.json", "{}");
        await put(dir, ".husky/pre-commit", "npx lint-staged\n");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, opts: { hidden: true } });
        for (const p of [".husky/pre-commit", ".claude/settings.json", ".zed/tasks.json", ".zshenv"]) {
            await vfs.writeFile(`/apps/p/${p}`, enc("REMOTE"));
        }
        state = await reconcile({ vfs, dir, root: "/apps/p", state, opts: { hidden: true } });
        expect(await read(join(dir, ".husky", "pre-commit"))).toBe("npx lint-staged\n");
        expect(await exists(join(dir, ".claude"))).toBe(false);
        expect(await exists(join(dir, ".zed"))).toBe(false);
        expect(await exists(join(dir, ".zshenv"))).toBe(false);
    });
});

describe("mount and import refuse a home directory [G8]", () => {
    let prev;
    beforeEach(() => { prev = process.env.HOME; });
    afterEach(() => { process.env.HOME = prev; });

    it("import refuses $HOME", async () => {
        const home = await tmp("g8-home");
        await put(home, "Documents/taxes.pdf", "PDF");
        process.env.HOME = home;
        const vfs = memVfs();
        await expect(importOnce({ client: { vfs }, dir: home, root: "/apps/home" })).rejects.toThrow(/home directory/);
        expect(vfs.calls.writeFile).toEqual([]);
    });

    it("mount refuses $HOME, so a remote Library/LaunchAgents plist never lands there", async () => {
        const home = await tmp("g8-mount");
        process.env.HOME = home;
        const vfs = memVfs({ "/Library/LaunchAgents/com.evil.plist": "<plist>RunAtLoad</plist>" });
        await expect(mountFor(200, { client: { vfs }, dir: home, root: "/" })).rejects.toThrow(/home directory/);
        expect(await exists(join(home, "Library"))).toBe(false);
    });
});

describe("mount state and the watcher [G6, N6, N9]", () => {
    it("saves the state it ends with, under the right root", async () => {
        const vfs = memVfs();
        const dir = await tmp("g6");
        await put(dir, "a.txt", "a");
        await mountFor(600, { client: { vfs }, dir, root: "/apps/p" });
        const saved = JSON.parse(await read(join(dir, ".muhkoo", "mount.json")));
        expect(saved.root).toBe("/apps/p");
        expect(Object.keys(saved.paths)).toEqual(["/a.txt"]);
    });

    it("reconcile does not rewrite the state file when nothing changed", async () => {
        // A remote FILE where the project has a directory can never be written.
        const vfs = memVfs({ "/apps/p/dist": "i am a file", "/apps/p/src/a.ts": "x" });
        const dir = await tmp("n6-save");
        await put(dir, "src/a.ts", "x");
        await put(dir, "dist/bundle.js", "built");
        const state = { "/src/a.ts": sha("x") };
        await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await exists(join(dir, ".muhkoo", "mount.json"))).toBe(false);
    });

    it("a plan that cannot converge does not become a busy loop", async () => {
        const { vfs, calls } = counting(memVfs({ "/apps/p/dist": "i am a file", "/apps/p/src/a.ts": "x" }));
        const dir = await tmp("n6");
        await put(dir, "src/a.ts", "x");
        await put(dir, "dist/bundle.js", "built");
        await mountFor(1500, { client: { vfs }, dir, root: "/apps/p" });
        expect(calls.walk).toBeLessThanOrEqual(2);
    });

    it("warns about a declined path once, not on every pass", async () => {
        const vfs = memVfs({ "/apps/p/dist": "i am a file" });
        const dir = await tmp("n6-warn");
        await put(dir, "dist/bundle.js", "built");
        await put(dir, "src/a.ts", "1");
        const controller = new AbortController();
        const running = mount({ client: { vfs }, dir, root: "/apps/p", signal: controller.signal });
        await sleep(500);
        for (let i = 2; i < 5; i++) {
            await writeFile(join(dir, "src", "a.ts"), String(i));   // each edit is a pass
            await sleep(600);
        }
        controller.abort();
        await running;
        expect(vfs.data.get("/apps/p/src/a.ts") && dec(vfs.data.get("/apps/p/src/a.ts"))).toBe("4");
        expect(lines.filter((l) => l.includes("/dist")).length).toBe(1);
    });

    it("ignores writes inside .muhkoo", async () => {
        const { vfs, calls } = counting(memVfs());
        const dir = await tmp("n6-muhkoo");
        await put(dir, "a.txt", "a");
        const controller = new AbortController();
        const running = mount({ client: { vfs }, dir, root: "/apps/p", signal: controller.signal });
        await sleep(700);
        const before = calls.walk;
        await writeFile(join(dir, ".muhkoo", "scratch.json"), "{}");
        await sleep(800);
        controller.abort();
        await running;
        expect(calls.walk).toBe(before);
    });

    it("uploads an edit under vendor/ when the project's rules sync it", async () => {
        const vfs = memVfs();
        const dir = await tmp("n9");
        await put(dir, "vendor/acme/lib.go", "v1");
        const controller = new AbortController();
        const running = mount({ client: { vfs }, dir, root: "/apps/p", signal: controller.signal });
        await sleep(600);
        await writeFile(join(dir, "vendor", "acme", "lib.go"), "v2 edited");
        await sleep(1500);
        controller.abort();
        await running;
        expect(dec(vfs.data.get("/apps/p/vendor/acme/lib.go"))).toBe("v2 edited");
    });
});

describe("import only uploads [N7]", () => {
    async function imported() {
        const { vfs } = realVfs();
        const dir = await tmp("n7");
        await put(dir, "src/a.ts", "a");
        await put(dir, "src/b.ts", "b");
        await importOnce({ client: { vfs }, dir, root: "/apps/p" });
        return { vfs, dir };
    }

    it("does not write remote files into the project, or delete local ones", async () => {
        const { vfs, dir } = await imported();
        await vfs.writeFile("/apps/p/src/planted.ts", enc("remote-chosen content"));
        await vfs.delete("/apps/p/src/b.ts");
        await importOnce({ client: { vfs }, dir, root: "/apps/p", opts: { allowDelete: true } });
        expect((await readdir(join(dir, "src"))).sort()).toEqual(["a.ts", "b.ts"]);
    });

    it("pushes on a conflict — local wins, as mount does", async () => {
        const { vfs, dir } = await imported();
        await writeFile(join(dir, "src", "a.ts"), "local edit");
        await vfs.writeFile("/apps/p/src/a.ts", enc("remote edit"));
        await importOnce({ client: { vfs }, dir, root: "/apps/p" });
        expect(dec(await vfs.readFile("/apps/p/src/a.ts"))).toBe("local edit");
        expect(await read(join(dir, "src", "a.ts"))).toBe("local edit");
    });

    it("deletes remotely only with --allow-delete", async () => {
        const { vfs, dir } = await imported();
        await rm(join(dir, "src", "b.ts"));
        await importOnce({ client: { vfs }, dir, root: "/apps/p" });
        expect(await vfs.exists("/apps/p/src/b.ts")).toBe(true);
        await importOnce({ client: { vfs }, dir, root: "/apps/p", opts: { allowDelete: true } });
        expect(await vfs.exists("/apps/p/src/b.ts")).toBe(false);
    });

    it("leaves skipped paths out of state, so a later mount still pulls them", async () => {
        const { vfs, dir } = await imported();
        await vfs.writeFile("/apps/p/src/planted.ts", enc("from the IDE"));
        await importOnce({ client: { vfs }, dir, root: "/apps/p" });
        const saved = JSON.parse(await read(join(dir, ".muhkoo", "mount.json")));
        expect(saved.paths["/src/planted.ts"]).toBeUndefined();
        await reconcile({ vfs, dir, root: "/apps/p", state: saved.paths });
        expect(await read(join(dir, "src", "planted.ts"))).toBe("from the IDE");
    });

    it("--dry-run shows which side a delete happens on, and what it skips", async () => {
        const { vfs, dir } = await imported();
        await rm(join(dir, "src", "a.ts"));
        await vfs.delete("/apps/p/src/b.ts");
        lines.length = 0;
        await importOnce({ client: { vfs }, dir, root: "/apps/p", opts: { dryRun: true, allowDelete: true } });
        const aLine = lines.find((l) => l.includes("/src/a.ts"));
        const bLine = lines.find((l) => l.includes("/src/b.ts"));
        expect(aLine).toMatch(/your filesystem/);
        expect(bLine).toMatch(/skip/);
        expect(await exists(join(dir, "src", "b.ts"))).toBe(true);
    });
});

describe("git's ignore rules, in full [N4]", () => {
    it("honours nested .gitignore files and .git/info/exclude", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("n4");
        await put(dir, ".gitignore", "node_modules/\n");
        await put(dir, "packages/api/.gitignore", "config/credentials.json\n");
        await put(dir, "packages/api/config/credentials.json", "{\"secret\":1}");
        await put(dir, "packages/api/index.js", "x");
        await put(dir, ".git/info/exclude", "local-notes.md\n");
        await put(dir, "local-notes.md", "private");
        await importOnce({ client: { vfs }, dir, root: "/apps/p" });
        expect((await vfs.walk("/apps/p")).sort()).toEqual([
            "/apps/p/.gitignore",
            "/apps/p/packages/api/.gitignore",
            "/apps/p/packages/api/index.js",
        ]);
    });

    it("does not look inside an ignored directory for rules to re-include it", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("n4-prune");
        await put(dir, ".gitignore", "vendor/\n");
        await put(dir, "vendor/.gitignore", "!*\n");
        await put(dir, "vendor/x.js", "x");
        await put(dir, "a.js", "a");
        await importOnce({ client: { vfs }, dir, root: "/apps/p" });
        expect((await vfs.walk("/apps/p")).sort()).toEqual(["/apps/p/.gitignore", "/apps/p/a.js"]);
    });

    it("one bad line does not discard the whole .vcsignore", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("n4-bad");
        await put(dir, ".vcsignore", "secrets/\n[z-a]\n");
        await put(dir, ".gitignore", "# nothing about secrets\n");
        await put(dir, "secrets/key.pem", "PRIVATE");
        await importOnce({ client: { vfs }, dir, root: "/apps/q" });
        expect(await vfs.exists("/apps/q/secrets/key.pem")).toBe(false);
    });
});

describe("remote ignore rules can only ADD exclusions [G18]", () => {
    async function project() {
        const dir = await tmp("g18");
        await put(dir, ".gitignore", "config/master.key\n*.pem\ncredentials.json\n");
        await put(dir, "src/app.ts", "export {}\n");
        await put(dir, "config/master.key", "RAILS_MASTER_KEY_0123456789abcdef");
        await put(dir, "server.pem", "-----BEGIN PRIVATE KEY-----\n");
        await put(dir, "credentials.json", "{\"client_secret\":\"s3cr3t\"}");
        return dir;
    }
    const secrets = ["/apps/p/config/master.key", "/apps/p/credentials.json", "/apps/p/server.pem"];
    const leaked = async (vfs) => (await vfs.walk("/apps/p")).filter((p) => secrets.includes(p));

    it("a planted .vcsignore cannot replace the project's .gitignore", async () => {
        const { vfs } = realVfs();
        const dir = await project();
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.writeFile("/apps/p/.vcsignore", enc("# tidy-up\n"));
        for (let i = 0; i < 3; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await exists(join(dir, ".vcsignore"))).toBe(true);   // it still arrives
        expect(await leaked(vfs)).toEqual([]);
    });

    it("nor on a second import", async () => {
        const { vfs } = realVfs();
        const dir = await project();
        await importOnce({ client: { vfs }, dir, root: "/apps/p" });
        await vfs.writeFile("/apps/p/.vcsignore", enc("# nothing\n"));
        // import no longer pulls, so plant it the way mount would have
        await reconcile({ vfs, dir, root: "/apps/p", state: JSON.parse(await read(join(dir, ".muhkoo", "mount.json"))).paths });
        await importOnce({ client: { vfs }, dir, root: "/apps/p" });
        await importOnce({ client: { vfs }, dir, root: "/apps/p" });
        expect(await leaked(vfs)).toEqual([]);
    });

    it("a remote edit to .gitignore cannot negate a local rule", async () => {
        const { vfs } = realVfs();
        const dir = await project();
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.writeFile("/apps/p/.gitignore", enc("!config/master.key\n!*.pem\n"));
        for (let i = 0; i < 3; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await read(join(dir, ".gitignore"))).toBe("!config/master.key\n!*.pem\n");
        expect(await leaked(vfs)).toEqual([]);
    });

    it("a planted nested .gitignore cannot re-include a file", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("g18-nested");
        await put(dir, ".gitignore", "secret.txt\n");
        await put(dir, "pkg/secret.txt", "SECRET");
        await put(dir, "pkg/index.js", "x");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.writeFile("/apps/p/pkg/.gitignore", enc("!secret.txt\n"));
        for (let i = 0; i < 3; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await vfs.exists("/apps/p/pkg/secret.txt")).toBe(false);
    });

    it("a remote deletion of .gitignore, carried out by --allow-delete, does not loosen", async () => {
        const { vfs } = realVfs();
        const dir = await project();
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.delete("/apps/p/.gitignore");
        for (let i = 0; i < 3; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, opts: { allowDelete: true } });
        expect(await exists(join(dir, ".gitignore"))).toBe(false);
        expect(await leaked(vfs)).toEqual([]);
    });

    it("a file planted before the very first pass is remote-authored too", async () => {
        // The first snapshot is the local files as they are BEFORE any pull,
        // so what arrives in pass one can only add to it.
        const { vfs } = realVfs();
        await vfs.writeFile("/apps/p/.vcsignore", enc("# nothing\n"));
        const dir = await project();
        let state = {};
        for (let i = 0; i < 3; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await exists(join(dir, ".vcsignore"))).toBe(true);
        expect(await leaked(vfs)).toEqual([]);
    });

    it("a planted file that is not UTF-8 changes nothing either", async () => {
        const { vfs } = realVfs();
        const dir = await project();
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.writeFile("/apps/p/.vcsignore", new Uint8Array([0xff, 0xfe, 0x0a, 0x23, 0x0a]));
        for (let i = 0; i < 3; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await leaked(vfs)).toEqual([]);
    });

    it("an exclusion added on another machine applies here", async () => {
        const { vfs } = realVfs();
        const dir = await project();
        await put(dir, "notes/draft.md", "v1");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.writeFile("/apps/p/.gitignore", enc("config/master.key\n*.pem\ncredentials.json\nnotes/\n"));
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        await writeFile(join(dir, "notes", "draft.md"), "v2 private");
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, opts: { allowDelete: true } });
        expect(dec(await vfs.readFile("/apps/p/notes/draft.md"))).toBe("v1");
        expect(await read(join(dir, "notes", "draft.md"))).toBe("v2 private");
    });
});

// ---------------------------------------------------------------------------
// Fix-up round: the review of the first rewrite. Ids are the review's.

/** The G18 project: rules that keep three secrets home. */
async function secretProject(label) {
    const dir = await tmp(label);
    await put(dir, ".gitignore", "config/master.key\n*.pem\ncredentials.json\n");
    await put(dir, "src/app.ts", "export {}\n");
    await put(dir, "config/master.key", "RAILS_MASTER_KEY_0123456789abcdef");
    await put(dir, "server.pem", "-----BEGIN PRIVATE KEY-----\n");
    await put(dir, "credentials.json", "{\"client_secret\":\"s3cr3t\"}");
    return dir;
}
const SECRETS = ["/apps/p/config/master.key", "/apps/p/credentials.json", "/apps/p/server.pem"];
const leakedFrom = async (vfs) => ((await vfs.exists("/apps/p")) ? await vfs.walk("/apps/p") : []).filter((p) => SECRETS.includes(p));

/**
 * The heavy lines of GitHub's Node.gitignore, and enough ordinary ones around
 * them to look like the real thing.
 */
const NODE_ISH = [
    "logs", "*.log", "npm-debug.log*", "yarn-debug.log*", "yarn-error.log*", "lerna-debug.log*",
    "report.[0-9]*.[0-9]*.[0-9]*.[0-9]*.json", "pids", "*.pid", "*.seed", "*.pid.lock", "lib-cov",
    "coverage", "*.lcov", ".nyc_output", ".grunt", "bower_components", ".lock-wscript", "build/Release",
    "node_modules/", "jspm_packages/", "web_modules/", "*.tsbuildinfo", ".npm", ".eslintcache",
    ".stylelintcache", ".rpt2_cache/", ".rts2_cache_cjs/", ".node_repl_history", "*.tgz", ".yarn-integrity",
    ".env", ".env.*", "!.env.example", ".cache", ".parcel-cache", ".next", "out", ".nuxt", "dist",
    ".vuepress/dist", ".temp", "**/.vitepress/dist", "**/.vitepress/cache", ".docusaurus", ".serverless/",
    ".fusebox/", ".dynamodb/", ".firebase/", ".tern-port", ".vscode-test", ".yarn/cache", ".pnp.*",
    "vite.config.js.timestamp-*", "vite.config.ts.timestamp-*", ".vite/",
].join("\n") + "\n";

/** Saved state, or none: what a restarted process starts from. */
async function savedState(dir) {
    return readFile(join(dir, ".muhkoo", "mount.json"), "utf8").then((s) => JSON.parse(s).paths, () => ({}));
}

/**
 * A vfs whose reads of `suffix` never finish while `when()` holds — a pass
 * abandoned there, the way Ctrl-C then process.exit, a closed terminal, kill
 * or a crash leaves it. Turn `ctl.on` off before "restarting".
 */
function stallingVfs(vfs, suffix, when) {
    const ctl = { on: true, stalled: false };
    const proxy = new Proxy(vfs, {
        get(target, key) {
            const value = target[key];
            if (typeof value !== "function") return value;
            // A pull asks for the file's manifest before anything else.
            if (key !== "readFile" && key !== "statManifest") return value.bind(target);
            return async (p) => {
                if (ctl.on && p.endsWith(suffix) && (await when())) {
                    ctl.stalled = true;
                    await new Promise(() => {});
                }
                return value.call(target, p);
            };
        },
    });
    return { vfs: proxy, ctl };
}
/**
 * The same vfs, except that `path` changes after it is first looked at: from
 * then on its manifest is a new one, whose content `read()` gives. What a
 * pull sees when the record moved on after the scan read it.
 */
function changesAfterScan(vfs, path, read) {
    let looks = 0;
    const moved = { id: `moved:${path}` };
    return new Proxy(vfs, {
        get(target, key) {
            if (key === "statManifest") {
                return async (p) => (p === path && looks++ > 0 ? { manifest: moved, size: 0 } : target.statManifest(p));
            }
            if (key === "readByManifest") return async (m) => (m === moved ? read() : target.readByManifest(m));
            const value = target[key];
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

async function until(cond, ms = 5000) {
    const t0 = Date.now();
    while (!(await cond())) {
        if (Date.now() - t0 > ms) throw new Error("timed out waiting");
        await sleep(20);
    }
}

describe("full case folding in the ignore rules [A1]", () => {
    it.skipIf(!volume.ci)("a remote `maſter.key` is not pulled, so the real key never lands in it and uploads", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("a1");
        await put(dir, ".gitignore", "config/master.key\ncredentials.json\n");
        await put(dir, "config/app.rb", "app\n");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.writeFile("/apps/p/config/maſter.key", enc("placeholder\n"));
        await vfs.writeFile("/apps/p/credentialſ.json", enc("{}\n"));
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        // The developer, later: the key is generated, written in place.
        await writeFile(join(dir, "config", "master.key"), "RAILS_MASTER_KEY\n");
        await writeFile(join(dir, "credentials.json"), "{\"private_key\":1}\n");
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(dec(await vfs.readFile("/apps/p/config/maſter.key"))).toBe("placeholder\n");
        expect(dec(await vfs.readFile("/apps/p/credentialſ.json"))).toBe("{}\n");
        expect((await readdir(join(dir, "config"))).sort()).toEqual(["app.rb", "master.key"]);
    });
});

describe("an ignore file under another spelling [A2]", () => {
    it.each(["/.VCSIGNORE", "/.GitIgnore", "/.vcsignore.", "/pkg/.GITIGNORE"])(
        "--hidden: a remote %s is never pulled, nor read as the project's rules",
        async (planted) => {
            const { vfs } = realVfs();
            const dir = await secretProject("a2");
            await put(dir, "pkg/index.js", "x");
            const opts = { hidden: true };
            const session = {};
            let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, opts, session });
            await vfs.writeFile("/apps/p" + planted, enc("# tidy-up\n"));
            for (let i = 0; i < 3; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, opts, session });
            expect(await leakedFrom(vfs)).toEqual([]);
            const name = planted.split("/").pop();
            const where = planted.startsWith("/pkg/") ? join(dir, "pkg") : dir;
            expect(await readdir(where)).not.toContain(name);
        },
    );

    it("--hidden: a planted `.GITIGNORE` cannot negate the defaults in a project with no ignore file", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("a2-none");
        await put(dir, "src/a.ts", "a");
        await put(dir, "dist/bundle.js", "built");
        const opts = { hidden: true };
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, opts });
        await vfs.writeFile("/apps/p/.GITIGNORE", enc("!dist/\n"));
        for (let i = 0; i < 3; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, opts });
        expect(await vfs.exists("/apps/p/dist/bundle.js")).toBe(false);
    });

    it.skipIf(!volume.ci)("a local `.VCSIGNORE` left by an older version is not read as .vcsignore", async () => {
        const { vfs } = realVfs();
        const dir = await secretProject("a2-left");
        await put(dir, ".VCSIGNORE", "# tidy-up\n");
        await reconcile({ vfs, dir, root: "/apps/p", state: {}, opts: { hidden: true } });
        expect(await leakedFrom(vfs)).toEqual([]);
    });
});

describe("an interrupted pass loosens nothing [A3]", () => {
    it("a pass stopped between two pulled ignore files", async () => {
        const { vfs: real } = realVfs();
        const dir = await secretProject("a3");
        let state = await reconcile({ vfs: real, dir, root: "/apps/p", state: {} });
        await real.writeFile("/apps/p/.vcsignore", enc("# tidy-up\n"));
        await real.writeFile("/apps/p/zz/.gitignore", enc("# more\n"));
        // The second ignore file stalls when it is pulled — not when the scan
        // reads it — and the first lands. Pulls are fetched ahead of landing,
        // so its fetch starts before the first is on disk: waiting for that
        // to stall it waited forever.
        let looks = 0;
        const { vfs, ctl } = stallingVfs(real, "/zz/.gitignore", () => ++looks > 1);
        void reconcile({ vfs, dir, root: "/apps/p", state, session: {} });
        await until(() => ctl.stalled);
        await until(() => exists(join(dir, ".vcsignore")));
        ctl.on = false;
        // Restart.
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs: real, dir, root: "/apps/p", state: await savedState(dir), session: {} });
        expect(await leakedFrom(real)).toEqual([]);
    });

    it("a pass stopped after deleting an ignore file on remote say-so", async () => {
        const { vfs: real } = realVfs();
        const dir = await secretProject("a3-del");
        let state = await reconcile({ vfs: real, dir, root: "/apps/p", state: {} });
        await real.delete("/apps/p/.gitignore");
        await real.writeFile("/apps/p/zz-big.bin", enc("big"));
        const { vfs, ctl } = stallingVfs(real, "/zz-big.bin", async () => !(await exists(join(dir, ".gitignore"))));
        void reconcile({ vfs, dir, root: "/apps/p", state, opts: { allowDelete: true }, session: {} });
        await until(() => ctl.stalled);
        ctl.on = false;
        for (let i = 0; i < 2; i++) {
            state = await reconcile({ vfs: real, dir, root: "/apps/p", state: await savedState(dir), opts: { allowDelete: true }, session: {} });
        }
        expect(await exists(join(dir, ".gitignore"))).toBe(false);
        expect(await leakedFrom(real)).toEqual([]);
    });

    it("a first mount killed mid-pass: its first snapshot was recorded before the pull", async () => {
        const { vfs: real } = realVfs();
        await real.writeFile("/apps/p/.gitignore", enc("config/master.key\n"));
        await real.writeFile("/apps/p/src/app.js", enc("app\n"));
        await real.writeFile("/apps/p/.vcsignore", enc("# tidy-up\n"));
        await real.writeFile("/apps/p/zz/.gitignore", enc("# more\n"));
        const dir = await tmp("a3-first");
        await put(dir, ".gitignore", "config/master.key\n");   // a git clone brings this
        await put(dir, "config/master.key", "RAILS_MASTER_KEY");
        // Stalled at its pull, with the first ignore file landed (see [A3] above).
        let looks = 0;
        const { vfs, ctl } = stallingVfs(real, "/zz/.gitignore", () => ++looks > 1);
        void reconcile({ vfs, dir, root: "/apps/p", state: {}, session: {} });
        await until(() => ctl.stalled);
        await until(() => exists(join(dir, ".vcsignore")));
        ctl.on = false;
        for (let i = 0; i < 2; i++) await reconcile({ vfs: real, dir, root: "/apps/p", state: await savedState(dir), session: {} });
        expect(await real.exists("/apps/p/config/master.key")).toBe(false);
    });
});

describe("a local edit to a pulled .gitignore cannot launder what the remote removed [A12]", () => {
    const rules = ["*.log", "tmp/", "config/master.key", "coverage/", "*.swp"];
    async function pulledRemoval() {
        const { vfs } = realVfs();
        const dir = await tmp("a12");
        await put(dir, ".gitignore", rules.join("\n") + "\n");
        await put(dir, "config/master.key", "RAILS_MASTER_KEY\n");
        await put(dir, "src/app.js", "x");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        // The remote drops one line among many; the pull keeps it excluded.
        await vfs.writeFile("/apps/p/.gitignore", enc(rules.filter((r) => r !== "config/master.key").join("\n") + "\n"));
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await vfs.exists("/apps/p/config/master.key")).toBe(false);
        return { vfs, dir, state };
    }

    it("an unrelated local edit does not launder a line the remote removed", async () => {
        let { vfs, dir, state } = await pulledRemoval();
        await appendFile(join(dir, ".gitignore"), ".idea/\n");
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await vfs.exists("/apps/p/config/master.key")).toBe(false);
    });

    it("nor does a second one", async () => {
        let { vfs, dir, state } = await pulledRemoval();
        await appendFile(join(dir, ".gitignore"), ".idea/\n");
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        await writeFile(join(dir, ".gitignore"), "*.log\ntmp/\ncoverage/\n");   // tidied, *.swp gone too
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await vfs.exists("/apps/p/config/master.key")).toBe(false);
    });

    it("a line the user removes here loosens once accepted, even in a file last pulled", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("a12-legit");
        await put(dir, ".gitignore", rules.join("\n") + "\n");
        await put(dir, "config/master.key", "RAILS_MASTER_KEY\n");
        await put(dir, "tmp/scratch.txt", "keep me now");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.writeFile("/apps/p/.gitignore", enc([...rules, "docs/"].join("\n") + "\n"));
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        await writeFile(join(dir, ".gitignore"), ["*.log", "config/master.key", "coverage/", "*.swp", "docs/"].join("\n") + "\n");
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await vfs.exists("/apps/p/tmp/scratch.txt")).toBe(false);   // held until accepted
        await accept(dir);
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await vfs.exists("/apps/p/tmp/scratch.txt")).toBe(true);
        expect(await vfs.exists("/apps/p/config/master.key")).toBe(false);
    });
});

describe("remote ignore rules apply in the pass that brings them [A13]", () => {
    it("a fresh directory's local secret stays home on the first mount", async () => {
        const { vfs } = realVfs();
        await vfs.writeFile("/apps/p/.gitignore", enc("config/master.key\n"));
        await vfs.writeFile("/apps/p/src/app.js", enc("app"));
        const dir = await tmp("a13");
        await put(dir, "config/master.key", "SECRET");
        await put(dir, "src/new.js", "new");
        await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        expect(await vfs.exists("/apps/p/config/master.key")).toBe(false);
        expect(await vfs.exists("/apps/p/src/new.js")).toBe(true);
        expect(await read(join(dir, ".gitignore"))).toBe("config/master.key\n");
    });

    // The reviewer's s4: the reserve held the .gitignore pull, and the pass
    // went on to push what it had planned without it.
    const scene = async (label) => {
        const { vfs } = realVfs();
        await vfs.writeFile("/apps/p/.gitignore", enc("config/master.key\n"));
        await vfs.writeFile("/apps/p/src/app.js", enc("app"));
        const dir = await tmp(label);
        await put(dir, "config/master.key", "SECRET");
        await put(dir, "src/new.js", "new");
        return { vfs, dir };
    };
    const MB = 1024 * 1024;
    const roomy = async () => ({ bsize: 4096, blocks: 1e9, bavail: 5e8 });

    it("an ignore file waits for disk space like any pull, and uploads wait with it: the key stays home [F4]", async () => {
        const { vfs, dir } = await scene("a13-disk");
        const full = async () => ({ bsize: 4096, blocks: 1e9, bavail: (512 * MB) / 4096 });   // 4 TB, 512 MB free
        await reconcile({ vfs, dir, root: "/apps/p", state: {}, session: { statfs: full } });
        expect(await exists(join(dir, ".gitignore"))).toBe(false);
        expect(await vfs.exists("/apps/p/src/new.js")).toBe(false);
        expect(await vfs.exists("/apps/p/config/master.key")).toBe(false);
        expect(lines.some((l) => /not uploading/.test(l))).toBe(true);
        expect(lines.some((l) => l.includes("/.gitignore:") && /reserve/.test(l))).toBe(true);
    });

    it("says again, naming the cause, whenever new uploads are held [review 2]", async () => {
        // An ignore file that cannot be read as rules holds uploads; the
        // warning came once a session, and the user went on editing unaware.
        const { vfs, dir } = await scene("a13-repeat");
        const session = { statfs: roomy };
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session });
        await vfs.writeFile("/apps/p/.vcsignore", enc(Array.from({ length: 10_001 }, (_, i) => `r${i}`).join("\n")));
        await put(dir, "src/one.js", "1");
        state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        const said = (name) => lines.filter((l) => /not uploading/.test(l) && l.includes(name));
        expect(said("/src/one.js")).toHaveLength(1);
        expect(lines.some((l) => l.includes("/.vcsignore") && /at most 10000/.test(l))).toBe(true);
        state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        expect(said("/src/one.js")).toHaveLength(1);   // nothing new: not said again
        await put(dir, "src/two.js", "2");
        state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        expect(said("/src/two.js")).toHaveLength(1);
        expect(await vfs.exists("/apps/p/src/two.js")).toBe(false);
    });

    it("nor one whose ignore file could not be read", async () => {
        const { vfs, dir } = await scene("a13-error");
        // The scan reads it; the pull fails.
        const flaky = changesAfterScan(vfs, "/apps/p/.gitignore", () => Promise.reject(new Error("shard lost")));
        await reconcile({ vfs: flaky, dir, root: "/apps/p", state: {}, session: { statfs: roomy } });
        expect(await vfs.exists("/apps/p/config/master.key")).toBe(false);
        expect(await exists(join(dir, ".gitignore"))).toBe(false);
        expect(lines.some((l) => /shard lost/.test(l))).toBe(true);
    });

    it("nor one that stopped at its pull budget before the ignore file", async () => {
        const { vfs, dir } = await scene("a13-budget");
        await vfs.writeFile("/apps/p/.b/.gitignore", enc("x\n"));   // sorts first, with --hidden
        await reconcile({ vfs, dir, root: "/apps/p", state: {}, opts: { hidden: true }, session: { statfs: roomy, pullBudget: { bytes: 1024, files: 1 } } });
        expect(await vfs.exists("/apps/p/config/master.key")).toBe(false);
    });
});

describe("ignore files over the size limits [A6]", () => {
    const huge = Array.from({ length: 10_001 }, (_, i) => `**/rule${i}/`).join("\n") + "\n";

    it("a planted one is not pulled, is named, and holds uploads; nothing it could expose syncs", async () => {
        // Reading part of it, or none of it, could only drop exclusions. It
        // used to land and stop every pass after — and deleting it here only
        // brought it down again (the adversary's (f)). Now it stays remote,
        // and uploads wait for rules that cannot be read.
        const { vfs } = realVfs();
        const dir = await secretProject("a6");
        const session = {};
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session });
        await put(dir, "src/new.ts", "new\n");
        await vfs.writeFile("/apps/p/.vcsignore", enc(huge));
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        expect(await exists(join(dir, ".vcsignore"))).toBe(false);
        expect(lines.some((l) => l.includes("/.vcsignore") && /cannot be read as ignore rules/.test(l))).toBe(true);
        expect(await vfs.exists("/apps/p/src/new.ts")).toBe(false);
        expect(await leakedFrom(vfs)).toEqual([]);
        await vfs.delete("/apps/p/.vcsignore");
        state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        expect(await vfs.exists("/apps/p/src/new.ts")).toBe(true);
    });

    it("a planted one past the byte limit is never copied into the rules file", async () => {
        const { vfs } = realVfs();
        const dir = await secretProject("a6-bytes");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.writeFile("/apps/p/.vcsignore", enc("#".repeat(300 * 1024) + "\n"));
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state }).catch(() => state);
        expect((await stat(join(dir, ".muhkoo", "ignore-rules.json"))).size).toBeLessThan(16 * 1024);
        expect(await leakedFrom(vfs)).toEqual([]);
    });

    it("the user's own fails the pass, naming the file, rather than being dropped", async () => {
        const { vfs } = realVfs();
        const dir = await secretProject("a6-own");
        await writeFile(join(dir, ".gitignore"), "config/master.key\n*.pem\ncredentials.json\n" + huge);
        await expect(reconcile({ vfs, dir, root: "/apps/p", state: {} })).rejects.toThrow(/\.gitignore/);
        expect(await leakedFrom(vfs)).toEqual([]);
    });
});

describe("stopping a mount [A10]", () => {
    function slowWalk(vfs, ms) {
        return new Proxy(vfs, {
            get(t, k) {
                const v = t[k];
                if (typeof v !== "function") return v;
                if (k === "walk") return async (p) => { await sleep(ms); return v.call(t, p); };
                return v.bind(t);
            },
        });
    }

    it("returns when Ctrl-C arrives during the first pass", async () => {
        const { vfs } = realVfs();
        await vfs.writeFile("/apps/p/r.txt", enc("r"));   // so the slow walk is taken
        const dir = await tmp("a10");
        await put(dir, "a.txt", "a");
        const controller = new AbortController();
        const running = mount({ client: { vfs: slowWalk(vfs, 600) }, dir, root: "/apps/p", signal: controller.signal });
        setTimeout(() => controller.abort(), 150);
        expect(await Promise.race([running.then(() => "returned"), sleep(4000).then(() => "hung")])).toBe("returned");
    });

    it("returns at once when already stopped", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("a10-pre");
        const controller = new AbortController();
        controller.abort();
        const running = mount({ client: { vfs }, dir, root: "/apps/p", signal: controller.signal });
        expect(await Promise.race([running.then(() => "returned"), sleep(2000).then(() => "hung")])).toBe("returned");
    });

    it("stops a long first pass between steps, and records what it did", async () => {
        // More files than the pulls fetched at once, so the pass is still
        // going when it is stopped.
        const n = 40;
        const files = Object.fromEntries(Array.from({ length: n }, (_, i) => [`/apps/p/f${i}.txt`, `f${i}`]));
        const vfs = memVfs(files);
        const read = vfs.readFile.bind(vfs);
        let pulls = 0;
        vfs.readFile = async (p) => {
            if (++pulls > n) await sleep(250);   // the scan's reads are quick; the pulls are not
            return read(p);
        };
        const dir = await tmp("a10-steps");
        const controller = new AbortController();
        const running = mount({ client: { vfs }, dir, root: "/apps/p", signal: controller.signal });
        setTimeout(() => controller.abort(), 500);
        expect(await Promise.race([running.then(() => "returned"), sleep(1800).then(() => "hung")])).toBe("returned");
        const after = pulls;
        await sleep(600);
        expect(pulls).toBe(after);   // nothing still running behind it
        const onDisk = (await readdir(dir)).filter((n) => n.endsWith(".txt")).map((n) => "/" + n).sort();
        expect(onDisk.length).toBeLessThan(n);
        expect(Object.keys(await savedState(dir)).sort()).toEqual(onDisk);
    });

    it("waits for a pass already under way before it returns", async () => {
        const vfs = memVfs();
        const write = vfs.writeFile.bind(vfs);
        let writing = 0;
        vfs.writeFile = async (p, b) => {
            writing++;
            await sleep(700);
            await write(p, b);
            writing--;
        };
        const dir = await tmp("a10-inflight");
        await put(dir, "a.txt", "a");
        const controller = new AbortController();
        const running = mount({ client: { vfs }, dir, root: "/apps/p", signal: controller.signal });
        await until(() => vfs.data.has("/apps/p/a.txt"));
        await writeFile(join(dir, "a.txt"), "edited");
        await until(() => writing > 0);
        controller.abort();
        await running;
        expect(writing).toBe(0);
        expect(dec(vfs.data.get("/apps/p/a.txt"))).toBe("edited");
    });
});

describe("the breaker remembers the peak [L8]", () => {
    it("a remote that deletes just under half each pass is held once the slices add up", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("l8-slices");
        for (let i = 0; i < 20; i++) await put(dir, `src/f${String(i).padStart(2, "0")}.ts`, `f${i}`);
        const session = {};
        const opts = { allowDelete: true };
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, opts, session });
        for (let i = 0; i < 9; i++) await vfs.delete(`/apps/p/src/f${String(i).padStart(2, "0")}.ts`);
        state = await reconcile({ vfs, dir, root: "/apps/p", state, opts, session });
        expect((await readdir(join(dir, "src"))).length).toBe(11);
        for (let i = 9; i < 14; i++) await vfs.delete(`/apps/p/src/f${String(i).padStart(2, "0")}.ts`);
        state = await reconcile({ vfs, dir, root: "/apps/p", state, opts, session });
        expect((await readdir(join(dir, "src"))).length).toBe(11);
        expect(lines.some((l) => /refusing to delete 5 of 11/.test(l))).toBe(true);
    });
});

describe("the breaker on a small project [review]", () => {
    it("does not wipe a three-file project when its remote root is renamed", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("breaker-small");
        for (const n of ["a", "b", "c"]) await put(dir, `${n}.ts`, n);
        const state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.rename("/apps/p", "/apps/q");
        await reconcile({ vfs, dir, root: "/apps/p", state, opts: { allowDelete: true } });
        expect((await readdir(dir)).filter((n) => n.endsWith(".ts")).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    });
});

describe("what never syncs, whatever the rules say [review]", () => {
    it("--hidden: a leftover .muhkoo-tmp- file is neither uploaded nor pulled", async () => {
        const vfs = memVfs({ "/apps/p/lib/.muhkoo-tmp-0badc0ffee00": "REMOTE" });
        const dir = await tmp("tmpfile");
        await put(dir, "src/.muhkoo-tmp-abc123", "half-written");
        await put(dir, "src/a.ts", "a");
        await reconcile({ vfs, dir, root: "/apps/p", state: {}, opts: { hidden: true } });
        expect([...vfs.data.keys()].sort()).toEqual(["/apps/p/lib/.muhkoo-tmp-0badc0ffee00", "/apps/p/src/a.ts"]);
        expect(await exists(join(dir, "lib"))).toBe(false);
    });
});

describe("what a live run prints [review]", () => {
    it("says which side a delete landed on, with the dry-run's symbols", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("signs");
        for (const n of ["a", "b", "c", "d", "e"]) await put(dir, `${n}.ts`, n);
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await rm(join(dir, "a.ts"));
        await vfs.delete("/apps/p/b.ts");
        lines.length = 0;
        state = await reconcile({ vfs, dir, root: "/apps/p", state, opts: { allowDelete: true } });
        expect(lines.find((l) => l.includes("/a.ts"))).toMatch(/^✕↑ /);
        expect(lines.find((l) => l.includes("/b.ts"))).toMatch(/^✕↓ /);
    });

    it("an import whose only differences are skipped does not claim to match", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("import-skip");
        await put(dir, "a.ts", "a");
        await importOnce({ client: { vfs }, dir, root: "/apps/p" });
        await vfs.writeFile("/apps/p/b.ts", enc("from the IDE"));
        lines.length = 0;
        await importOnce({ client: { vfs }, dir, root: "/apps/p" });
        expect(lines.some((l) => /already matches/.test(l))).toBe(false);
        expect(lines.some((l) => /nothing to upload/i.test(l))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Round 3: the sticky exclusion ratchet, which replaces the ignore baseline.

describe("the ignore ratchet: no edit can make an excluded path sync [G18, L1]", () => {
    /** The adversary's b1: a pulled `.vcsignore`, then one small local edit to it. */
    it.each([
        ["a blank line appended", (t) => t + "\n"],
        ["a rule added", (t) => t + "*.mp4\n"],
        ["only its line endings changed", (t) => t.replace(/\n/g, "\r\n")],
    ])("a local edit to a pulled .vcsignore (%s) keeps config/master.key home", async (_label, edit) => {
        const { vfs } = realVfs();
        const dir = await tmp("l1-b1");
        await put(dir, ".gitignore", "config/master.key\n");
        await put(dir, "config/master.key", "PLACEHOLDER\n");
        await put(dir, "src/app.js", "app\n");
        const session = {};
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session });
        await vfs.writeFile("/apps/p/.vcsignore", enc("# tidy-up\n"));
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        await writeFile(join(dir, ".vcsignore"), edit(await read(join(dir, ".vcsignore"))));
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        expect(await vfs.exists("/apps/p/config/master.key")).toBe(false);
    });

    it("a torn rules file refuses the pass, and syncs nothing", async () => {
        const { vfs } = realVfs();
        const dir = await secretProject("l1-torn");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.writeFile("/apps/p/.vcsignore", enc("# tidy-up\n"));
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        const file = join(dir, ".muhkoo", "ignore-rules.json");
        const text = await read(file);
        await writeFile(file, text.slice(0, Math.floor(text.length / 2)));
        await put(dir, "src/new.ts", "new\n");
        await vfs.writeFile("/apps/p/src/remote.ts", enc("remote\n"));
        await expect(reconcile({ vfs, dir, root: "/apps/p", state })).rejects.toThrow(/ignore-rules\.json[\s\S]*--accept/);
        expect(await leakedFrom(vfs)).toEqual([]);
        expect(await vfs.exists("/apps/p/src/new.ts")).toBe(false);
        expect(await exists(join(dir, "src", "remote.ts"))).toBe(false);
    });

    it("a genuine local loosening holds the files it would let through until --accept, then they sync", async () => {
        const { vfs } = realVfs();
        const dir = await secretProject("l1-loosen");
        const session = {};
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session });
        await writeFile(join(dir, ".gitignore"), "*.pem\ncredentials.json\n");   // master.key no longer ignored
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        expect(await leakedFrom(vfs)).toEqual([]);
        const notices = lines.filter((l) => l.includes("config/master.key") && l.includes("held back"));
        expect(notices).toHaveLength(1);   // once per session, not every pass
        expect(lines.some((l) => l.includes(`muhkoo vfs ignore ${dir} --accept`))).toBe(true);

        const { eligible } = await accept(dir);
        expect(eligible).toEqual(["/config/master.key"]);
        state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        expect(await leakedFrom(vfs)).toEqual(["/apps/p/config/master.key"]);
    });

    it("heldBack lists the local files only stored rules exclude, without changing anything", async () => {
        const { vfs } = realVfs();
        const dir = await secretProject("l1-list");
        await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await writeFile(join(dir, ".gitignore"), "credentials.json\n");
        const before = await read(join(dir, ".muhkoo", "ignore-rules.json"));
        expect((await heldBack(dir)).held).toEqual(["/config/master.key", "/server.pem"]);
        expect(await read(join(dir, ".muhkoo", "ignore-rules.json"))).toBe(before);
    });

    it("a remote tightening applies in the pass that brings it", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("l1-tighten");
        await put(dir, "src/a.ts", "a");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await put(dir, "notes/private.md", "mine");
        await vfs.writeFile("/apps/p/.gitignore", enc("notes/\n"));
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await vfs.exists("/apps/p/notes/private.md")).toBe(false);
    });

    it("at the snapshot cap the pass refuses, until the files are accepted", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("l1-cap");
        await put(dir, "src/a.ts", "a");
        await put(dir, ".gitignore", "initial\n");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });   // snapshot 1
        for (let i = 0; i < 63; i++) {
            await writeFile(join(dir, ".gitignore"), `rule${i}\n`);
            state = await reconcile({ vfs, dir, root: "/apps/p", state });        // snapshots 2..64
        }
        await writeFile(join(dir, ".gitignore"), "one-too-many\n");
        await put(dir, "src/b.ts", "b");
        // Naming what changed since the last accept, so the files to check are known.
        await expect(reconcile({ vfs, dir, root: "/apps/p", state })).rejects.toThrow(/\.gitignore \(changed\)[\s\S]*--accept/);
        expect(await vfs.exists("/apps/p/src/b.ts")).toBe(false);
        await accept(dir);
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await vfs.exists("/apps/p/src/b.ts")).toBe(true);
    });

    it("the byte cap refuses the same way", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("l1-bytes");
        await put(dir, "src/a.ts", "a");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        let refused = null;
        for (let i = 0; i < 12 && !refused; i++) {
            // Large but cheap to match: a run of `**/` is one `**`.
            await writeFile(join(dir, ".gitignore"), "**/".repeat(66_000) + `x${i}\n`);
            state = await reconcile({ vfs, dir, root: "/apps/p", state }).catch((err) => { refused = err; return state; });
        }
        expect(refused?.message).toMatch(/--accept/);
        expect((await stat(join(dir, ".muhkoo", "ignore-rules.json"))).size).toBeLessThanOrEqual(2 * 1024 * 1024);
    });

    it("switching branches back and forth never fills the snapshot list [review]", async () => {
        // `git checkout feature` / `git checkout main` with different
        // .gitignore files: two sets of rules, however many switches.
        const { vfs } = realVfs();
        const dir = await tmp("l1-toggle");
        await put(dir, "src/a.ts", "a");
        await put(dir, ".gitignore", "main-only.log\n");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        for (let i = 0; i < 100; i++) {
            await writeFile(join(dir, ".gitignore"), i % 2 ? "main-only.log\n" : "feature-only.log\n");
            state = await reconcile({ vfs, dir, root: "/apps/p", state });
        }
        const file = join(dir, ".muhkoo", "ignore-rules.json");
        const saved = JSON.parse(await read(file));
        expect(saved.snapshots).toHaveLength(2);
        // Back on rules it holds, though not the latest: a pass writes nothing.
        // A running mount wakes for that file, so a write here would loop.
        await writeFile(join(dir, ".gitignore"), "main-only.log\n");
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        const before = (await stat(file)).mtimeMs;
        await sleep(20);
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect((await stat(file)).mtimeMs).toBe(before);
    });

    it("comments, blank lines and line endings use no snapshot, pulled or local [review]", async () => {
        // The adversary's (g): 65 comment-only remote edits filled every slot.
        const { vfs } = realVfs();
        const dir = await secretProject("l1-comments");
        const session = {};
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session });
        for (let i = 0; i < 70; i++) {
            await vfs.writeFile("/apps/p/.gitignore", enc(`# edit ${i}\r\n\r\nconfig/master.key\r\n*.pem\r\ncredentials.json\r\n`));
            state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        }
        const saved = JSON.parse(await read(join(dir, ".muhkoo", "ignore-rules.json")));
        expect(saved.snapshots).toHaveLength(1);
        expect(await leakedFrom(vfs)).toEqual([]);
    });

    it("heavy ignore files from elsewhere never make the pass refuse, and every pass stays short [review]", async () => {
        // The adversary's forced-accept: files that together passed the old
        // work cap. Refusing the pass made `--accept` — which adopts them —
        // the only way to sync again. Nothing adds their cost up now: each
        // path is held to its own budget instead.
        const heavy = `*${"a".repeat(20)}b*c\n`.repeat(400);
        const { vfs } = realVfs();
        const dir = await secretProject("l1-forced");
        const session = {};
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session });
        await put(dir, "src/new.ts", "new\n");
        await vfs.writeFile("/apps/p/.gitignore", enc("# tidy-up\n"));
        for (const d of ["a", "a/b", "a/b/c"]) await vfs.writeFile(`/apps/p/${d}/.gitignore`, enc(heavy));
        for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
            expect(performance.now() - t0).toBeLessThan(2000);
        }
        expect(await leakedFrom(vfs)).toEqual([]);
        expect(await vfs.exists("/apps/p/src/new.ts")).toBe(true);
    });

    it("losing .muhkoo/ — `git clean -fdX` — does not reset the rules to whatever is on disk [review]", async () => {
        const { vfs } = realVfs();
        const dir = await secretProject("l1-clean");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.writeFile("/apps/p/.vcsignore", enc("# tidy-up\n"));
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await read(join(dir, ".vcsignore"))).toBe("# tidy-up\n");
        // What git clean -fdX removes: everything git ignores, .muhkoo/ included.
        await rm(join(dir, ".muhkoo"), { recursive: true, force: true });
        await rm(join(dir, "config"), { recursive: true, force: true });
        await put(dir, "config/master.key", "RAILS_MASTER_KEY_0123456789abcdef");
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state: i ? state : {} });
        expect(await leakedFrom(vfs)).toEqual([]);
    });

    it("a running mount acts on an accept at once, without waiting for another change [review]", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("l1-live-accept");
        await put(dir, ".gitignore", "notes.txt\n");
        await put(dir, "notes.txt", "mine\n");
        await put(dir, "src/a.ts", "a");
        const controller = new AbortController();
        const running = mount({ client: { vfs }, dir, root: "/apps/p", signal: controller.signal });
        try {
            await until(() => lines.some((l) => l.includes("In sync")));
            await writeFile(join(dir, ".gitignore"), "# nothing\n");
            await until(() => lines.some((l) => l.includes("held back")));
            await sleep(400);
            expect(await vfs.exists("/apps/p/notes.txt")).toBe(false);
            await accept(dir);
            await until(() => vfs.exists("/apps/p/notes.txt"), 2000);
        } finally {
            controller.abort();
            await running;
        }
    });

    it("--hidden: a project's own `!.env` syncs its .env, as it asks", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("l1-env-own");
        await put(dir, ".gitignore", "!.env\n");
        await put(dir, ".env", "SHARED=1\n");
        await reconcile({ vfs, dir, root: "/apps/p", state: {}, opts: { hidden: true } });
        expect(dec(await vfs.readFile("/apps/p/.env"))).toBe("SHARED=1\n");
    });

    it("--hidden: a pulled `!.env` cannot un-ignore this machine's .env", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("l1-env-remote");
        await put(dir, "src/a.ts", "a");
        await put(dir, ".env", "API_KEY=secret\n");
        const opts = { hidden: true };
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, opts });
        await vfs.writeFile("/apps/p/.gitignore", enc("!.env\n!.env.*\n"));
        for (let i = 0; i < 3; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, opts });
        expect(await read(join(dir, ".gitignore"))).toBe("!.env\n!.env.*\n");
        expect(await vfs.exists("/apps/p/.env")).toBe(false);
    });
});

describe("matcher cost and stopping, end to end [L3]", () => {
    it("a pass stopped during the local scan returns within a chunk, and syncs nothing", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("l3-local");
        for (let d = 0; d < 50; d++) {
            await mkdir(join(dir, `d${d}`));
            await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(dir, `d${d}`, `f${i}.txt`), `x${i}`)));
        }
        const controller = new AbortController();
        const running = reconcile({ vfs, dir, root: "/apps/p", state: {}, signal: controller.signal });
        await sleep(20);
        const t0 = performance.now();
        controller.abort();
        await running;
        expect(performance.now() - t0).toBeLessThan(150);
        expect(await vfs.exists("/apps/p")).toBe(false);
    });

    it("a planted in-limit hostile .vcsignore and 200 long names: a pass takes under 2s, and Ctrl-C returns at once", async () => {
        // The adversary's b3: 33s for the first pass, 31.8s for Ctrl-C to land.
        const { vfs } = realVfs();
        const dir = await tmp("l3-e2e");
        await put(dir, "src/app.js", "app\n");
        // Half the rules it had: all ten thousand are now over the work limit.
        const rules = Array.from({ length: 5_000 }, (_, i) => "*?" + "a".repeat(20) + "b" + (i % 10)).join("\n") + "\n";
        expect(ignoreFileProblem(rules)).toBe(null);
        await vfs.writeFile("/apps/p/.vcsignore", enc(rules));
        for (let i = 0; i < 200; i++) await vfs.writeFile(`/apps/p/f/${"a".repeat(240)}${String(i).padStart(4, "0")}`, enc("x"));
        let last = performance.now();
        let gap = 0;
        const timer = setInterval(() => {
            const now = performance.now();
            gap = Math.max(gap, now - last);
            last = now;
        }, 10);
        const controller = new AbortController();
        const t0 = performance.now();
        const running = mount({ client: { vfs }, dir, root: "/apps/p", signal: controller.signal });
        await until(() => lines.some((l) => l.includes("In sync")), 10_000);
        const firstPass = performance.now() - t0;
        await vfs.writeFile("/apps/p/src/other.js", enc("y"));
        await sleep(300);
        const stopAt = performance.now();
        controller.abort();
        await running;
        clearInterval(timer);
        gap = Math.max(gap, performance.now() - last);   // the stretch since the last tick counts too
        expect(firstPass).toBeLessThan(2000);
        expect(performance.now() - stopAt).toBeLessThan(300);
        expect(gap).toBeLessThan(250);
        expect((await readdir(join(dir, "f"))).length).toBe(200);
    }, 30_000);

    it("a planted class of 250,000 members and paths 61 deep: every pass is short, and Ctrl-C lands when pressed", async () => {
        // The adversary's cls-bomb-deep2: 15.8s for the first pass, 13.9s for
        // every pass after, and Ctrl-C answered 6.6s after it was pressed.
        // Beside the class, as much searched-run work as one file may hold.
        const { vfs } = realVfs();
        const dir = await tmp("l3-class");
        await put(dir, "src/app.js", "app\n");
        let text = "*[" + "b".repeat(250_000) + "]*\n";
        const heavy = `*${"a".repeat(20)}b*c\n`;
        while (!ignoreFileProblem(text + heavy)) text += heavy;
        await vfs.writeFile("/apps/p/.vcsignore", enc(text));
        for (let j = 0; j < 3; j++) {
            const deep = Array.from({ length: 60 }, (_, k) => `u${j}${"a".repeat(240)}${k}`).join("/");
            await vfs.writeFile(`/apps/p/${deep}/f`, enc("x"));
        }
        let last = performance.now();
        let gap = 0;
        const timer = setInterval(() => {
            const now = performance.now();
            gap = Math.max(gap, now - last);
            last = now;
        }, 10);
        const session = {};
        const passes = [];
        let state = {};
        const controller = new AbortController();
        try {
            for (let i = 0; i < 2; i++) {
                const t0 = performance.now();
                state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
                passes.push(performance.now() - t0);
            }
            // Ctrl-C at a moment of its own choosing: the clock it is measured
            // from is when it was pressed, not when a stalled loop got to it.
            const pressedAt = performance.now() + 150;
            setTimeout(() => controller.abort(), 150);
            while (!controller.signal.aborted) state = await reconcile({ vfs, dir, root: "/apps/p", state, session, signal: controller.signal });
            passes.push(performance.now() - pressedAt);
        } finally {
            clearInterval(timer);
        }
        gap = Math.max(gap, performance.now() - last);
        const [first, steady, stop] = passes;
        expect(lines.some((l) => l.includes("character class may list at most"))).toBe(true);
        expect(first).toBeLessThan(2000);
        expect(steady).toBeLessThan(1000);
        expect(stop).toBeLessThan(300);
        expect(gap).toBeLessThan(250);
    }, 90_000);
});

describe("what one pass may write here [L4]", () => {
    const MB = 1024 * 1024;
    /** The adversary's b12: one stored blob, many entries sharing it. */
    async function amplified(copies) {
        const { vfs, content } = realVfs();
        await vfs.writeFile("/apps/p/blob.bin", new Uint8Array(MB).fill(7));
        for (let i = 0; i < copies; i++) await vfs.copy("/apps/p/blob.bin", `/apps/p/c/${i}.bin`);
        expect(content.blobs.size).toBe(1);
        return vfs;
    }
    const pulledFiles = async (dir) => [
        ...(await readdir(dir)).filter((n) => n.endsWith(".bin")),
        ...(await readdir(join(dir, "c")).catch(() => [])),
    ].length;
    const roomy = async () => ({ bsize: 4096, blocks: 1e9, bavail: 5e8 });   // 4 TB, half free

    it("stops pulling at the pass's byte budget, and leaves the rest untouched", async () => {
        const vfs = await amplified(30);
        const dir = await tmp("l4-bytes");
        const session = { pullBudget: { bytes: 10 * MB, files: 10_000 }, statfs: roomy };
        const state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session });
        expect(await pulledFiles(dir)).toBe(10);
        expect(fileKeys(state)).toHaveLength(10);
        expect(lines.some((l) => /next pass/.test(l))).toBe(true);
    });

    it("and at its file budget", async () => {
        const vfs = await amplified(30);
        const dir = await tmp("l4-files");
        const session = { pullBudget: { bytes: 1024 * MB, files: 4 }, statfs: roomy };
        await reconcile({ vfs, dir, root: "/apps/p", state: {}, session });
        expect(await pulledFiles(dir)).toBe(4);
    });

    it("a running mount goes straight on in follow-up passes, not waiting to be woken", async () => {
        // Five more passes' worth. Woken only by the watcher (its own pulls
        // are file events), each would wait out the 250ms settle delay first.
        const vfs = await amplified(59);
        const dir = await tmp("l4-mount");
        const session = { pullBudget: { bytes: 10 * MB, files: 10_000 }, statfs: roomy };
        const controller = new AbortController();
        const running = mount({ client: { vfs }, dir, root: "/apps/p", signal: controller.signal, session });
        try {
            await until(() => lines.some((l) => l.includes("Watching for changes")), 10_000);
            const t0 = performance.now();
            await until(async () => (await pulledFiles(dir)) === 60, 10_000);
            expect(performance.now() - t0).toBeLessThan(700);
        } finally {
            controller.abort();
            await running;
        }
    });

    it("holds every pull that would leave the disk short of its reserve, and says so once", async () => {
        const vfs = await amplified(3);
        const dir = await tmp("l4-disk");
        // 4 GB volume: the reserve is 1 GiB (more than 5%). Just over 1 GiB free.
        const tight = async () => ({ bsize: 4096, blocks: 1_000_000, bavail: (1024 * MB + MB / 2) / 4096 });
        const session = { statfs: tight };
        let state = {};
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        expect(await pulledFiles(dir)).toBe(0);
        expect(filesOf(state)).toEqual({});
        expect(lines.filter((l) => /free/.test(l) && /reserve|less than/.test(l))).toHaveLength(1);
    });

    it("reserves at most 10 GiB, so a large disk with tens of gigabytes free still pulls", async () => {
        // 5% of 1 TB is 50 GB — a line many laptops live under for good.
        const vfs = await amplified(2);
        const dir = await tmp("l4-laptop");
        const laptop = async () => ({ bsize: 4096, blocks: 1e12 / 4096, bavail: 45e9 / 4096 });
        await reconcile({ vfs, dir, root: "/apps/p", state: {}, session: { statfs: laptop } });
        expect(await pulledFiles(dir)).toBe(3);
        const cramped = async () => ({ bsize: 4096, blocks: 1e12 / 4096, bavail: 9e9 / 4096 });
        const dir2 = await tmp("l4-cramped");
        await reconcile({ vfs, dir: dir2, root: "/apps/p", state: {}, session: { statfs: cramped } });
        expect(await pulledFiles(dir2)).toBe(0);
    });

    it("the defaults are 2 GiB and 10,000 files a pass", () => {
        expect(PULL_BUDGET).toEqual({ bytes: 2 * 1024 * MB, files: 10_000 });
    });

    // The size in a directory record is whatever the remote party wrote:
    // `writeManifest(path, manifest, 0)` points a record at real content and
    // says it holds nothing. The adversary's lying-size.mjs.
    const understated = async (vfs, path) => {
        const { manifest } = await vfs.statManifest(path);
        await vfs.writeManifest(path, manifest, 0);
    };
    /** The same vfs, except that `path` holds `later` once the scan has read it. */
    const swapping = (vfs, path, later) => changesAfterScan(vfs, path, async () => later);
    // A 10 GiB volume with 1 GiB and 100 KB free: a 1 MB pull would cut into the reserve.
    const nearlyFull = async () => ({ bsize: 1024, blocks: 10 * 1024 * MB / 1024, bavail: (1024 * MB + 100 * 1024) / 1024 });

    it("judges the disk reserve by the bytes that come down, not the size the record claims", async () => {
        const { vfs } = realVfs();
        await vfs.writeFile("/apps/p/blob.bin", new Uint8Array(MB).fill(7));
        await understated(vfs, "/apps/p/blob.bin");
        expect((await vfs.stat("/apps/p/blob.bin")).size).toBe(0);
        const dir = await tmp("l4-lie-disk");
        const state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session: { statfs: nearlyFull } });
        expect(await exists(join(dir, "blob.bin"))).toBe(false);
        expect(filesOf(state)).toEqual({});
        expect(lines.some((l) => /not pulling 1 file/.test(l))).toBe(true);
    });

    it("and by what it reads when it pulls, which need not be what the scan read", async () => {
        const { vfs } = realVfs();
        await vfs.writeFile("/apps/p/blob.bin", enc("x"));
        const dir = await tmp("l4-lie-swap");
        const state = await reconcile({
            vfs: swapping(vfs, "/apps/p/blob.bin", new Uint8Array(MB).fill(7)),
            dir, root: "/apps/p", state: {}, session: { statfs: nearlyFull },
        });
        expect(await exists(join(dir, "blob.bin"))).toBe(false);
        expect(filesOf(state)).toEqual({});
    });

    it("judges the pull budget by the bytes that come down", async () => {
        const { vfs } = realVfs();
        await vfs.writeFile("/apps/p/blob.bin", new Uint8Array(MB).fill(7));
        await understated(vfs, "/apps/p/blob.bin");
        for (let i = 0; i < 30; i++) await vfs.copy("/apps/p/blob.bin", `/apps/p/c/${i}.bin`);
        const dir = await tmp("l4-lie-budget");
        const session = { pullBudget: { bytes: 10 * MB, files: 10_000 }, statfs: roomy };
        const state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session });
        expect(await pulledFiles(dir)).toBe(10);
        expect(fileKeys(state)).toHaveLength(10);
    });

    it("never pulls a file over the size limit, whatever its record says", async () => {
        const { vfs } = realVfs();
        await vfs.writeFile("/apps/p/huge.bin", new Uint8Array(101 * MB).fill(1));
        await understated(vfs, "/apps/p/huge.bin");
        await vfs.writeFile("/apps/p/small.txt", enc("small"));
        const dir = await tmp("l4-lie-huge");
        const state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session: { statfs: roomy } });
        expect(await exists(join(dir, "huge.bin"))).toBe(false);
        expect(fileKeys(state)).toEqual(["/small.txt"]);
        expect(lines.some((l) => /huge\.bin/.test(l) && /over the mount limit/.test(l))).toBe(true);
    }, 30_000);

    it("nor one that grew past it after the scan", async () => {
        const { vfs } = realVfs();
        await vfs.writeFile("/apps/p/grows.bin", enc("x"));
        const dir = await tmp("l4-lie-grows");
        const state = await reconcile({
            vfs: swapping(vfs, "/apps/p/grows.bin", new Uint8Array(101 * MB)),
            dir, root: "/apps/p", state: {}, session: { statfs: roomy },
        });
        expect(await exists(join(dir, "grows.bin"))).toBe(false);
        expect(filesOf(state)).toEqual({});
    }, 30_000);
});

describe("heavy or numerous ignore files from elsewhere [review 2]", () => {
    /** The G18 project, and a first pass: the user's rules keep the key home. */
    async function mounted(label, opts = {}) {
        const { vfs } = realVfs();
        const dir = await tmp(label);
        await put(dir, ".gitignore", "config/master.key\n");
        await put(dir, "config/master.key", "PLACEHOLDER\n");
        await put(dir, "src/app.js", "app\n");
        const session = {};
        const state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, opts, session });
        return { vfs, dir, session, state, opts };
    }
    const passes = async (ctx, n = 1) => {
        for (let i = 0; i < n; i++) ctx.state = await reconcile({ vfs: ctx.vfs, dir: ctx.dir, root: "/apps/p", state: ctx.state, opts: ctx.opts, session: ctx.session });
    };

    it("one heavy .vcsignore pulled, then the user's own edit: the pass still syncs (the adversary's a1)", async () => {
        const ctx = await mounted("r2-a1");
        await ctx.vfs.writeFile("/apps/p/.vcsignore", enc("# tidy-up\n" + "*ǂ*\n".repeat(490)));
        await passes(ctx, 2);
        await appendFile(join(ctx.dir, ".gitignore"), "*.tmp\n");
        await put(ctx.dir, "src/new2.js", "new2\n");
        await passes(ctx, 2);
        expect(await ctx.vfs.exists("/apps/p/src/new2.js")).toBe(true);
        expect(await ctx.vfs.exists("/apps/p/config/master.key")).toBe(false);
    });

    it("--allow-delete: a remote delete of .gitignore after a heavy pull does not stop the pass (a2)", async () => {
        const ctx = await mounted("r2-a2", { allowDelete: true });
        await put(ctx.dir, "src/b.js", "b\n");
        await passes(ctx);
        await ctx.vfs.writeFile("/apps/p/.vcsignore", enc("# tidy-up\n" + "*ǂ*\n".repeat(490)));
        await passes(ctx, 2);
        await ctx.vfs.delete("/apps/p/.gitignore");
        await passes(ctx);
        await put(ctx.dir, "src/c.js", "c\n");
        await passes(ctx, 2);
        expect(await ctx.vfs.exists("/apps/p/src/c.js")).toBe(true);
        expect(await ctx.vfs.exists("/apps/p/config/master.key")).toBe(false);
    });

    it("thousands of nested ignore files pull in about the time the same tree takes without them (a3)", async () => {
        const K = 3000;
        const tree = async (name) => {
            const { vfs } = realVfs();
            for (let i = 0; i < K; i++) {
                await vfs.writeFile(`/apps/p/d${i}/${name}`, enc(`x${i}\n`));
                await vfs.writeFile(`/apps/p/d${i}/f.txt`, enc("f"));
            }
            return vfs;
        };
        const time = async (vfs) => {
            const dir = await tmp("r2-a3");
            const session = {};
            let t0 = performance.now();
            const state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session });
            const pull = performance.now() - t0;
            t0 = performance.now();
            await reconcile({ vfs, dir, root: "/apps/p", state, session });
            return { pull, steady: performance.now() - t0, pulled: fileKeys(state).length };
        };
        const control = await time(await tree("notignore.txt"));
        const nested = await time(await tree(".gitignore"));
        expect(nested.pulled).toBe(2 * K);
        expect(nested.pull).toBeLessThan(2 * control.pull + 1000);
        expect(nested.steady).toBeLessThan(2 * control.steady + 500);
    }, 120_000);
});

describe("a path too costly to match is left alone, not decided [review 2]", () => {
    it("neither synced nor deleted, in either direction, and named in one warning", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("costly");
        const long = (tag) => `${tag}${"a".repeat(200)}c`;
        await put(dir, ".vcsignore", `*${"a".repeat(20)}b*c\n`.repeat(50));
        await put(dir, "src/app.js", "app");
        await put(dir, `src/${long("mine")}`, "local");
        await vfs.writeFile(`/apps/p/src/${long("theirs")}`, enc("remote"));
        const session = { pathBudget: 50_000 };
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session, opts: { allowDelete: true } });
        expect(await vfs.exists("/apps/p/src/app.js")).toBe(true);
        expect(await vfs.exists(`/apps/p/src/${long("mine")}`)).toBe(false);
        expect(await exists(join(dir, "src", long("theirs")))).toBe(false);
        const warned = lines.filter((l) => /too long/.test(l));
        expect(warned).toHaveLength(1);
        expect(warned[0]).toMatch(/2 paths/);
        state = await reconcile({ vfs, dir, root: "/apps/p", state, session, opts: { allowDelete: true } });
        expect(await vfs.exists(`/apps/p/src/${long("theirs")}`)).toBe(true);
        expect(await exists(join(dir, "src", long("mine")))).toBe(true);
    });
});

describe("what one pass reads from your filesystem [review]", () => {
    const MB = 1024 * 1024;
    /** A real vfs whose content reads are counted, in calls and bytes. */
    function countedReads() {
        const { vfs, content } = realVfs();
        const read = content.read.bind(content);
        const reads = { calls: 0, bytes: 0 };
        content.read = async (m) => {
            const bytes = await read(m);
            reads.calls++;
            reads.bytes += bytes.length;
            return bytes;
        };
        return { vfs, content, reads };
    }

    it("reads a blob shared by many entries once in a pass, and nothing on a pass after", async () => {
        // The adversary's a5: one 4 MB blob, 200 entries sharing it. Every
        // pass read and decrypted all 200 — 868 MB — to hash them.
        const { vfs, content, reads } = countedReads();
        await vfs.writeFile("/apps/p/blob.bin", new Uint8Array(4 * MB).fill(7));
        for (let i = 0; i < 200; i++) await vfs.copy("/apps/p/blob.bin", `/apps/p/c/${i}.bin`);
        expect(content.blobs.size).toBe(1);
        const dir = await tmp("reads-shared");
        const session = { statfs: async () => ({ bsize: 4096, blocks: 1e9, bavail: 5e8 }) };
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session });
        expect(fileKeys(state)).toHaveLength(201);
        expect(reads.calls).toBe(1);
        reads.calls = 0;
        state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        expect(reads.calls).toBe(0);
        // A changed entry is read again, and only it.
        await vfs.writeFile("/apps/p/c/7.bin", enc("changed"));
        state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        expect(reads.calls).toBe(1);
        expect(await read(join(dir, "c", "7.bin"))).toBe("changed");
    }, 60_000);

    it("stops reading at the pass's read budget: the rest wait, untouched, and later passes carry on", async () => {
        const { vfs, reads } = countedReads();
        for (let i = 0; i < 30; i++) await vfs.writeFile(`/apps/p/f${String(i).padStart(2, "0")}.bin`, new Uint8Array(MB).fill(i));
        const dir = await tmp("reads-budget");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        // Every file changes remotely; this disk still holds the old ones.
        for (let i = 0; i < 30; i++) await vfs.writeFile(`/apps/p/f${String(i).padStart(2, "0")}.bin`, new Uint8Array(MB).fill(100 + i));
        const session = { readBudget: { bytes: 10 * MB, files: 10_000 } };
        reads.calls = 0;
        const opts = { allowDelete: true };
        state = await reconcile({ vfs, dir, root: "/apps/p", state, opts, session });
        expect(reads.calls).toBe(10);
        const now = async () => {
            const out = [];
            for (let i = 0; i < 30; i++) out.push((await readFile(join(dir, `f${String(i).padStart(2, "0")}.bin`)))[0]);
            return out;
        };
        const firstPass = await now();
        expect(firstPass.filter((b) => b >= 100)).toHaveLength(10);
        expect(firstPass).toHaveLength(30);   // nothing deleted
        expect(session.more).toBe(true);
        for (let i = 0; i < 3; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, opts, session });
        expect((await now()).every((b) => b >= 100)).toBe(true);
    }, 60_000);

    it("never reads a file whose manifest admits it is over the size limit, whatever size its record claims", async () => {
        // The record's size is a claim; the manifest's chunk sizes are what a
        // read is held to, so they bound it before anything is fetched.
        const huge = { id: "x", chunks: [{ ciphertextSize: 150 * MB, shardSize: 40 * MB, shardHashes: ["a", "b", "c", "d", "e", "f"] }] };
        const wide = { id: "y", chunks: [{ ciphertextSize: 1024, shardSize: 60 * MB, shardHashes: ["a", "b", "c", "d", "e", "f"] }] };
        const vfs = memVfs({ "/apps/p/huge.bin": "", "/apps/p/wide.bin": "", "/apps/p/ok.txt": "ok" });
        vfs.statManifest = async (p) => ({ manifest: p.endsWith("huge.bin") ? huge : p.endsWith("wide.bin") ? wide : { id: p }, size: 1 });
        const dir = await tmp("reads-manifest");
        const state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        expect(vfs.calls.readFile.filter((p) => !p.endsWith("ok.txt"))).toEqual([]);
        expect(fileKeys(state)).toEqual(["/ok.txt"]);
        expect(lines.some((l) => /huge\.bin/.test(l) && /over the mount limit/.test(l))).toBe(true);
    });

    it("does not fetch a pull that cannot fit the pass's budget [review]", async () => {
        // Checked before the read, so a held pull costs no download.
        const vfs = memVfs(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`/apps/p/f${i}.txt`, `f${i}`])));
        const dir = await tmp("pull-precheck");
        await reconcile({ vfs, dir, root: "/apps/p", state: {}, session: { pullBudget: { bytes: 1024 * MB, files: 2 } } });
        expect(vfs.calls.readFile).toHaveLength(5 + 2);
    });
});

describe("files already identical on both sides are in sync [review]", () => {
    // A checkout mounted onto the project it came from: nothing to copy, and
    // nothing recorded either — so a teammate's next edit read as changed on
    // both sides, and this machine's stale copy replaced it.
    it("a second machine's identical checkout takes the next remote edit, not a conflict", async () => {
        const { vfs } = realVfs();
        const A = await tmp("same-a");
        await put(A, "src/app.js", "v1");
        let stateA = await reconcile({ vfs, dir: A, root: "/p", state: {} });
        const B = await tmp("same-b");
        await put(B, "src/app.js", "v1");
        let stateB = await reconcile({ vfs, dir: B, root: "/p", state: {} });
        expect(filesOf(stateB)).toEqual({ "/src/app.js": sha("v1") });
        await writeFile(join(A, "src", "app.js"), "v2 from A");
        stateA = await reconcile({ vfs, dir: A, root: "/p", state: stateA });
        stateB = await reconcile({ vfs, dir: B, root: "/p", state: stateB });
        expect(lines.some((l) => /conflict/.test(l))).toBe(false);
        expect(dec(await vfs.readFile("/p/src/app.js"))).toBe("v2 from A");
        expect(await read(join(B, "src", "app.js"))).toBe("v2 from A");
    });

    it("import records them too", async () => {
        const { vfs } = realVfs();
        await vfs.writeFile("/p/a.txt", enc("same"));
        const dir = await tmp("same-import");
        await put(dir, "a.txt", "same");
        await importOnce({ client: { vfs }, dir, root: "/p" });
        expect(await savedState(dir)).toEqual({ "/a.txt": sha("same") });
    });
});

describe("fold collisions are judged the way this volume folds [L6]", () => {
    it("names APFS holds side by side sync between two machines: colons, a trailing dot, a superscript", async () => {
        const { vfs } = realVfs();
        const A = await tmp("l6-a");
        const names = {
            "logs/run-10:30.txt": "first run", "logs/run-10:45.txt": "second run",
            "notes/v2.md": "v2", "notes/v².md": "v squared",
            "data/report": "no ext", "data/report.": "trailing dot",
        };
        for (const [rel, text] of Object.entries(names)) await put(A, rel, text);
        let stateA = await reconcile({ vfs, dir: A, root: "/apps/c", state: {} });
        expect((await vfs.walk("/apps/c")).length).toBe(6);

        const B = await tmp("l6-b");
        let stateB = {};
        for (let i = 0; i < 2; i++) stateB = await reconcile({ vfs, dir: B, root: "/apps/c", state: stateB });
        for (const [rel, text] of Object.entries(names)) expect([rel, await read(join(B, rel))]).toEqual([rel, text]);
        expect(lines.filter((l) => /cannot hold both/.test(l))).toEqual([]);

        await writeFile(join(A, "logs", "run-10:30.txt"), "first run EDITED");
        stateA = await reconcile({ vfs, dir: A, root: "/apps/c", state: stateA });
        expect(dec(await vfs.readFile("/apps/c/logs/run-10:30.txt"))).toBe("first run EDITED");
        stateB = await reconcile({ vfs, dir: B, root: "/apps/c", state: stateB });
        expect(await read(join(B, "logs", "run-10:30.txt"))).toBe("first run EDITED");
    });

    it("a deep remote tree is filtered quickly on a folding volume, without stalling [L8]", async () => {
        // The adversary's b11: 20,000 paths 60 deep took 12.9s, 11.8s of it in
        // one synchronous stretch, refolding every prefix of every path.
        const paths = Array.from({ length: 20_000 }, (_, i) => "/apps/p/" + Array.from({ length: 59 }, (_, d) => `dir${d % 7}`).join("/") + `/f${i}.txt`);
        const vfs = { stat: async () => ({ size: 1 }), readFile: async () => new Uint8Array() };
        let last = performance.now();
        let gap = 0;
        const timer = setInterval(() => {
            const now = performance.now();
            gap = Math.max(gap, now - last);
            last = now;
        }, 5);
        const t0 = performance.now();
        const { files } = await scanRemote(vfs, "/apps/p", false, () => false, { paths, ignoreCase: true, localKeys: new Set(), session: { readBudget: null } });
        const took = performance.now() - t0;
        clearInterval(timer);
        gap = Math.max(gap, performance.now() - last);
        expect(Object.keys(files)).toHaveLength(20_000);
        expect(took).toBeLessThan(3000);
        expect(gap).toBeLessThan(250);   // slices of 25ms, and room for a collection under load
    }, 30_000);
});

// ---------------------------------------------------------------------------
// Final round. Ids are the brief's (F1–F6).

describe("the snapshot list changes only by append or accept [F1]", () => {
    // The r3 adversary's n1 and n1b: a byte-order mark on the first RULE line
    // hid its `!` from the subsumption check, which then dropped the snapshot
    // that kept the file home — and it uploaded, with no accept.
    it.each([
        ["a new nested config/.gitignore", "/apps/p/config/.gitignore", () => "\n﻿!master.key\n", "config/master.key", {}],
        ["the root .gitignore, with --hidden", "/apps/p/.gitignore", (t) => "# keep\n﻿!.env\n" + t, ".env", { hidden: true }],
    ])("a BOM on the first rule line of %s cannot let out what the rules kept home", async (_label, where, edit, secret, opts) => {
        const { vfs } = realVfs();
        const dir = await tmp("f1-bom");
        await put(dir, ".gitignore", "config/master.key\n");
        await put(dir, "config/master.key", "PLACEHOLDER-SECRET\n");
        await put(dir, "config/app.json", "{}\n");
        await put(dir, ".env", "API_KEY=placeholder\n");
        await put(dir, "src/app.js", "app\n");
        const session = {};
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, opts, session });
        const before = (await vfs.exists(where)) ? dec(await vfs.readFile(where)) : "";
        await vfs.writeFile(where, enc(edit(before)));
        for (let i = 0; i < 3; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, opts, session });
        expect(await exists(join(dir, where.slice("/apps/p/".length)))).toBe(true);   // it arrived
        expect(await vfs.exists(`/apps/p/${secret}`)).toBe(false);
    });

    it("a rule appended is one more snapshot: the one before it is kept", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("f1-append");
        await put(dir, ".gitignore", "secret.txt\n");
        await put(dir, "src/a.ts", "a");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await appendFile(join(dir, ".gitignore"), "*.log\n");
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        const saved = JSON.parse(await read(join(dir, ".muhkoo", "ignore-rules.json")));
        expect(saved.snapshots.map((set) => set.map((i) => saved.files[i]))).toEqual([
            [[".gitignore", "secret.txt"]],
            [[".gitignore", "secret.txt\n*.log"]],
        ]);
    });

    it("a negation appended still waits for an accept", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("f1-neg");
        await put(dir, ".gitignore", "secret.txt\n");
        await put(dir, "secret.txt", "s");
        let state = await reconcile({ vfs, dir, root: "/p", state: {} });
        await appendFile(join(dir, ".gitignore"), "!secret.txt\n");
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/p", state });
        expect(await vfs.exists("/p/secret.txt")).toBe(false);
    });

    it("a .gitignore whose first rule line starts with a BOM is one snapshot, written once (the r3 adversary's n6)", async () => {
        // Its rules text read back differently from how it was stored, so
        // every pass saw new rules, and rewrote the file a running mount
        // wakes for — four passes a second, forever.
        const { vfs } = realVfs();
        const dir = await tmp("f1-bom-own");
        await put(dir, ".gitignore", "# project\n﻿build/\n");
        await put(dir, "src/app.js", "app\n");
        const session = {};
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session });
        const file = join(dir, ".muhkoo", "ignore-rules.json");
        const { ino } = await stat(file);
        for (let i = 0; i < 5; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        expect((await stat(file)).ino).toBe(ino);
        expect(JSON.parse(await read(file)).snapshots).toHaveLength(1);
    });
});

describe("ignore files from elsewhere count against the caps like your own [F2]", () => {
    it("remote edits that fill the list make the pass refuse, syncing nothing, until an accept", async () => {
        // An accepted denial of service: a remote party can force the
        // review-and-accept, never a leak.
        const { vfs } = realVfs();
        const dir = await tmp("f2-cap");
        await put(dir, ".gitignore", "config/master.key\n");
        await put(dir, "config/master.key", "PLACEHOLDER\n");
        await put(dir, "src/app.js", "app\n");
        const session = {};
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session });
        let refused = null;
        for (let i = 0; i < 70 && !refused; i++) {
            await vfs.writeFile("/apps/p/zz/.gitignore", enc(`zz${i}\n`));
            state = await reconcile({ vfs, dir, root: "/apps/p", state, session }).catch((err) => {
                refused = err;
                return state;
            });
        }
        expect(refused?.message).toMatch(/zz\/\.gitignore \(new\)[\s\S]*muhkoo vfs ignore .* --accept/);
        await put(dir, "src/b.js", "b\n");
        await expect(reconcile({ vfs, dir, root: "/apps/p", state, session })).rejects.toThrow(/Nothing was synced/);
        expect(await vfs.exists("/apps/p/src/b.js")).toBe(false);
        await accept(dir);
        state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        expect(await vfs.exists("/apps/p/src/b.js")).toBe(true);
        expect(await vfs.exists("/apps/p/config/master.key")).toBe(false);
    }, 60_000);
});

describe("ignore files are pulls like any other [F4]", () => {
    const KB = 1024;
    const MB = 1024 * KB;
    const GiB = 1024 * MB;
    // The r3 adversary's n2: 256 KB of comments, whose rules are nothing at
    // all, as many nested .gitignore files. They skipped every limit.
    const comments = (tag) => (`#${tag}`.padEnd(255, "x") + "\n").repeat(1024);
    async function flood(n, { distinct = false } = {}) {
        const { vfs, content } = realVfs();
        await vfs.writeFile("/apps/p/d0/.gitignore", enc(comments(distinct ? 0 : "")));
        for (let i = 1; i < n; i++) {
            if (distinct) await vfs.writeFile(`/apps/p/d${i}/.gitignore`, enc(comments(i)));
            else await vfs.copy("/apps/p/d0/.gitignore", `/apps/p/d${i}/.gitignore`);
        }
        const dir = await tmp("f4-flood");
        await put(dir, "src/app.js", "app\n");
        return { vfs, content, dir };
    }
    const landed = async (dir) => {
        let files = 0;
        let bytes = 0;
        for (const e of await readdir(dir)) {
            const s = await stat(join(dir, e, ".gitignore")).catch(() => null);
            if (s) {
                files++;
                bytes += s.size;
            }
        }
        return { files, bytes };
    };
    const roomy = async () => ({ bsize: 4096, blocks: 1e9, bavail: 5e8 });

    it("a disk short of its reserve lands none of them, and says so once", async () => {
        const { vfs, dir } = await flood(40);
        // 100 GiB, 2 GiB free: the reserve is 5 GiB.
        const short = async () => ({ bsize: 4096, blocks: (100 * GiB) / 4096, bavail: (2 * GiB) / 4096 });
        const session = { statfs: short };
        let state = {};
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        expect(await landed(dir)).toEqual({ files: 0, bytes: 0 });
        expect(lines.filter((l) => /reserve/.test(l) && /not pulling/.test(l))).toHaveLength(1);
        // Uploads wait for them, and the warning names five, not forty.
        const held = lines.filter((l) => /not uploading/.test(l));
        expect(held).toHaveLength(1);
        expect(held[0].split("\n").filter((l) => /\/\.gitignore:/.test(l))).toHaveLength(5);
        expect(held[0]).toMatch(/and 35 more ignore files/);
    }, 60_000);

    it("the pull budget bounds them", async () => {
        const { vfs, dir } = await flood(40);
        const session = { statfs: roomy, pullBudget: { bytes: MB, files: 5 } };
        await reconcile({ vfs, dir, root: "/apps/p", state: {}, session });
        const { files, bytes } = await landed(dir);
        expect(files).toBeGreaterThan(0);
        expect(files).toBeLessThanOrEqual(5);
        expect(bytes).toBeLessThanOrEqual(MB);
        expect(session.more).toBe(true);
    }, 60_000);

    it("one the read budget leaves for the next pass holds uploads until it is read", async () => {
        const { vfs } = realVfs();
        for (const f of ["a1.txt", "a2.txt", "a3.txt"]) await vfs.writeFile(`/apps/p/${f}`, enc(f));
        await vfs.writeFile("/apps/p/z/.gitignore", enc("secret.txt\n"));
        const dir = await tmp("f4-deferred");
        await put(dir, "z/secret.txt", "PLACEHOLDER-SECRET");
        const session = { statfs: roomy, readBudget: { bytes: MB, files: 1 } };
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session });
        expect(await vfs.exists("/apps/p/z/secret.txt")).toBe(false);
        expect(lines.some((l) => l.includes("/z/.gitignore: this pass has read all it may"))).toBe(true);
        for (let i = 0; i < 4; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state, session });
        expect(await read(join(dir, "z", ".gitignore"))).toBe("secret.txt\n");
        expect(await vfs.exists("/apps/p/z/secret.txt")).toBe(false);
    });

    it("the read budget bounds them, across both rounds of a pass", async () => {
        const { vfs, content, dir } = await flood(40, { distinct: true });
        const reads = { calls: 0 };
        const read = content.read.bind(content);
        content.read = async (m) => {
            reads.calls++;
            return read(m);
        };
        const session = { statfs: roomy, readBudget: { bytes: MB, files: 5 } };
        await reconcile({ vfs, dir, root: "/apps/p", state: {}, session });
        expect(reads.calls).toBeLessThanOrEqual(5);
        expect(session.more).toBe(true);
    }, 60_000);
});

describe("the copy of the rules under ~/.muhkoo [F5]", () => {
    it("belongs to the root mounted there: another project at the same path, from another root, starts afresh", async () => {
        // The r3 legit-use reviewer's mirror-reuse.
        const { vfs } = realVfs();
        const dir = await tmp("f5-reuse");
        await put(dir, ".gitignore", "reports/\n");
        await put(dir, "src/a.ts", "a");
        await reconcile({ vfs, dir, root: "/apps/old", state: {} });
        await rm(dir, { recursive: true, force: true });
        await put(dir, "src/b.ts", "b");
        await put(dir, "reports/q3.md", "quarterly");
        await reconcile({ vfs, dir, root: "/apps/new", state: {} });
        expect(await vfs.exists("/apps/new/reports/q3.md")).toBe(true);
        expect(lines.some((l) => /held back/.test(l))).toBe(false);
    });

    it("after `git clean -fdX`, a pass that refuses on the copy still leaves `vfs ignore --accept` a way out", async () => {
        // `vfs ignore` has no root to find the copy by, only the state file,
        // which a refused pass never rewrites.
        const { vfs } = realVfs();
        const dir = await tmp("f5-clean-cap");
        await put(dir, ".gitignore", "rule0\n");
        await put(dir, "src/a.ts", "a");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        for (let i = 1; i < 64; i++) {
            await writeFile(join(dir, ".gitignore"), `rule${i}\n`);
            state = await reconcile({ vfs, dir, root: "/apps/p", state });
        }
        await rm(join(dir, ".muhkoo"), { recursive: true, force: true });
        await writeFile(join(dir, ".gitignore"), "one-too-many\n");
        await expect(reconcile({ vfs, dir, root: "/apps/p", state: {} })).rejects.toThrow(/--accept/);
        expect((await heldBack(dir)).mounted).toBe(true);
        await accept(dir);
        await put(dir, "src/b.ts", "b");
        await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        expect(await vfs.exists("/apps/p/src/b.ts")).toBe(true);
    }, 60_000);

    it("a rules file in the unreleased v1 format is not read: the pass refuses until an accept", async () => {
        const { vfs } = realVfs();
        const dir = await secretProject("f5-v1");
        const state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await writeFile(join(dir, ".muhkoo", "ignore-rules.json"), JSON.stringify({ v: 1, snapshots: [{ ".gitignore": "config/master.key" }] }));
        await expect(reconcile({ vfs, dir, root: "/apps/p", state })).rejects.toThrow(/ignore-rules\.json[\s\S]*--accept/);
    });
});

describe("what a mount says [F6]", () => {
    const MB = 1024 * 1024;
    const roomy = async () => ({ bsize: 4096, blocks: 1e9, bavail: 5e8 });
    it.each([
        ["for disk space", { statfs: async () => ({ bsize: 4096, blocks: 1e6, bavail: 1024 * MB / 4096 }) }, /3 files wait for disk space/],
        ["at its pull budget", { statfs: roomy, pullBudget: { bytes: 1024 * MB, files: 1 } }, /2 files follow in the next pass/],
    ])("does not say it is in sync when pulls were held %s, and says what is held", async (_label, session, said) => {
        const { vfs } = realVfs();
        for (const f of ["a", "b", "c"]) await vfs.writeFile(`/apps/p/${f}.txt`, enc(f));
        const dir = await tmp("f6-held");
        await mountFor(400, { client: { vfs }, dir, root: "/apps/p", session });
        expect(lines.some((l) => /In sync/.test(l))).toBe(false);
        expect(lines.some((l) => said.test(l) && /Watching for changes/.test(l))).toBe(true);
    });

    it("a fresh machine's held notice does not say rules were dropped, when none were", async () => {
        // The r3 legit-use reviewer's e2e-env: B's first snapshot is the
        // defaults, and the project's own `!.env` re-includes .env.
        const { vfs } = realVfs();
        const A = await tmp("f6-env-a");
        await put(A, ".gitignore", "!.env\n");
        await put(A, ".env", "SHARED=1\n");
        await reconcile({ vfs, dir: A, root: "/p", state: {}, opts: { hidden: true } });
        const B = await tmp("f6-env-b");
        let state = {};
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir: B, root: "/p", state, opts: { hidden: true } });
        expect(lines.some((l) => /held back/.test(l) && l.includes(".env"))).toBe(true);
        expect(lines.some((l) => /dropped/.test(l))).toBe(false);
    });
});

describe("mount --dry-run holds uploads back as the pass does [review 3]", () => {
    // A pass uploads nothing while an ignore file from your filesystem cannot
    // be read: its rules may keep some of those files home. The preview listed
    // and counted those uploads anyway, with no word about the file.
    it("marks the uploads held, leaves them out of the count, and names the ignore file", async () => {
        const vfs = memVfs({ "/apps/p/.gitignore": "secret.txt\n", "/apps/p/fine.txt": "f" }, { unreadable: ["/apps/p/.gitignore"] });
        const dir = await tmp("dry-waits");
        await put(dir, "secret.txt", "s");
        await previewMount({ client: { vfs }, dir, root: "/apps/p" });
        const out = lines.join("\n");
        expect(out).toMatch(/↓ \/fine\.txt/);
        expect(out).toMatch(/↑ \/secret\.txt.*held/);
        expect(out).toMatch(/1 to download, 0 to upload/);
        expect(out).toMatch(/\/\.gitignore: it could not be read/);

        // …as the real pass does: the pull, and no upload.
        await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        expect(vfs.calls.writeFile).toEqual([]);
        expect(await read(join(dir, "fine.txt"))).toBe("f");
    });

    it("does not hold anything when the local copy is the one last synced", async () => {
        const vfs = memVfs({ "/apps/p/.gitignore": "secret.txt\n", "/apps/p/fine.txt": "f" });
        const dir = await tmp("dry-synced-rules");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await put(dir, "new.txt", "n");
        const original = vfs.readFile;
        vfs.readFile = async (p) => {   // the .gitignore this disk last synced, now unreadable there
            if (p === "/apps/p/.gitignore") throw new Error("content missing");
            return original.call(vfs, p);
        };
        lines.length = 0;
        await previewMount({ client: { vfs }, dir, root: "/apps/p" });
        const out = lines.join("\n");
        expect(out).toMatch(/↑ \/new\.txt$/m);
        expect(out).not.toMatch(/could not be read$/m);
        expect(out).toMatch(/1 to upload/);
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(vfs.calls.writeFile).toContain("/apps/p/new.txt");
    });
});

describe("pulls overlap, and every limit still holds [perf 2026-10]", () => {
    const KB = 1024;
    const GiB = 1024 * 1024 * 1024;
    const roomy = async () => ({ bsize: 4096, blocks: 1e9, bavail: 5e8 });
    /**
     * An in-memory vfs whose reads take a while, and which counts how many of
     * the PULL's reads are in flight at once. It has no manifests, so nothing
     * the scan read is reused: every pull reads again, as one past the pass's
     * blob cache does. The first read of a path is the scan's; any later one
     * is the pull's.
     */
    function slowVfs(files, { delay = 15 } = {}) {
        const vfs = memVfs(files);
        const seen = new Map();
        const pulls = { inFlight: 0, max: 0, reads: 0 };
        const readFile = vfs.readFile;
        vfs.readFile = async (p) => {
            const n = (seen.get(p) ?? 0) + 1;
            seen.set(p, n);
            const pull = n > 1;
            if (pull) { pulls.reads++; pulls.max = Math.max(pulls.max, ++pulls.inFlight); }
            try {
                await sleep(delay);
                return await readFile(p);
            } finally {
                if (pull) pulls.inFlight--;
            }
        };
        return { vfs, pulls };
    }
    const many = (n, size = 100, under = "/apps/p") =>
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`${under}/d${i % 3}/sub/f${String(i).padStart(2, "0")}.txt`, String(i).padEnd(size, ".")]));
    const landed = async (dir) => {
        let n = 0;
        for (const d of await readdir(dir)) {
            if (d.startsWith(".")) continue;
            n += (await readdir(join(dir, d, "sub")).catch(() => [])).length;
        }
        return n;
    };

    it("fetches several pulls at once, and lands every one — new directories included", async () => {
        const files = many(24);
        const { vfs, pulls } = slowVfs(files);
        const dir = await tmp("perf-overlap");
        const state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session: { statfs: roomy } });
        expect(pulls.reads).toBe(24);
        expect(pulls.max).toBeGreaterThan(1);
        expect(pulls.max).toBeLessThanOrEqual(8);
        expect(await landed(dir)).toBe(24);
        expect(fileKeys(state).sort()).toEqual(Object.keys(files).map((k) => k.slice("/apps/p".length)).sort());
        for (const [k, v] of Object.entries(files)) expect(await read(join(dir, k.slice("/apps/p".length)))).toBe(v);
        expect(lines.some((l) => /EEXIST|could not/.test(l))).toBe(false);
    });

    it("stops at the byte budget exactly, however many are in flight", async () => {
        const { vfs } = slowVfs(many(30, KB));
        const dir = await tmp("perf-bytes");
        const state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session: { statfs: roomy, pullBudget: { bytes: 10 * KB, files: 10_000 } } });
        expect(await landed(dir)).toBe(10);
        expect(fileKeys(state)).toHaveLength(10);
    });

    it("and at the file budget — reserving before it fetches, so a pull that cannot land is not fetched", async () => {
        const { vfs, pulls } = slowVfs(many(30));
        const dir = await tmp("perf-files");
        const state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session: { statfs: roomy, pullBudget: { bytes: GiB, files: 3 } } });
        expect(await landed(dir)).toBe(3);
        expect(fileKeys(state)).toHaveLength(3);
        expect(pulls.reads).toBe(3);
    });

    it("never lets pulls in flight together cut into the disk reserve", async () => {
        // A volume whose free space really shrinks as files land: room for
        // three 1 KB files above the 1 GiB reserve, not four. Each pull alone
        // fits; checked together, before any has landed, all would.
        const { vfs, pulls } = slowVfs(many(12, KB));
        const dir = await tmp("perf-reserve");
        const written = async () => {
            let total = 0;
            for (const d of await readdir(dir)) {
                if (d.startsWith(".")) continue;
                for (const f of await readdir(join(dir, d, "sub")).catch(() => [])) total += (await stat(join(dir, d, "sub", f))).size;
            }
            return total;
        };
        const shrinking = async () => ({ bsize: 1, blocks: 2 * GiB, bavail: GiB + 3.5 * KB - (await written()) });
        const state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session: { statfs: shrinking } });
        expect(await landed(dir)).toBe(3);
        expect(fileKeys(state)).toHaveLength(3);
        expect(lines.some((l) => /not pulling 9 files/.test(l))).toBe(true);
        expect(pulls.reads).toBe(3);   // reserved before fetching: the rest were never fetched
    });

    it("stops starting pulls when told, and records only what landed", async () => {
        const files = many(40);
        const { vfs, pulls } = slowVfs(files, { delay: 30 });
        const dir = await tmp("perf-abort");
        const controller = new AbortController();
        const reads = vfs.readFile;
        vfs.readFile = async (p) => {
            const out = reads(p);
            if (pulls.reads >= 5) controller.abort();
            return out;
        };
        const state = await reconcile({ vfs, dir, root: "/apps/p", state: {}, session: { statfs: roomy }, signal: controller.signal });
        expect(pulls.reads).toBeLessThan(40);
        // What is recorded is exactly what is on disk.
        expect(fileKeys(state)).toHaveLength(await landed(dir));
        for (const k of fileKeys(state)) expect(await read(join(dir, k))).toBe(files[`/apps/p${k}`]);
    });
});

describe("the scan's reads overlap, within a byte window [perf 2026-10]", () => {
    const MB = 1024 * 1024;
    /**
     * A vfs whose files claim `declared` sizes in their records (the bytes
     * read back stay small), whose reads take a while, and which records
     * which reads are in flight together, and what their records claim.
     */
    function windowVfs(declared, { delay = 20, onRead } = {}) {
        const paths = Object.keys(declared).sort();
        const live = new Set();
        const seen = { reads: 0, max: 0, maxBytes: 0, overlaps: [] };
        return {
            seen,
            paths,
            vfs: {
                async exists() { return true; },
                async walk() { return paths; },
                async stat(p) { return { path: p, kind: "file", size: declared[p] }; },
                async readFile(p) {
                    seen.reads++;
                    onRead?.(p, seen);
                    live.add(p);
                    const bytes = [...live].reduce((n, q) => n + declared[q], 0);
                    seen.max = Math.max(seen.max, live.size);
                    seen.maxBytes = Math.max(seen.maxBytes, bytes);
                    seen.overlaps.push({ paths: [...live], bytes });
                    try {
                        await sleep(delay);
                        return enc(`content of ${p}`);
                    } finally {
                        live.delete(p);
                    }
                },
            },
        };
    }
    const named = (n, size, prefix = "f") =>
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`/apps/p/${prefix}${String(i).padStart(3, "0")}.txt`, size]));

    it("reads 16 small files at once, and hashes every one of them", async () => {
        expect(SCAN_CONCURRENCY).toBe(16);
        const { vfs, seen, paths } = windowVfs(named(64, 100));
        const out = await scanRemote(vfs, "/apps/p", false, () => false, { paths });
        expect(seen.max).toBe(16);
        expect(seen.reads).toBe(64);
        expect(Object.keys(out.files)).toHaveLength(64);
        for (const p of paths) expect(out.files[p.slice("/apps/p".length)]).toBe(sha(`content of ${p}`));
        expect(out.unknown.size).toBe(0);
    });

    it("keeps the bytes in flight within the window, but for one oversized file read alone", async () => {
        expect(SCAN_WINDOW_BYTES).toBe(64 * MB);
        const declared = { ...named(12, 20 * MB), ...named(2, 90 * MB, "big") };
        const { vfs, seen, paths } = windowVfs(declared);
        const out = await scanRemote(vfs, "/apps/p", false, () => false, { paths });
        expect(seen.reads).toBe(14);
        expect(Object.keys(out.files)).toHaveLength(14);
        expect(seen.max).toBeGreaterThan(1);   // the window still overlaps the ones that fit
        for (const { paths: live, bytes } of seen.overlaps) {
            if (live.some((p) => p.includes("/big"))) expect(live).toHaveLength(1);
            else expect(bytes).toBeLessThanOrEqual(SCAN_WINDOW_BYTES);
        }
    });

    it("starts no read once aborted — including reads waiting on the window — and warns of none", async () => {
        const controller = new AbortController();
        let afterAbort = 0;
        const { vfs, seen, paths } = windowVfs(named(40, 20 * MB), {
            delay: 40,
            onRead: () => {
                if (controller.signal.aborted) afterAbort++;
                else controller.abort();
            },
        });
        const session = { readBudget: null };
        await scanRemote(vfs, "/apps/p", false, () => false, { paths, signal: controller.signal, session });
        expect(afterAbort).toBe(0);
        expect(seen.reads).toBeLessThan(4);
        expect([...session.warned].some((k) => k.startsWith("unreadable:"))).toBe(false);
    });

    it("still holds the pass's read budget, however many reads overlap", async () => {
        // The read budget still counts every read, however many overlap.
        const { vfs, seen, paths } = windowVfs(named(40, 100));
        const out = await scanRemote(vfs, "/apps/p", false, () => false, { paths, session: { readBudget: { bytes: 2 * 1024 * MB, files: 10 } } });
        expect(seen.reads).toBe(10);
        expect(out.deferred.size).toBe(30);
    });

    it("counts a record whose size is not a number as 0, and neither hangs nor poisons the budgets", async () => {
        // The size in a record is whatever the remote party wrote: absent, a
        // string, negative. NaN in a claim made `held` NaN, and nothing fit again.
        const paths = ["/apps/p/a.txt", "/apps/p/b.txt", "/apps/p/c.txt", "/apps/p/d.txt"];
        const sizes = { "/apps/p/a.txt": undefined, "/apps/p/b.txt": "12", "/apps/p/c.txt": -5, "/apps/p/d.txt": 100 };
        let reads = 0;
        const vfs = {
            async exists() { return true; },
            async walk() { return paths; },
            async stat(p) { return { path: p, kind: "file", size: sizes[p] }; },
            async readFile(p) { reads++; return enc(`content of ${p}`); },
        };
        const session = { readBudget: { bytes: 2 * 1024 * MB, files: 10 } };
        const spent = { bytes: 0, files: 0 };
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("scan hung")), 3000));
        const out = await Promise.race([scanRemote(vfs, "/apps/p", false, () => false, { paths, session, spent }), timeout]);
        expect(reads).toBe(4);
        expect(Object.keys(out.files)).toHaveLength(4);
        expect(Number.isFinite(spent.bytes)).toBe(true);
        expect(spent.bytes).toBe(paths.reduce((n, p) => n + `content of ${p}`.length, 0));
    });
});

describe("a restarted mount reads only content it has not hashed before", () => {
    async function synced() {
        const { vfs } = realVfs();
        for (let i = 0; i < 5; i++) await vfs.writeFile(`/docs/f${i}.txt`, enc(`file ${i}`));
        const dir = await tmp("hashcache");
        const state = await reconcile({ vfs, dir, root: "/", state: {} });
        return { vfs, dir, state };
    }

    it("reads no content for an unchanged tree", async () => {
        const { vfs, dir, state } = await synced();
        const { vfs: counted, calls } = counting(vfs);
        await reconcile({ vfs: counted, dir, root: "/", state, session: {} });   // a fresh session: a restart
        expect(calls.readByManifest + calls.readFile).toBe(0);
    });

    it("reads only the file that changed while it was stopped", async () => {
        const { vfs, dir, state } = await synced();
        await vfs.writeFile("/docs/f2.txt", enc("changed elsewhere"));
        const { vfs: counted, calls } = counting(vfs);
        await reconcile({ vfs: counted, dir, root: "/", state, session: {} });
        expect(calls.readByManifest + calls.readFile).toBe(1);
        expect(await read(join(dir, "docs", "f2.txt"))).toBe("changed elsewhere");
    });

    it("ignores a cache file it cannot trust, and reads everything again", async () => {
        const { vfs, dir, state } = await synced();
        for (const junk of ["not json", JSON.stringify({ v: 1, contents: { k: ["nothex", "x"] } }), JSON.stringify({ v: 99 })]) {
            await writeFile(join(dir, ".muhkoo", "content-hashes.json"), junk);
            const { vfs: counted, calls } = counting(vfs);
            await reconcile({ vfs: counted, dir, root: "/", state, session: {} });
            expect(calls.readByManifest + calls.readFile).toBe(5);
            await rm(join(dir, ".muhkoo", "content-hashes.json"), { force: true });
        }
    });
});

describe("folders sync as well as files", () => {
    const isDir = (p) => lstat(p).then((s) => s.isDirectory(), () => false);
    const remoteKind = (vfs, p) => vfs.stat(p).then((s) => s.kind, () => null);

    it("an empty folder made remotely comes down", async () => {
        const { vfs } = realVfs();
        await vfs.writeFile("/docs/a.txt", enc("a"));
        await vfs.mkdir("/docs/empty/deeper", { recursive: true });
        const dir = await tmp("dirs-down");
        const state = await reconcile({ vfs, dir, root: "/", state: {} });
        expect(await isDir(join(dir, "docs", "empty", "deeper"))).toBe(true);
        expect(state["/docs/empty/deeper/"]).toBe("dir");
    });

    it("an empty folder made locally goes up", async () => {
        const { vfs } = realVfs();
        const dir = await tmp("dirs-up");
        await mkdir(join(dir, "made", "here"), { recursive: true });
        await reconcile({ vfs, dir, root: "/", state: {} });
        expect(await remoteKind(vfs, "/made/here")).toBe("dir");
    });

    it("a folder removed locally is removed remotely, with --allow-delete", async () => {
        const { vfs } = realVfs();
        await vfs.writeFile("/keep.txt", enc("k"));
        await vfs.writeFile("/old/a.txt", enc("a"));
        await vfs.mkdir("/old/inner/empty", { recursive: true });
        const dir = await tmp("dirs-rm-up");
        let state = await reconcile({ vfs, dir, root: "/", state: {}, opts: { allowDelete: true } });
        await rm(join(dir, "old"), { recursive: true });
        state = await reconcile({ vfs, dir, root: "/", state, opts: { allowDelete: true } });
        expect(await vfs.exists("/old")).toBe(false);
        expect(await vfs.exists("/keep.txt")).toBe(true);
        expect(Object.keys(state).filter((k) => k.startsWith("/old"))).toEqual([]);
        // and it stays gone
        state = await reconcile({ vfs, dir, root: "/", state, opts: { allowDelete: true } });
        expect(await isDir(join(dir, "old"))).toBe(false);
        expect(await vfs.exists("/old")).toBe(false);
    });

    it("a folder removed remotely is removed locally, with --allow-delete", async () => {
        const { vfs } = realVfs();
        await vfs.writeFile("/keep.txt", enc("k"));   // a root left empty trips the mass-delete breaker
        await vfs.writeFile("/old/a.txt", enc("a"));
        await vfs.mkdir("/old/empty", { recursive: true });
        const dir = await tmp("dirs-rm-down");
        let state = await reconcile({ vfs, dir, root: "/", state: {}, opts: { allowDelete: true } });
        await vfs.delete("/old", { recursive: true });
        state = await reconcile({ vfs, dir, root: "/", state, opts: { allowDelete: true } });
        expect(await isDir(join(dir, "old"))).toBe(false);
        expect(await read(join(dir, "keep.txt"))).toBe("k");
    });

    it("removes no folder when the breaker holds the file deletes", async () => {
        const { vfs } = realVfs();
        await vfs.writeFile("/old/a.txt", enc("a"));
        await vfs.mkdir("/old/empty", { recursive: true });
        const dir = await tmp("dirs-breaker");
        let state = await reconcile({ vfs, dir, root: "/", state: {}, opts: { allowDelete: true } });
        await vfs.delete("/old", { recursive: true });
        state = await reconcile({ vfs, dir, root: "/", state, opts: { allowDelete: true } });
        expect(await isDir(join(dir, "old", "empty"))).toBe(true);
    });

    it("never removes a folder that still holds a file that is not synced", async () => {
        const { vfs } = realVfs();
        await vfs.mkdir("/proj", { recursive: true });
        const dir = await tmp("dirs-keep");
        await put(dir, ".gitignore", "*.log\n");
        let state = await reconcile({ vfs, dir, root: "/", state: {}, opts: { allowDelete: true } });
        await put(dir, "proj/debug.log", "local only");
        await vfs.delete("/proj", { recursive: true });
        state = await reconcile({ vfs, dir, root: "/", state, opts: { allowDelete: true } });
        expect(await read(join(dir, "proj", "debug.log"))).toBe("local only");
    });

    it("without --allow-delete, a removed folder is not removed on the other side", async () => {
        const { vfs } = realVfs();
        await vfs.mkdir("/gone/empty", { recursive: true });
        const dir = await tmp("dirs-noflag");
        let state = await reconcile({ vfs, dir, root: "/", state: {} });
        await rm(join(dir, "gone"), { recursive: true });
        state = await reconcile({ vfs, dir, root: "/", state });
        expect(await remoteKind(vfs, "/gone/empty")).toBe("dir");
    });

    it("a refused folder is not made locally", async () => {
        const { vfs } = realVfs();
        await vfs.mkdir("/proj/.git/hooks", { recursive: true });
        await vfs.mkdir("/proj/.ssh", { recursive: true });
        const dir = await tmp("dirs-refused");
        await reconcile({ vfs, dir, root: "/", state: {}, opts: { hidden: true } });
        expect(await isDir(join(dir, "proj"))).toBe(true);
        expect(await exists(join(dir, "proj", ".git"))).toBe(false);
        expect(await exists(join(dir, "proj", ".ssh"))).toBe(false);
    });

    it("does not make a folder through a symlink", async () => {
        const { vfs } = realVfs();
        await vfs.mkdir("/link/inside", { recursive: true });
        const dir = await tmp("dirs-symlink");
        const outside = await tmp("dirs-outside");
        await symlink(outside, join(dir, "link"));
        await reconcile({ vfs, dir, root: "/", state: {} });
        expect(await readdir(outside)).toEqual([]);
    });

    it("with no folder listing (an older SDK), plans nothing for folders", async () => {
        const vfs = memVfs({ "/a/b.txt": "b" });
        const dir = await tmp("dirs-old-sdk");
        await mkdir(join(dir, "localonly"));
        const state = await reconcile({ vfs, dir, root: "/", state: {} });
        expect(Object.keys(state).filter((k) => k.endsWith("/"))).toEqual([]);
    });
});
