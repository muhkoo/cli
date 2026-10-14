/**
 * `muhkoo vcs` as a command: the glue between the CLI and client.vcs.
 *
 * The repository is a stand-in that records what the command asked of it —
 * the SDK's own behaviour is tested in @muhkoo/connect. What matters here is
 * which SDK call a command line turns into, and what it tells the person.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Repo, VcsError, VfsNamespace } from "@muhkoo/connect";
import { parseArgs } from "../src/lib/args.js";

vi.mock("../src/lib/vfs.js", () => ({
    openClient: async () => globalThis.__muhkooTestClient,
}));

const { default: vcsCommand } = await import("../src/commands/vcs.js");

let lines;
beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation((...a) => lines.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => lines.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

/**
 * A repository that records calls; `pending` is what pendingMerge answers (a
 * function may throw). `branch` null is a detached HEAD, at `head`.
 */
function repoWith({ pending = { theirs: "a".repeat(64), name: "feature" }, branch = "main", head = "b".repeat(64), changes = [] } = {}) {
    const calls = [];
    const repo = {
        pendingMerge: async () => (typeof pending === "function" ? pending() : pending),
        abortMerge: async () => void calls.push("abortMerge"),
        merge: async (name) => {
            calls.push(`merge ${name}`);
            return { kind: "up-to-date" };
        },
        currentBranch: async () => branch,
        current: async () => head,
        status: async () => changes,
        switchTo: async (name, opts) => void calls.push(`switchTo ${name}${opts?.discardChanges ? " discard" : ""}`),
        checkout: async (hash, opts) => void calls.push(`checkout ${hash.slice(0, 8)}${opts?.discardChanges ? " discard" : ""}`),
    };
    globalThis.__muhkooTestClient = { vcs: { open: () => repo } };
    return calls;
}
const out = () => lines.join("\n");
/** What connect throws for a pending-merge record it cannot read. */
const unreadable = () => new VcsError("the merge in progress cannot be read: the record is not sealed; abort the merge to clear it");
/** Run a command line as the CLI parses it. */
const cli = (line) => vcsCommand({ ...parseArgs(line.split(" ")), project: "demo" });
const exits = () => vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`exit ${code}`); });

describe("vcs merge --abort", () => {
    // The SDK has had `abortMerge()` since the merge record became something a
    // commit refuses to proceed past when it cannot be read — but the CLI had
    // no way to call it, so a CLI-only user was told to abort a merge with no
    // command that does, and every `vcs commit` failed from then on.

    it("abandons the merge under way, and says how to put the files back", async () => {
        const calls = repoWith();
        await vcsCommand({ _: ["vcs", "merge"], abort: true, project: "demo" });
        expect(calls).toEqual(["abortMerge"]);
        expect(out()).toMatch(/feature/);
        expect(out()).toMatch(/muhkoo vcs switch main --discard/);
    });

    it("still abandons it when the record of the merge cannot be read", async () => {
        const calls = repoWith({ pending: () => { throw unreadable(); } });
        await vcsCommand({ _: ["vcs", "merge"], abort: true, project: "demo" });
        expect(calls).toEqual(["abortMerge"]);
    });

    it("says so, and changes nothing, when no merge is under way", async () => {
        const calls = repoWith({ pending: null });
        await vcsCommand({ _: ["vcs", "merge"], abort: true, project: "demo" });
        expect(calls).toEqual([]);
        expect(out()).toMatch(/No merge in progress/);
    });

    it("refuses a branch name alongside --abort rather than guessing which was meant", async () => {
        const calls = repoWith();
        vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`exit ${code}`); });
        // `vcs merge --abort feature` parses as abort: "feature".
        await expect(vcsCommand({ _: ["vcs", "merge"], abort: "feature", project: "demo" })).rejects.toThrow("exit 1");
        await expect(vcsCommand({ _: ["vcs", "merge", "feature"], abort: true, project: "demo" })).rejects.toThrow("exit 1");
        expect(calls).toEqual([]);
    });

    it("is in the command's help", async () => {
        const { help } = await import("../src/commands/vcs.js");
        expect(help).toMatch(/muhkoo vcs merge --abort/);
    });
});

describe("vcs merge --abort, after review [review 3]", () => {
    it("on a detached HEAD, says to check out the commit it was on, not to switch to a branch", async () => {
        // `vcs switch <branch> --discard` moves onto the branch's tip: not
        // back to the commit the merge started from.
        repoWith({ branch: null, head: "9".repeat(64) });
        await cli("vcs merge --abort");
        expect(out()).toMatch(/muhkoo vcs checkout 99999999 --discard/);
        expect(out()).not.toMatch(/vcs switch/);
    });

    it("does not treat a network failure as an unreadable record", async () => {
        const calls = repoWith({ pending: () => { throw new TypeError("fetch failed"); } });
        await expect(cli("vcs merge --abort")).rejects.toThrow("fetch failed");
        expect(calls).toEqual([]);
        expect(out()).not.toMatch(/Abandoned/);
    });

    it("does not treat another VcsError — no session — as an unreadable record", async () => {
        const calls = repoWith({ pending: () => { throw new VcsError("client.vcs: no session — sign in first."); } });
        await expect(cli("vcs merge --abort")).rejects.toThrow("no session");
        expect(calls).toEqual([]);
    });

    it("with --discard, puts the files back too", async () => {
        const calls = repoWith();
        await cli("vcs merge --abort --discard");
        expect(calls).toEqual(["abortMerge", "switchTo main discard"]);
        expect(out()).not.toMatch(/--discard` puts them back/);
    });

    it("with --discard on a detached HEAD, puts them back at that commit, staying detached", async () => {
        const calls = repoWith({ branch: null, head: "9".repeat(64) });
        await cli("vcs merge --discard --abort");
        expect(calls).toEqual(["abortMerge", "checkout 99999999 discard"]);
    });

    it("with --discard and no merge under way, changes nothing", async () => {
        const calls = repoWith({ pending: null });
        await cli("vcs merge --abort --discard");
        expect(calls).toEqual([]);
    });

    it("with --json, prints JSON", async () => {
        repoWith();
        await cli("vcs merge --abort --json");
        expect(JSON.parse(out())).toEqual({ aborted: true, merge: "feature" });
        lines.length = 0;
        repoWith({ pending: null });
        await cli("vcs merge --abort --json");
        expect(JSON.parse(out())).toEqual({ aborted: false, merge: null });
        lines.length = 0;
        repoWith({ pending: () => { throw unreadable(); } });
        await cli("vcs merge --abort --json");
        expect(JSON.parse(out())).toEqual({ aborted: true, merge: null });
    });

    it("refuses what it was given alongside --abort, naming it", async () => {
        exits();
        const calls = repoWith();
        await expect(cli("vcs merge --abort -m x")).rejects.toThrow("exit 1");
        expect(out()).toMatch(/-m x/);
        expect(out()).not.toMatch(/branch name/);
        lines.length = 0;
        await expect(cli("vcs merge --abort feature")).rejects.toThrow("exit 1");
        expect(out()).toMatch(/feature/);
        // `--discard feature` parses as discard: "feature" — a word a switch
        // swallowed is still something given, not a yes.
        lines.length = 0;
        await expect(cli("vcs merge --abort --discard feature")).rejects.toThrow("exit 1");
        expect(out()).toMatch(/feature/);
        expect(calls).toEqual([]);
    });
});

describe("vcs status with a merge record it cannot read [review 3]", () => {
    // Status is the first thing run to find out what is wrong. It read the
    // merge record with no guard, so it failed with the same error before
    // printing anything.
    it("says so, with the way out, and still lists the changes", async () => {
        repoWith({ pending: () => { throw unreadable(); }, changes: [{ kind: "modified", path: "/src/a.ts" }] });
        await cli("vcs status");
        expect(out()).toMatch(/cannot be read/);
        expect(out()).toMatch(/muhkoo vcs merge --abort/);
        expect(out()).toMatch(/\/src\/a\.ts/);
    });

    it("says so with --json too", async () => {
        repoWith({ pending: () => { throw unreadable(); } });
        await cli("vcs status --json");
        expect(JSON.parse(out())).toMatchObject({ project: "demo", merging: null, mergeUnreadable: true });
    });

    it("still fails on anything else", async () => {
        repoWith({ pending: () => { throw new TypeError("fetch failed"); } });
        await expect(cli("vcs status")).rejects.toThrow("fetch failed");
    });
});

describe("vcs merge --abort on a real repository [review 3]", () => {
    // The stand-in above checks which calls a command line makes; this checks
    // that what the command prints, and --discard, really put the files back.
    function realRepo() {
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
                blobs.set(id, { bytes, refs: 1 });
                return { manifest: { id, name: meta.name, size: bytes.length, type: "text/plain" }, size: bytes.length };
            },
            async read(m) { return blobs.get(m.id).bytes; },
            async retain(m) { blobs.get(m.id).refs++; },
            async release() {},
        };
        const vfs = new VfsNamespace({ store, content, seed: () => new Uint8Array(32).fill(9) });
        const repo = new Repo("demo", { vfs, store, key: async () => new Uint8Array(32).fill(3), author: () => "t" });
        globalThis.__muhkooTestClient = { vcs: { open: () => repo } };
        const write = (p, s) => vfs.writeFile(`/apps/demo${p}`, s);
        const read = async (p) => new TextDecoder().decode(await vfs.readFile(`/apps/demo${p}`));
        const exists = (p) => vfs.exists(`/apps/demo${p}`);
        return { repo, write, read, exists };
    }

    /** A merge of `feature` stopped for conflicts on a HEAD detached at an older commit than main's tip. */
    async function detachedConflict() {
        const r = realRepo();
        await r.write("/a.txt", "base\n");
        await r.repo.commit("base");
        await r.repo.branch("feature");
        await r.write("/a.txt", "ours\n");
        const ours = await r.repo.commit("ours");
        await r.write("/b.txt", "later on main\n");
        await r.repo.commit("later on main");
        await r.repo.switchTo("feature");
        await r.write("/a.txt", "theirs\n");
        await r.repo.commit("theirs");
        await r.repo.checkout(ours);
        expect((await r.repo.merge("feature")).kind).toBe("conflicted");
        return { ...r, ours };
    }

    it("on a detached HEAD, the command it prints puts the files back at that commit", async () => {
        const { repo, read, exists, ours } = await detachedConflict();
        await cli("vcs merge --abort");
        const advice = out().match(/`(muhkoo vcs [^`]+)`/)[1];
        expect(advice).toBe(`muhkoo vcs checkout ${ours.slice(0, 8)} --discard`);
        await cli(advice.replace(/^muhkoo /, ""));
        expect(await repo.currentBranch()).toBe(null);
        expect(await repo.current()).toBe(ours);
        expect(await read("/a.txt")).toBe("ours\n");
        expect(await exists("/b.txt")).toBe(false);
        expect(await repo.pendingMerge()).toBe(null);
    });

    it("with --discard on a detached HEAD, puts them back itself, staying where HEAD was", async () => {
        const { repo, read, exists, ours } = await detachedConflict();
        await cli("vcs merge --abort --discard");
        expect(await repo.currentBranch()).toBe(null);
        expect(await repo.current()).toBe(ours);
        expect(await read("/a.txt")).toBe("ours\n");
        expect(await exists("/b.txt")).toBe(false);
    });

    it("with --discard on a branch, puts them back at the branch's tip", async () => {
        const r = realRepo();
        await r.write("/a.txt", "base\n");
        await r.repo.commit("base");
        await r.repo.branch("feature");
        await r.write("/a.txt", "ours\n");
        const tip = await r.repo.commit("ours");
        await r.repo.switchTo("feature");
        await r.write("/a.txt", "theirs\n");
        await r.repo.commit("theirs");
        await r.repo.switchTo("main");
        expect((await r.repo.merge("feature")).kind).toBe("conflicted");
        await cli("vcs merge --abort --discard");
        expect(await r.repo.currentBranch()).toBe("main");
        expect(await r.repo.current()).toBe(tip);
        expect(await r.read("/a.txt")).toBe("ours\n");
        expect(await r.repo.pendingMerge()).toBe(null);
    });
});
