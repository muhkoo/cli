/**
 * `muhkoo vfs` as a command: what the review of the mount rewrite found in the
 * glue between the CLI and src/lib/mount.js.
 *
 * The session is mocked out — these never unlock a vault — and each test gets
 * its own HOME, so nothing reads or writes the real ~/.muhkoo.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, lstat, symlink, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { VfsNamespace } from "@muhkoo/connect";

vi.mock("../src/lib/vfs.js", () => ({
    // What the command asked of the session, for the tests that care: a dry
    // run must not pair this machine or save anything to ~/.muhkoo.
    openClient: async (args) => {
        globalThis.__muhkooOpenedWith = args;
        return globalThis.__muhkooTestClient;
    },
    explainWriteFailure: () => null,
}));
// Every directory created, so a test can say none was attempted outside a
// temp dir: collected while `globalThis.__muhkooMkdirs` is an array.
vi.mock("node:fs/promises", async (importOriginal) => {
    const real = await importOriginal();
    return {
        ...real,
        mkdir: (path, ...rest) => {
            globalThis.__muhkooMkdirs?.push(resolve(String(path)));
            return real.mkdir(path, ...rest);
        },
    };
});
// A terminal's y/N, answered by the test (`globalThis.__muhkooPrompt`).
vi.mock("../src/lib/ui.js", async (importOriginal) => ({
    ...(await importOriginal()),
    prompt: async (question) => globalThis.__muhkooPrompt(question),
}));

const { default: vfsCommand, help: vfsHelp } = await import("../src/commands/vfs.js");
const { importOnce, reconcile, previewMount, mount: mountLib } = await import("../src/lib/mount.js");
const { ruleSystem } = await import("../src/lib/ignore.js");

const enc = (s) => new TextEncoder().encode(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        async write(data, meta) {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
            const id = `m${++n}`;
            blobs.set(id, { bytes: new Uint8Array(bytes), refs: 1 });
            return { manifest: { id, name: meta.name, size: bytes.length, type: meta.type }, size: bytes.length };
        },
        async read(m) { return blobs.get(m.id).bytes; },
        async retain(m) { blobs.get(m.id).refs++; },
        async release(m) { const e = blobs.get(m.id); if (e && --e.refs <= 0) blobs.delete(m.id); },
    };
    const seed = new Uint8Array(32).fill(9);
    const vfs = new VfsNamespace({ store, content, seed: () => seed });
    vfs.watch ??= () => () => {};
    return vfs;
}

async function put(root, rel, text) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text);
}

let home;
let prevHome;
let lines;
const temps = [];
beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "muhkoo-cmd-home-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    lines = [];
    vi.spyOn(console, "log").mockImplementation((...a) => lines.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => lines.push(a.join(" ")));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    terminal(false);
});
/** Pretend stdin and stdout are (or are not) a terminal. */
function terminal(on) {
    for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { value: on, configurable: true });
}
afterEach(async () => {
    vi.restoreAllMocks();
    process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
    while (temps.length) await rm(temps.pop(), { recursive: true, force: true });
});
/** The digest the last `--accept` preview printed. */
const shownDigest = () => lines.join("\n").match(/--accept ([0-9a-f]{16})\b/)?.[1];
async function tmp(label) {
    const d = await mkdtemp(join(tmpdir(), `muhkoo-${label}-`));
    temps.push(d);
    return d;
}

describe("vfs ignore --write [A11]", () => {
    it("carries nested .gitignore files and .git/info/exclude into the .vcsignore", async () => {
        const dir = await tmp("a11");
        execFileSync("git", ["init", "-q"], { cwd: dir });
        await put(dir, ".gitignore", "*.log\n");
        await put(dir, "packages/api/.gitignore", "config/credentials.json\n");
        await put(dir, "packages/api/config/credentials.json", "{\"key\":\"SECRET\"}");
        await put(dir, "packages/api/index.js", "x");
        await put(dir, ".git/info/exclude", "local-notes.md\n");
        await put(dir, "local-notes.md", "private");
        await vfsCommand({ _: ["vfs", "ignore", dir], write: true });
        const vfs = realVfs();
        await importOnce({ client: { vfs }, dir, root: "/apps/p" });
        expect((await vfs.walk("/apps/p")).filter((p) => /credentials|notes/.test(p))).toEqual([]);
        expect(lines.some((l) => l.includes("packages/api/.gitignore"))).toBe(true);
    });

    it("a draft of a planted .gitignore still cannot let a secret out", async () => {
        const dir = await tmp("a11-own");
        await put(dir, ".gitignore", "config/master.key\n");
        await put(dir, "config/master.key", "SECRET");
        await put(dir, "src/a.ts", "a");
        const vfs = realVfs();
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await vfs.writeFile("/apps/p/.gitignore", enc("# tidy-up\n"));
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("# tidy-up\n");
        await vfsCommand({ _: ["vfs", "ignore", dir], write: true });
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await vfs.exists("/apps/p/config/master.key")).toBe(false);
    });
});

describe("vfs import exits non-zero when a directory fails [review]", () => {
    it("refusing $HOME is a failure, not a warning and exit 0", async () => {
        globalThis.__muhkooTestClient = { vfs: realVfs() };
        const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
            throw new Error(`exit ${code}`);
        });
        await expect(vfsCommand({ _: ["vfs", "import", home] })).rejects.toThrow("exit 1");
        expect(exit).toHaveBeenCalledWith(1);
    });
});

describe("vfs mount stops on SIGHUP [A3, A10]", () => {
    it("treats a closed terminal like Ctrl-C: a clean stop, not a kill mid-write", async () => {
        const vfs = realVfs();
        globalThis.__muhkooTestClient = { vfs };
        const dir = await tmp("hup");
        await put(dir, "a.txt", "a");
        const before = {
            SIGINT: new Set(process.listeners("SIGINT")),
            SIGHUP: new Set(process.listeners("SIGHUP")),
        };
        const added = (sig) => process.listeners(sig).filter((l) => !before[sig].has(l));
        const running = vfsCommand({ _: ["vfs", "mount", dir], path: "/apps/p" });
        try {
            for (let i = 0; i < 50 && !added("SIGINT").length; i++) await sleep(20);
            expect(added("SIGHUP")).toHaveLength(1);
            added("SIGHUP")[0]("SIGHUP");
            expect(await Promise.race([running.then(() => "stopped"), sleep(3000).then(() => "running")])).toBe("stopped");
            expect(added("SIGINT")).toEqual([]);   // and it cleans up after itself
        } finally {
            for (const stop of added("SIGINT")) stop("SIGINT");
            await running.catch(() => {});
        }
    });
});

// ---------------------------------------------------------------------------
// Round 3.

describe("vfs ignore --write drafts from the files on disk [L2]", () => {
    it("a machine that got the project by mount drafts its rules, and its local secret stays home", async () => {
        const vfs = realVfs();
        const A = await tmp("l2-a");
        await put(A, ".gitignore", "config/master.key\n*.pem\n");
        await put(A, "src/app.ts", "export {}\n");
        await reconcile({ vfs, dir: A, root: "/apps/proj", state: {} });

        const B = await tmp("l2-b");
        let state = await reconcile({ vfs, dir: B, root: "/apps/proj", state: {} });
        await vfsCommand({ _: ["vfs", "ignore", B], write: true });
        const draft = ruleSystem({ ".vcsignore": await readFile(join(B, ".vcsignore"), "utf8") });
        expect(draft.match("config/master.key")).toBe(true);
        expect(draft.match("server.pem")).toBe(true);

        await put(B, "config/master.key", "SECRET");
        await put(B, "server.pem", "-----BEGIN PRIVATE KEY-----\n");
        for (let i = 0; i < 2; i++) state = await reconcile({ vfs, dir: B, root: "/apps/proj", state });
        expect(await vfs.exists("/apps/proj/config/master.key")).toBe(false);
        expect(await vfs.exists("/apps/proj/server.pem")).toBe(false);
    });

    it("prints the draft with --draft, and writes nothing", async () => {
        const dir = await tmp("l2-draft");
        await put(dir, ".gitignore", "secret.txt\n");
        await vfsCommand({ _: ["vfs", "ignore", dir], draft: true });
        expect(lines.some((l) => /^secret\.txt$/m.test(l))).toBe(true);
        await expect(readFile(join(dir, ".vcsignore"))).rejects.toThrow();
    });
});

describe("vfs ignore lists what is held back, and --accept lets it through [L1]", () => {
    it("names the held files, then accepts and says a running mount picks it up", async () => {
        const vfs = realVfs();
        const dir = await tmp("l1-cmd");
        await put(dir, ".gitignore", "config/master.key\n");
        await put(dir, "config/master.key", "SECRET");
        await put(dir, "src/a.ts", "a");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await writeFile(join(dir, ".gitignore"), "# nothing\n");

        lines.length = 0;
        await vfsCommand({ _: ["vfs", "ignore", dir] });
        expect(lines.some((l) => l.includes("/config/master.key"))).toBe(true);
        expect(lines.some((l) => l.includes(`muhkoo vfs ignore ${dir} --accept`))).toBe(true);
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await vfs.exists("/apps/p/config/master.key")).toBe(false);

        await vfsCommand({ _: ["vfs", "ignore", dir], accept: true });
        const digest = shownDigest();
        lines.length = 0;
        await vfsCommand({ _: ["vfs", "ignore", dir], accept: digest });
        expect(lines.some((l) => l.includes("/config/master.key"))).toBe(true);
        expect(lines.some((l) => /running .*mount/.test(l))).toBe(true);
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await vfs.exists("/apps/p/config/master.key")).toBe(true);
    });
});

describe("vfs ignore --accept previews, and accepts only the rules it showed [F3]", () => {
    const exits = () => vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`exit ${code}`);
    });
    const rulesFile = (dir) => join(dir, ".muhkoo", "ignore-rules.json");

    /**
     * The r3 adversary's n8: gen/ loosened here, so gen/out.js is held; the
     * user looks at what accepting would let through.
     */
    async function loosened(label) {
        const vfs = realVfs();
        const dir = await tmp(label);
        await put(dir, ".gitignore", "config/master.key\ngen/\n");
        await put(dir, "config/master.key", "SECRET");
        await put(dir, "gen/out.js", "generated");
        await put(dir, "src/a.ts", "a");
        let state = await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await writeFile(join(dir, ".gitignore"), "config/master.key\n");
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await vfs.exists("/apps/p/gen/out.js")).toBe(false);
        return { vfs, dir, state };
    }
    /** ...and then the remote plants a negation, which the mount pulls. */
    async function planted({ vfs, dir, state }) {
        await vfs.writeFile("/apps/p/config/.gitignore", enc("!master.key\n"));
        state = await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await readFile(join(dir, "config", ".gitignore"), "utf8")).toBe("!master.key\n");
        return state;
    }

    it("--accept alone lists what it would let through, and the digest and command to accept exactly that; it changes nothing", async () => {
        const { vfs, dir, state } = await loosened("f3-preview");
        const before = await readFile(rulesFile(dir), "utf8");
        lines.length = 0;
        await vfsCommand({ _: ["vfs", "ignore", dir], accept: true });
        expect(lines.some((l) => l.includes("/gen/out.js"))).toBe(true);
        expect(lines.some((l) => l.includes(".gitignore (changed)"))).toBe(true);
        const digest = shownDigest();
        expect(digest).toMatch(/^[0-9a-f]{16}$/);
        expect(lines.some((l) => l.includes(`muhkoo vfs ignore ${dir} --accept ${digest}`))).toBe(true);
        expect(await readFile(rulesFile(dir), "utf8")).toBe(before);
        await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await vfs.exists("/apps/p/gen/out.js")).toBe(false);
    });

    it("--accept <digest> accepts what the preview showed", async () => {
        const { vfs, dir, state } = await loosened("f3-accept");
        await vfsCommand({ _: ["vfs", "ignore", dir], accept: true });
        const digest = shownDigest();
        lines.length = 0;
        await vfsCommand({ _: ["vfs", "ignore", dir], accept: digest });
        expect(lines.some((l) => /Accepted/.test(l))).toBe(true);
        await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await vfs.exists("/apps/p/gen/out.js")).toBe(true);
        expect(await vfs.exists("/apps/p/config/master.key")).toBe(false);
    });

    it("refuses a digest from before an ignore file changed, and accepts nothing", async () => {
        const ctx = await loosened("f3-race");
        await vfsCommand({ _: ["vfs", "ignore", ctx.dir], accept: true });
        const digest = shownDigest();
        const state = await planted(ctx);
        const before = await readFile(rulesFile(ctx.dir), "utf8");
        lines.length = 0;
        exits();
        await expect(vfsCommand({ _: ["vfs", "ignore", ctx.dir], accept: digest })).rejects.toThrow("exit 1");
        expect(lines.some((l) => /changed since/.test(l))).toBe(true);
        expect(await readFile(rulesFile(ctx.dir), "utf8")).toBe(before);
        await reconcile({ vfs: ctx.vfs, dir: ctx.dir, root: "/apps/p", state });
        expect(await ctx.vfs.exists("/apps/p/config/master.key")).toBe(false);
    });

    it("--yes is not a way round the preview", async () => {
        const { dir } = await loosened("f3-yes");
        const before = await readFile(rulesFile(dir), "utf8");
        await vfsCommand({ _: ["vfs", "ignore", dir], accept: true, yes: true });
        expect(await readFile(rulesFile(dir), "utf8")).toBe(before);
    });

    it("on a terminal it asks, and accepts on y the rules it showed", async () => {
        const { vfs, dir, state } = await loosened("f3-tty");
        terminal(true);
        const asked = [];
        globalThis.__muhkooPrompt = async (q) => (asked.push(q), "y");
        await vfsCommand({ _: ["vfs", "ignore", dir], accept: true });
        expect(asked).toHaveLength(1);
        expect(lines.some((l) => /Accepted/.test(l))).toBe(true);
        await reconcile({ vfs, dir, root: "/apps/p", state });
        expect(await vfs.exists("/apps/p/gen/out.js")).toBe(true);
    });

    it("on a terminal, an ignore file that changes while it asks is not accepted", async () => {
        const ctx = await loosened("f3-tty-race");
        terminal(true);
        let state;
        globalThis.__muhkooPrompt = async () => {
            state = await planted(ctx);
            return "y";
        };
        const before = await readFile(rulesFile(ctx.dir), "utf8");
        exits();
        await expect(vfsCommand({ _: ["vfs", "ignore", ctx.dir], accept: true })).rejects.toThrow("exit 1");
        expect(await readFile(rulesFile(ctx.dir), "utf8")).toBe(before);
        await reconcile({ vfs: ctx.vfs, dir: ctx.dir, root: "/apps/p", state });
        expect(await ctx.vfs.exists("/apps/p/config/master.key")).toBe(false);
    });

    it("says there is nothing to accept when nothing older is in force, and writes nothing", async () => {
        const vfs = realVfs();
        const dir = await tmp("acc-noop");
        await put(dir, "src/a.ts", "a");
        await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        const before = await readFile(rulesFile(dir), "utf8");
        lines.length = 0;
        await vfsCommand({ _: ["vfs", "ignore", dir], accept: true });
        expect(lines.some((l) => /Nothing to accept/.test(l))).toBe(true);
        expect(await readFile(rulesFile(dir), "utf8")).toBe(before);
    });

    it("refuses a directory that was never mounted or imported, and writes nothing there", async () => {
        const dir = await tmp("acc-never");
        await put(dir, "a.txt", "a");
        exits();
        await expect(vfsCommand({ _: ["vfs", "ignore", dir], accept: "0123456789abcdef" })).rejects.toThrow("exit 1");
        await expect(readFile(rulesFile(dir))).rejects.toThrow();
        expect(lines.some((l) => /never been mounted|not been mounted/.test(l))).toBe(true);
    });

    it("takes the directory from after the flag: `vfs ignore --accept <dir>`, and `--accept <digest> <dir>`", async () => {
        const vfs = realVfs();
        const dir = await tmp("acc-order");
        await put(dir, ".gitignore", "notes.txt\n");
        await put(dir, "notes.txt", "mine");
        await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await writeFile(join(dir, ".gitignore"), "# nothing\n");
        const cwd = await tmp("acc-cwd");
        const was = process.cwd();
        process.chdir(cwd);
        try {
            await vfsCommand({ _: ["vfs", "ignore"], accept: dir });
            await vfsCommand({ _: ["vfs", "ignore", dir], accept: shownDigest() });
        } finally {
            process.chdir(was);
        }
        await expect(readFile(rulesFile(cwd))).rejects.toThrow();
        const saved = JSON.parse(await readFile(rulesFile(dir), "utf8"));
        expect(saved.snapshots).toHaveLength(1);
    });
});

describe("vfs ignore tells the truth when only files from elsewhere are held [review]", () => {
    it("a fresh machine whose project re-includes dist/: says older rules are in force, and which file changed", async () => {
        // The reviewer's s2: the mount named dist/index.html as held, and
        // `vfs ignore` said nothing was — the files as they stand decide.
        const vfs = realVfs();
        const A = await tmp("s2-a");
        await put(A, ".gitignore", "!dist/\n");
        await put(A, "dist/index.html", "<html>");
        await put(A, "src/app.js", "app");
        await reconcile({ vfs, dir: A, root: "/site", state: {} });
        const B = await tmp("s2-b");
        await reconcile({ vfs, dir: B, root: "/site", state: {} });
        lines.length = 0;
        await vfsCommand({ _: ["vfs", "ignore", B] });
        expect(lines.some((l) => /decide what syncs/.test(l))).toBe(false);
        expect(lines.some((l) => /still apply/.test(l))).toBe(true);
        expect(lines.some((l) => l.includes(".gitignore (new)"))).toBe(true);
        expect(lines.some((l) => /arriving from your filesystem/.test(l))).toBe(true);
        expect(lines.some((l) => /dropped/.test(l))).toBe(false);   // nothing was [F6]
    });

    it("a directory never mounted has no stored rules, and says so [F6]", async () => {
        const dir = await tmp("never");
        await put(dir, "a.txt", "a");
        await vfsCommand({ _: ["vfs", "ignore", dir] });
        expect(lines.some((l) => /no stored ignore rules/.test(l))).toBe(true);
        expect(lines.some((l) => /last accepted/.test(l))).toBe(false);
    });
});

describe("vfs ignore lists held files in dot-directories, whatever the flags [review]", () => {
    it("a --hidden mount's held .deploy/secret.txt is listed before it is released", async () => {
        const vfs = realVfs();
        const dir = await tmp("acc-hidden");
        await put(dir, ".gitignore", "secret.txt\n");
        await put(dir, "secret.txt", "s1");
        await put(dir, ".deploy/secret.txt", "s2");
        await reconcile({ vfs, dir, root: "/apps/p", state: {}, opts: { hidden: true } });
        await writeFile(join(dir, ".gitignore"), "# nothing\n");
        lines.length = 0;
        await vfsCommand({ _: ["vfs", "ignore", dir] });
        expect(lines.some((l) => l.includes("/.deploy/secret.txt"))).toBe(true);
        expect(lines.some((l) => l.includes("/secret.txt"))).toBe(true);
    });
});

/** The heavy line of GitHub's Node.gitignore, among ordinary ones. */
const NODE_ISH = "logs\n*.log\nnpm-debug.log*\nreport.[0-9]*.[0-9]*.[0-9]*.[0-9]*.json\npids\n*.pid\ncoverage\n" +
    "node_modules/\n.env\n.env.*\n!.env.example\n**/.vitepress/dist\n**/.vitepress/cache\nvite.config.js.timestamp-*\ndist\n";

describe("vfs ignore --write never writes a file the mount refuses [review 2]", () => {
    it("a project whose web/ app keeps its own Node .gitignore: the drafted .vcsignore syncs", async () => {
        const vfs = realVfs();
        const dir = await tmp("r2-draft");
        await put(dir, ".gitignore", NODE_ISH);
        await put(dir, "web/.gitignore", NODE_ISH);
        await put(dir, "web/src/main.ts", "x");
        await put(dir, "server/index.js", "y");
        let state = await reconcile({ vfs, dir, root: "/p", state: {} });
        await vfsCommand({ _: ["vfs", "ignore", dir], write: true });
        await put(dir, "server/new.js", "z");
        await put(dir, "web/deep/debug.log", "log");
        await put(dir, "web/report.1.2.3.4.json", "{}");
        state = await reconcile({ vfs, dir, root: "/p", state });
        expect(await vfs.exists("/p/server/new.js")).toBe(true);
        expect(await vfs.exists("/p/web/deep/debug.log")).toBe(false);
        expect(await vfs.exists("/p/web/report.1.2.3.4.json")).toBe(false);
    });

    it("a draft past an ignore file's limits is not written, and --draft says why", async () => {
        const dir = await tmp("r2-draft-big");
        await put(dir, ".gitignore", Array.from({ length: 6000 }, (_, i) => `root-rule-${i}`).join("\n") + "\n");
        await put(dir, "pkg/.gitignore", Array.from({ length: 6000 }, (_, i) => `pkg-rule-${i}`).join("\n") + "\n");
        const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
            throw new Error(`exit ${code}`);
        });
        await expect(vfsCommand({ _: ["vfs", "ignore", dir], write: true })).rejects.toThrow("exit 1");
        expect(exit).toHaveBeenCalledWith(1);
        await expect(readFile(join(dir, ".vcsignore"))).rejects.toThrow();
        expect(lines.some((l) => /rules/.test(l) && /at most/.test(l))).toBe(true);
        exit.mockRestore();
        lines.length = 0;
        await vfsCommand({ _: ["vfs", "ignore", dir], draft: true });
        expect(lines.some((l) => /would not be read/.test(l))).toBe(true);
    });
});

describe("vfs ignore reads dot-directories the way the mount does [review 2]", () => {
    // pytest, ruff, mypy and uv write a `*` .gitignore into their caches. A
    // mount without --hidden never goes in there; `vfs ignore` did, and said
    // for good that older rules were in force.
    async function pythonProject(label) {
        const dir = await tmp(label);
        await put(dir, ".gitignore", "node_modules/\n");
        await put(dir, "src/a.py", "a");
        await put(dir, ".pytest_cache/.gitignore", "*\n");
        await put(dir, ".pytest_cache/v/cache/lastfailed", "{}");
        return dir;
    }
    const clean = () => lines.some((l) => /Nothing in .* is held back/.test(l));

    it("without --hidden: nothing is in force after a pass, nor after an accept and another pass", async () => {
        const vfs = realVfs();
        const dir = await pythonProject("r2-dot");
        let state = await reconcile({ vfs, dir, root: "/p", state: {} });
        lines.length = 0;
        await vfsCommand({ _: ["vfs", "ignore", dir] });
        expect(clean()).toBe(true);
        await vfsCommand({ _: ["vfs", "ignore", dir], accept: true });   // nothing to accept
        state = await reconcile({ vfs, dir, root: "/p", state });
        lines.length = 0;
        await vfsCommand({ _: ["vfs", "ignore", dir] });
        expect(clean()).toBe(true);
    });

    it("with --hidden, where the mount does read it", async () => {
        const vfs = realVfs();
        const dir = await pythonProject("r2-dot-hidden");
        await reconcile({ vfs, dir, root: "/p", state: {}, opts: { hidden: true } });
        lines.length = 0;
        await vfsCommand({ _: ["vfs", "ignore", dir] });
        expect(clean()).toBe(true);
        expect(await vfs.exists("/p/.pytest_cache/v/cache/lastfailed")).toBe(false);
    });
});

describe("a flag given before a directory does not swallow it [review]", () => {
    it("import: `--dry-run <dir>` dry-runs that directory too, rather than skipping it", async () => {
        const vfs = realVfs();
        globalThis.__muhkooTestClient = { vfs };
        const A = await tmp("flag-a");
        const B = await tmp("flag-b");
        await put(A, "a.txt", "a");
        await put(B, "b.txt", "b");
        await vfsCommand({ _: ["vfs", "import", A], "dry-run": B });
        expect(await vfs.exists("/apps")).toBe(false);
        expect(lines.filter((l) => /change\(s\); 1 file\(s\) to upload/.test(l))).toHaveLength(2);
    });

    it("import: `--hidden <dir>` imports it, with dot-files", async () => {
        const vfs = realVfs();
        globalThis.__muhkooTestClient = { vfs };
        const dir = await tmp("flag-hidden");
        await put(dir, ".prettierrc", "{}");
        await vfsCommand({ _: ["vfs", "import"], hidden: dir, path: "/apps/p" });
        expect(await vfs.exists("/apps/p/.prettierrc")).toBe(true);
    });

    it("mount: `--allow-delete <dir>` mounts it", async () => {
        const vfs = realVfs();
        globalThis.__muhkooTestClient = { vfs };
        const dir = await tmp("flag-mount");
        await put(dir, "a.txt", "a");
        const before = new Set(process.listeners("SIGINT"));
        const running = vfsCommand({ _: ["vfs", "mount"], "allow-delete": dir, path: "/apps/p" });
        try {
            for (let i = 0; i < 100 && !(await vfs.exists("/apps/p/a.txt")); i++) await sleep(20);
            expect(await vfs.exists("/apps/p/a.txt")).toBe(true);
        } finally {
            for (const stop of process.listeners("SIGINT").filter((l) => !before.has(l))) stop("SIGINT");
            await running.catch(() => {});
        }
    });
});

describe("vfs ignore on a directory that is not there", () => {
    it("says so, and creates nothing", async () => {
        const missing = join(home, "no-such-project");
        const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
            throw new Error(`exit ${code}`);
        });
        await expect(vfsCommand({ _: ["vfs", "ignore", missing], accept: true })).rejects.toThrow("exit 1");
        expect(exit).toHaveBeenCalledWith(1);
        await expect(readFile(join(missing, ".muhkoo", "ignore-rules.json"))).rejects.toThrow();
        expect(lines.some((l) => l.includes(missing) && /not a directory|does not exist/.test(l))).toBe(true);
    });
});

describe("vfs mount --dry-run previews the first pass and changes nothing", () => {
    // `--dry-run` used to be read by import alone: `vfs mount <dir> --dry-run`
    // dropped the flag and mounted for real — pulling, pushing and, with
    // --allow-delete, deleting — which is the opposite of what was asked.

    /** Run the command; if it is still going after `ms`, stop it and say so. */
    async function bounded(args, ms = 2000) {
        const before = new Set(process.listeners("SIGINT"));
        const running = vfsCommand(args);
        const outcome = await Promise.race([running.then(() => "returned"), sleep(ms).then(() => "still running")]);
        if (outcome !== "returned") {
            for (const stop of process.listeners("SIGINT").filter((l) => !before.has(l))) stop("SIGINT");
            await running.catch(() => {});
        }
        return outcome;
    }
    const listing = async (d) => (await readdir(d, { recursive: true })).sort();

    async function seeded() {
        const vfs = realVfs();
        globalThis.__muhkooTestClient = { vfs };
        await vfs.writeFile("/apps/p/remote.txt", "from elsewhere");
        const dir = await tmp("mount-dry");
        await put(dir, "local.txt", "mine");
        return { vfs, dir };
    }

    it("lists what would come down and go up, then returns without syncing or watching", async () => {
        const { vfs, dir } = await seeded();
        const before = await listing(dir);
        expect(await bounded({ _: ["vfs", "mount", dir], path: "/apps/p", "dry-run": true })).toBe("returned");
        const out = lines.join("\n");
        expect(out).toMatch(/↓ \/remote\.txt/);
        expect(out).toMatch(/↑ \/local\.txt/);
        expect(out).toMatch(/Nothing was changed/);
        expect(await listing(dir)).toEqual(before);   // nothing pulled, and no .muhkoo left behind
        expect(await vfs.exists("/apps/p/local.txt")).toBe(false);
    });

    it("previews the same way with the flag before the directory", async () => {
        const { dir } = await seeded();
        expect(await bounded({ _: ["vfs", "mount"], "dry-run": dir, path: "/apps/p" })).toBe("returned");
        expect(lines.join("\n")).toMatch(/↓ \/remote\.txt/);
    });

    it("does not create a directory that is not there yet", async () => {
        const { vfs } = await seeded();
        const dir = join(await tmp("mount-dry-parent"), "fresh");
        expect(await bounded({ _: ["vfs", "mount", dir], path: "/apps/p", "dry-run": true })).toBe("returned");
        expect(lines.join("\n")).toMatch(/↓ \/remote\.txt/);
        await expect(stat(dir)).rejects.toThrow();
        expect(await vfs.exists("/apps/p/remote.txt")).toBe(true);
    });

    it("marks a delete that needs --allow-delete, and deletes nothing", async () => {
        const { vfs, dir } = await seeded();
        await reconcile({ vfs, dir, root: "/apps/p", state: {} });   // both files synced and recorded
        await vfs.delete("/apps/p/remote.txt");                     // then removed elsewhere
        lines.length = 0;
        expect(await bounded({ _: ["vfs", "mount", dir], path: "/apps/p", "dry-run": true })).toBe("returned");
        expect(lines.join("\n")).toMatch(/✕↓ \/remote\.txt.*--allow-delete/);
        expect(await readFile(join(dir, "remote.txt"), "utf8")).toBe("from elsewhere");
    });
});

describe("a dry run writes nothing, not even for a moment [review 3]", () => {
    // Every surface says a dry run writes nothing. It wrote a probe file into
    // the directory's .muhkoo/ — creating .muhkoo/ for it when there was none
    // — to ask whether the volume folds case, and then removed it. No name was
    // left behind, so a listing could not see it; the directory's times could.

    /**
     * Each entry's mtime and ctime under `root`, `root` itself included and
     * symlinks not followed. A file written and removed again moves its
     * directory's times even though no name is left.
     */
    async function times(root) {
        const out = {};
        const visit = async (abs, rel) => {
            const s = await lstat(abs, { bigint: true });
            out[rel || "."] = `${s.mtimeNs}:${s.ctimeNs}`;
            if (s.isDirectory()) {
                for (const name of (await readdir(abs)).sort()) await visit(join(abs, name), rel ? `${rel}/${name}` : name);
            }
        };
        await visit(root, "");
        return out;
    }

    async function seeded(label) {
        const vfs = realVfs();
        globalThis.__muhkooTestClient = { vfs };
        await vfs.writeFile("/apps/p/remote.txt", enc("from elsewhere"));
        const dir = await tmp(label);
        await put(dir, "local.txt", "mine");
        return { vfs, dir };
    }

    it("mount: a directory never mounted is not touched", async () => {
        const { dir } = await seeded("dry-times-fresh");
        const before = await times(dir);
        await sleep(20);
        await vfsCommand({ _: ["vfs", "mount", dir], path: "/apps/p", "dry-run": true });
        expect(lines.join("\n")).toMatch(/↓ \/remote\.txt/);
        expect(await times(dir)).toEqual(before);
    });

    it("mount: neither is a directory mounted before, its .muhkoo/ or ~/.muhkoo", async () => {
        const { vfs, dir } = await seeded("dry-times-mounted");
        await put(dir, ".gitignore", "secret.txt\n");
        await put(dir, "secret.txt", "s");
        await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await put(dir, ".gitignore", "other.txt\n");   // a loosening the ratchet would record
        await put(dir, "new.txt", "n");
        await vfs.writeFile("/apps/p/remote2.txt", enc("r2"));
        const before = { dir: await times(dir), home: await times(home) };
        await sleep(20);
        lines.length = 0;
        await vfsCommand({ _: ["vfs", "mount", dir], path: "/apps/p", "dry-run": true, "allow-delete": true, hidden: true });
        expect(lines.join("\n")).toMatch(/↓ \/remote2\.txt/);
        expect({ dir: await times(dir), home: await times(home) }).toEqual(before);
    });

    it("import: neither is a directory imported before, or its .muhkoo/", async () => {
        const { vfs, dir } = await seeded("dry-times-import");
        await importOnce({ client: { vfs }, dir, root: "/apps/p" });
        await put(dir, "new.txt", "n");
        const before = { dir: await times(dir), home: await times(home) };
        await sleep(20);
        lines.length = 0;
        await vfsCommand({ _: ["vfs", "import", dir], path: "/apps/p", "dry-run": true });
        expect(lines.join("\n")).toMatch(/↑ \/new\.txt/);
        expect({ dir: await times(dir), home: await times(home) }).toEqual(before);
    });

    it("nor, through a .muhkoo that is a symlink, the directory it points at", async () => {
        const { dir } = await seeded("dry-times-link");
        const elsewhere = await tmp("dry-times-elsewhere");
        await symlink(elsewhere, join(dir, ".muhkoo"));
        const before = await times(elsewhere);
        await sleep(20);
        await vfsCommand({ _: ["vfs", "mount", dir], path: "/apps/p", "dry-run": true });
        await vfsCommand({ _: ["vfs", "import", dir], path: "/apps/p", "dry-run": true });
        expect(await times(elsewhere)).toEqual(before);
    });
});

describe("a dry run pairs nothing and saves nothing to ~/.muhkoo [review 3]", () => {
    // Unlocking pairs a machine that is not paired yet — a device factor
    // enrolled on the server, and its key saved in ~/.muhkoo/config.json —
    // and resets a stale working directory there. A dry run asks the session
    // not to.
    const cases = [
        ["vfs mount <dir> --dry-run", (dir) => ({ _: ["vfs", "mount", dir], path: "/apps/p", "dry-run": true })],
        ["vfs mount --dry-run <dir>", (dir) => ({ _: ["vfs", "mount"], path: "/apps/p", "dry-run": dir })],
        ["vfs import <dir> --dry-run", (dir) => ({ _: ["vfs", "import", dir], path: "/apps/p", "dry-run": true })],
        ["vfs import --dry-run <dir>", (dir) => ({ _: ["vfs", "import"], path: "/apps/p", "dry-run": dir })],
    ];
    for (const [label, args] of cases) {
        it(`${label} opens the session without pairing, read-only`, async () => {
            globalThis.__muhkooTestClient = { vfs: realVfs() };
            globalThis.__muhkooOpenedWith = undefined;
            const dir = await tmp("dry-pair");
            await vfsCommand(args(dir));
            expect(globalThis.__muhkooOpenedWith).toMatchObject({ pair: false, readOnly: true });
        });
    }

    it("a real import may still pair", async () => {
        globalThis.__muhkooTestClient = { vfs: realVfs() };
        const dir = await tmp("real-pair");
        await vfsCommand({ _: ["vfs", "import", dir], path: "/apps/p" });
        expect(globalThis.__muhkooOpenedWith.pair).not.toBe(false);
        expect(globalThis.__muhkooOpenedWith.readOnly).not.toBe(true);
    });
});

describe("mount --dry-run on a path the mount could not use [review 3]", () => {
    // Any stat failure read as "missing", so a path under a file, a dangling
    // symlink, or one in a directory that cannot be written got a confident
    // plan ending "Nothing was changed." — and the mount then failed at mkdir.
    async function seededVfs() {
        const vfs = realVfs();
        await vfs.writeFile("/apps/p/remote.txt", enc("from elsewhere"));
        return vfs;
    }
    const planned = () => lines.some((l) => /Nothing was changed|↓ \/remote\.txt/.test(l));

    it("refuses a path under a file", async () => {
        const vfs = await seededVfs();
        const parent = await tmp("dry-under-file");
        await put(parent, "afile", "x");
        await expect(previewMount({ client: { vfs }, dir: join(parent, "afile", "sub"), root: "/apps/p" })).rejects.toThrow(/not a directory|ENOTDIR/);
        expect(planned()).toBe(false);
    });

    it("refuses a dangling symlink, saying what it is", async () => {
        const vfs = await seededVfs();
        const parent = await tmp("dry-dangling");
        await symlink(join(parent, "nowhere"), join(parent, "dangling"));
        await expect(previewMount({ client: { vfs }, dir: join(parent, "dangling"), root: "/apps/p" })).rejects.toThrow(/symbolic link/);
        expect(planned()).toBe(false);
    });

    const root = process.getuid?.() === 0;
    it.skipIf(root)("refuses a directory that cannot be created, because its parent cannot be written", async () => {
        const vfs = await seededVfs();
        const parent = await tmp("dry-readonly");
        await mkdir(join(parent, "locked"));
        await chmod(join(parent, "locked"), 0o555);
        try {
            await expect(previewMount({ client: { vfs }, dir: join(parent, "locked", "proj"), root: "/apps/p" })).rejects.toThrow(/cannot be created|EACCES|permission/);
            expect(planned()).toBe(false);
        } finally {
            await chmod(join(parent, "locked"), 0o755);
        }
    });

    it.skipIf(root)("refuses a path whose parent cannot be searched", async () => {
        const vfs = await seededVfs();
        const parent = await tmp("dry-unsearchable");
        await mkdir(join(parent, "locked"));
        await chmod(join(parent, "locked"), 0o000);
        try {
            await expect(previewMount({ client: { vfs }, dir: join(parent, "locked", "proj"), root: "/apps/p" })).rejects.toThrow(/EACCES|permission/);
            expect(planned()).toBe(false);
        } finally {
            await chmod(join(parent, "locked"), 0o755);
        }
    });

    it("refuses a directory several levels down, naming the missing parent, as the mount now does", async () => {
        // The mount creates the folder named, never the ones above it.
        const vfs = await seededVfs();
        const base = await tmp("dry-deep");
        const dir = join(base, "a", "b", "proj");
        await expect(previewMount({ client: { vfs }, dir, root: "/apps/p" })).rejects.toThrow(`${join(base, "a", "b")} does not exist`);
        expect(planned()).toBe(false);
        await expect(stat(join(base, "a"))).rejects.toThrow();
    });
});

describe("mount --dry-run of a directory that is gone reads the rules recorded for it [review 3]", () => {
    // A missing directory is planned against an empty stand-in, and the copy
    // of the ignore rules under ~/.muhkoo was looked up under the stand-in's
    // path. A real mount creates the directory and finds that copy, so rules it
    // recorded there still hold files back — and the preview listed them as
    // coming down.
    it("holds back what the real mount holds back", async () => {
        const vfs = realVfs();
        const dir = join(await tmp("dry-gone"), "proj");
        await put(dir, ".gitignore", "secret.txt\n");
        await put(dir, "a.txt", "a");
        await reconcile({ vfs, dir, root: "/apps/p", state: {} });   // records the rules, and the copy under ~/.muhkoo
        await vfs.delete("/apps/p/.gitignore");
        await vfs.writeFile("/apps/p/secret.txt", enc("not for this disk"));
        await rm(dir, { recursive: true, force: true });

        lines.length = 0;
        await previewMount({ client: { vfs }, dir, root: "/apps/p" });
        const preview = lines.join("\n");
        expect(preview).toMatch(/↓ \/a\.txt/);
        expect(preview).not.toMatch(/↓ \/secret\.txt/);
        expect(preview).toMatch(/held back.*secret\.txt/);
        await expect(stat(dir)).rejects.toThrow();

        // …which is what a real first pass there does.
        await mkdir(dir);
        await reconcile({ vfs, dir, root: "/apps/p", state: {} });
        await expect(stat(join(dir, "secret.txt"))).rejects.toThrow();
        expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("a");
    });
});

describe("what mount --dry-run claims to show [review 3]", () => {
    it("says what mounting would do, not what one pass would", async () => {
        const vfs = realVfs();
        await vfs.writeFile("/apps/p/remote.txt", enc("r"));
        const dir = await tmp("dry-header");
        await previewMount({ client: { vfs }, dir, root: "/apps/p" });
        const out = lines.join("\n");
        expect(out).toMatch(/would:$/m);
        expect(out).not.toMatch(/first pass/);
    });
});

describe("--no-pair before a directory does not swallow it [review 3]", () => {
    it("import: `--no-pair <dir>` imports that directory", async () => {
        const vfs = realVfs();
        globalThis.__muhkooTestClient = { vfs };
        const dir = await tmp("nopair-import");
        await put(dir, "a.txt", "a");
        await vfsCommand({ _: ["vfs", "import"], "no-pair": dir, path: "/apps/p" });
        expect(await vfs.exists("/apps/p/a.txt")).toBe(true);
    });

    it("mount --dry-run: `--no-pair <dir>` previews that directory", async () => {
        const vfs = realVfs();
        globalThis.__muhkooTestClient = { vfs };
        const dir = await tmp("nopair-mount");
        await put(dir, "a.txt", "a");
        await vfsCommand({ _: ["vfs", "mount"], "dry-run": true, "no-pair": dir, path: "/apps/p" });
        expect(lines.join("\n")).toMatch(/↑ \/a\.txt/);
    });
});

// ---------------------------------------------------------------------------
// `muhkoo vfs mount /apps/quick-lighthouse --path ./`: the folder and the
// Muhkoo path, swapped. `./` became the Muhkoo root "/.", and the mount ran
// `mkdir -p /apps/quick-lighthouse` at the top of this disk.

describe("vfs mount and import take --path as a Muhkoo path [swapped arguments]", () => {
    const outsideTmp = (p) => !p.startsWith(resolve(tmpdir()) + sep);
    const PATH_ERROR = "--path is the Muhkoo path to mount, starting with / (for example --path /apps/my-app).";

    /**
     * Run a command that should be refused. Bounded: one that mounts instead
     * is stopped, and reported as still running.
     */
    async function attempt(args, ms = 2000) {
        globalThis.__muhkooOpenedWith = undefined;
        globalThis.__muhkooMkdirs = [];
        vi.spyOn(process, "exit").mockImplementation((code) => {
            throw new Error(`exit ${code}`);
        });
        const before = new Set(process.listeners("SIGINT"));
        try {
            const running = vfsCommand(args).then(() => "returned", (err) => err?.message ?? String(err));
            const outcome = await Promise.race([running, sleep(ms).then(() => "still running")]);
            if (outcome === "still running") {
                for (const stop of process.listeners("SIGINT").filter((l) => !before.has(l))) stop("SIGINT");
                await running;
            }
            return { outcome, out: lines.join("\n"), mkdirs: globalThis.__muhkooMkdirs };
        } finally {
            globalThis.__muhkooMkdirs = undefined;
        }
    }

    it("Matt's command line: refuses ./ as --path, suggests the swap, and creates nothing", async () => {
        globalThis.__muhkooTestClient = { vfs: realVfs() };
        const { outcome, out, mkdirs } = await attempt({ _: ["vfs", "mount", "/apps/quick-lighthouse"], path: "./" });
        expect(mkdirs.filter(outsideTmp)).toEqual([]);
        expect(outcome).toBe("exit 1");
        expect(out).toContain(`${PATH_ERROR} "./" looks like a folder on this computer.`);
        expect(out).toContain("  Did you mean: muhkoo vfs mount ./ --path /apps/quick-lighthouse\n");
        expect(mkdirs).toEqual([]);
        // Refused before the session opens: a typo costs no password prompt.
        expect(globalThis.__muhkooOpenedWith).toBeUndefined();
    });

    const REFUSED = ["./", ".", "..", "../x", "/apps/./x", "/a/../b", "apps/.", "~", "~/proj", ""];
    for (const value of REFUSED) {
        it(`mount refuses --path ${JSON.stringify(value)}, and writes nothing`, async () => {
            const vfs = realVfs();
            globalThis.__muhkooTestClient = { vfs };
            const dir = await tmp("refuse-mount");
            const { outcome, out, mkdirs } = await attempt({ _: ["vfs", "mount", dir], path: value });
            expect(outcome).toBe("exit 1");
            expect(out).toContain(PATH_ERROR);
            expect(out).not.toMatch(/Did you mean/);   // the folder is there: nothing looks swapped
            expect(mkdirs).toEqual([]);
            expect(await readdir(dir)).toEqual([]);
            expect(await vfs.walk("/")).toEqual([]);
        });

        it(`import refuses --path ${JSON.stringify(value)}, and uploads nothing`, async () => {
            const vfs = realVfs();
            globalThis.__muhkooTestClient = { vfs };
            const dir = await tmp("refuse-import");
            await put(dir, "a.txt", "a");
            const { outcome, out } = await attempt({ _: ["vfs", "import", dir], path: value });
            expect(outcome).toBe("exit 1");
            expect(out).toContain("--path is the Muhkoo path to import into, starting with / (for example --path /apps/my-app).");
            expect(await vfs.walk("/")).toEqual([]);
            expect(await readdir(dir)).toEqual(["a.txt"]);   // no .muhkoo/ state either
        });
    }

    it("refuses --path given no value, for mount and for import", async () => {
        globalThis.__muhkooTestClient = { vfs: realVfs() };
        const dir = await tmp("refuse-bare");
        const mounted = await attempt({ _: ["vfs", "mount", dir], path: true });
        expect(mounted.outcome).toBe("exit 1");
        expect(mounted.out).toContain(`${PATH_ERROR} It was given no value.`);
        lines.length = 0;
        const imported = await attempt({ _: ["vfs", "import", dir, await tmp("refuse-bare-2")], path: "" });
        expect(imported.outcome).toBe("exit 1");
        expect(imported.out).toContain("--path is the Muhkoo path to import into");
    });

    it("vfs push, import's other name, refuses the same, before the session opens", async () => {
        const vfs = realVfs();
        globalThis.__muhkooTestClient = { vfs };
        const dir = await tmp("refuse-push");
        await put(dir, "a.txt", "a");
        const { outcome, out } = await attempt({ _: ["vfs", "push", dir], path: "./" });
        expect(outcome).toBe("exit 1");
        expect(out).toContain(
            '--path is the Muhkoo path to import into, starting with / (for example --path /apps/my-app). "./" looks like a folder on this computer.',
        );
        expect(globalThis.__muhkooOpenedWith).toBeUndefined();
        expect(await vfs.walk("/")).toEqual([]);
    });

    it("still takes a Muhkoo path without its leading slash, and names that only look like dot segments", async () => {
        const vfs = realVfs();
        globalThis.__muhkooTestClient = { vfs };
        const dir = await tmp("lenient");
        await put(dir, "a.txt", "a");
        await vfsCommand({ _: ["vfs", "import", dir], path: "apps/p" });
        expect(await vfs.exists("/apps/p/a.txt")).toBe(true);
        await vfsCommand({ _: ["vfs", "import", dir], path: "/apps/v1.2/..x/.y" });
        expect(await vfs.exists("/apps/v1.2/..x/.y/a.txt")).toBe(true);
    });

    it("mount, too, takes a Muhkoo path without its leading slash", async () => {
        const vfs = realVfs();
        globalThis.__muhkooTestClient = { vfs };
        await vfs.writeFile("/apps/p/remote.txt", enc("from elsewhere"));
        const dir = await tmp("lenient-mount");
        await vfsCommand({ _: ["vfs", "mount", dir], path: "apps/p", "dry-run": true });
        expect(lines.join("\n")).toMatch(/↓ \/remote\.txt/);   // only /apps/p has it
    });

    it("mount /apps/quick-lighthouse without --path names the missing /apps, and suggests the swap", async () => {
        globalThis.__muhkooTestClient = { vfs: realVfs() };
        const { outcome, out, mkdirs } = await attempt({ _: ["vfs", "mount", "/apps/quick-lighthouse"] });
        expect(mkdirs).toEqual([]);
        expect(outcome).toBe("exit 1");
        expect(out).toContain("/apps/quick-lighthouse cannot be created: /apps does not exist on this computer.");
        expect(out).toContain("Did you mean: muhkoo vfs mount <folder> --path /apps/quick-lighthouse\n");
        expect(globalThis.__muhkooOpenedWith).toBeUndefined();
    });

    it("suggests no swap for a folder that starts at one this computer has: a typo here, not a Muhkoo path", async () => {
        // /Users/me/GitHub/tpyo/app is a mistyped folder on this disk, and
        // /Users is not where a Muhkoo path starts.
        globalThis.__muhkooTestClient = { vfs: realVfs() };
        const base = await tmp("typo");
        await put(base, "file.txt", "x");
        const cases = [
            [{ _: ["vfs", "mount", join(base, "tpyo", "app")] }, `${join(base, "tpyo")} does not exist on this computer.`],
            [{ _: ["vfs", "mount", join(base, "file.txt", "app")] }, "not a directory"],
            [{ _: ["vfs", "mount", join(base, "new-proj")], path: "./" }, `${PATH_ERROR} "./" looks like a folder on this computer.`],
        ];
        for (const [args, said] of cases) {
            lines.length = 0;
            const { outcome, out, mkdirs } = await attempt(args);
            expect(outcome).toBe("exit 1");
            expect(out).toContain(said);
            expect(out).not.toMatch(/Did you mean/);
            expect(mkdirs).toEqual([]);
        }
        expect(await readdir(base)).toEqual(["file.txt"]);
    });

    it("an empty --path, refused, suggests <folder> rather than a folder", async () => {
        globalThis.__muhkooTestClient = { vfs: realVfs() };
        const { out } = await attempt({ _: ["vfs", "mount", "/apps/quick-lighthouse"], path: "" });
        expect(out).toContain("Did you mean: muhkoo vfs mount <folder> --path /apps/quick-lighthouse\n");
    });

    it("the suggestion keeps the other options, so a dry run stays one, quotes what needs it, and never prints a key", async () => {
        globalThis.__muhkooTestClient = { vfs: realVfs() };
        const { out } = await attempt({
            _: ["vfs", "mount"], "dry-run": "/apps/quick-lighthouse", path: "./my project", app: "demo", key: "mk_live_pk_secret",
        });
        expect(out).toContain(
            "Did you mean: muhkoo vfs mount './my project' --path /apps/quick-lighthouse --dry-run --app demo --key <key>\n",
        );
        expect(out).not.toContain("mk_live_pk_secret");
    });

    it("with an accepted --path, a missing parent is named, nothing is suggested, and nothing is created", async () => {
        globalThis.__muhkooTestClient = { vfs: realVfs() };
        const base = await tmp("no-parent");
        const dir = join(base, "missing", "proj");
        for (const extra of [{}, { "dry-run": true }]) {
            lines.length = 0;
            const { outcome, out, mkdirs } = await attempt({ _: ["vfs", "mount", dir], path: "/apps/p", ...extra });
            expect(mkdirs).toEqual([]);
            expect(outcome).toBe("exit 1");
            expect(out).toContain(`${dir} cannot be created: ${join(base, "missing")} does not exist on this computer.`);
            expect(out).not.toMatch(/Did you mean/);
            await expect(stat(join(base, "missing"))).rejects.toThrow();
        }
    });

    it("mount() itself creates the folder named, never the ones above it", async () => {
        const base = await tmp("lib-no-parent");
        const dir = join(base, "a", "b");
        globalThis.__muhkooMkdirs = [];
        try {
            await expect(mountLib({ client: { vfs: realVfs() }, dir, root: "/apps/p", signal: new AbortController().signal }))
                .rejects.toThrow(`${dir} cannot be created: ${join(base, "a")} does not exist on this computer.`);
            expect(globalThis.__muhkooMkdirs).toEqual([]);
        } finally {
            globalThis.__muhkooMkdirs = undefined;
        }
        await expect(stat(join(base, "a"))).rejects.toThrow();
    });

    it("still mounts into a new folder inside an existing one, creating just that folder", async () => {
        const vfs = realVfs();
        globalThis.__muhkooTestClient = { vfs };
        await vfs.writeFile("/apps/p/remote.txt", enc("from elsewhere"));
        const dir = join(await tmp("leaf"), "fresh");
        globalThis.__muhkooMkdirs = [];
        const before = new Set(process.listeners("SIGINT"));
        const running = vfsCommand({ _: ["vfs", "mount", dir], path: "/apps/p" });
        try {
            for (let i = 0; i < 100 && !(await readFile(join(dir, "remote.txt"), "utf8").catch(() => null)); i++) await sleep(20);
            expect(await readFile(join(dir, "remote.txt"), "utf8")).toBe("from elsewhere");
            expect(globalThis.__muhkooMkdirs.filter(outsideTmp)).toEqual([]);
            expect(globalThis.__muhkooMkdirs).toContain(dir);
        } finally {
            globalThis.__muhkooMkdirs = undefined;
            for (const stop of process.listeners("SIGINT").filter((l) => !before.has(l))) stop("SIGINT");
            await running.catch(() => {});
        }
    });

    it("the help says which argument is the folder on this computer and which the Muhkoo path", () => {
        const entry = (cmd) => vfsHelp.split("\n  muhkoo vfs ").find((e) => e.startsWith(`${cmd} <dir`)).replace(/\s+/g, " ");
        for (const cmd of ["mount", "import"]) {
            expect(entry(cmd)).toMatch(/<dir…?> is (the|a) folder on this computer/);
            expect(entry(cmd)).toMatch(/--path is the Muhkoo path/);
        }
        expect(entry("mount")).toMatch(/not the folders? above it/);
    });
});
