import { describe, it, expect } from "vitest";
import { planPath, planSync, holdMassDeletes } from "../src/lib/syncPlan.js";

const A = "hash-a";
const B = "hash-b";

describe("planPath", () => {
    it("does nothing when the two sides agree", () => {
        expect(planPath({ last: A, local: A, remote: A })).toBe("none");
        // Identical content we have never synced still needs no transfer.
        expect(planPath({ last: undefined, local: A, remote: A })).toBe("none");
    });

    it("pushes a local edit", () => {
        expect(planPath({ last: A, local: B, remote: A })).toBe("push");
    });

    it("pulls a remote edit", () => {
        expect(planPath({ last: A, local: A, remote: B })).toBe("pull");
    });

    it("pulls a file that only exists remotely", () => {
        expect(planPath({ last: undefined, local: undefined, remote: A })).toBe("pull");
    });

    it("pushes a file that only exists locally", () => {
        expect(planPath({ last: undefined, local: A, remote: undefined })).toBe("push");
    });

    it("propagates a local delete", () => {
        expect(planPath({ last: A, local: undefined, remote: A })).toBe("delete-remote");
    });

    it("propagates a remote delete", () => {
        expect(planPath({ last: A, local: A, remote: undefined })).toBe("delete-local");
    });

    it("does NOT delete when the other side changed after the delete", () => {
        // Deleted here, edited there since the last sync. Honouring the stale
        // delete would destroy newer work — exactly the silent loss this guards.
        expect(planPath({ last: A, local: undefined, remote: B })).toBe("pull");
        expect(planPath({ last: A, local: B, remote: undefined })).toBe("push");
    });

    it("reports a conflict when both sides moved", () => {
        expect(planPath({ last: A, local: B, remote: "hash-c" })).toBe("conflict");
    });

    it("treats two independent creations as a conflict, not a silent winner", () => {
        expect(planPath({ last: undefined, local: A, remote: B })).toBe("conflict");
    });

    it("forgets a path once it is gone from both sides", () => {
        expect(planPath({ last: A, local: undefined, remote: undefined })).toBe("forget");
        expect(planPath({ last: undefined, local: undefined, remote: undefined })).toBe("none");
    });
});

describe("planSync", () => {
    it("plans across all three views, sorted, skipping no-ops", () => {
        const plan = planSync({
            last: { "/keep.txt": A, "/gone.txt": A, "/edited.txt": A },
            local: { "/keep.txt": A, "/edited.txt": B, "/new.txt": A },
            remote: { "/keep.txt": A, "/gone.txt": A, "/edited.txt": A },
        });
        expect(plan).toEqual([
            { path: "/edited.txt", action: "push" },
            { path: "/gone.txt", action: "delete-remote" },
            { path: "/new.txt", action: "push" },
        ]);
    });

    it("is empty when everything matches — the steady state", () => {
        // Runs on every filesystem event, so it must not manufacture work.
        const same = { "/a": A, "/b": B };
        expect(planSync({ last: same, local: same, remote: same })).toEqual([]);
    });
});

describe("filtered is not absent", () => {
    // A path one scan deliberately did not look at — refused, over the size
    // limit, unreadable — is not a path that is missing. Reading the gap as a
    // deletion deleted the local .git with --allow-delete (G7), a 100MB asset
    // and its history (N5), and the local copy of anything whose remote read
    // failed (N8).
    it("plans nothing for an unknown path, whatever the other views say", () => {
        const views = { last: { "/a": A }, local: { "/a": A }, remote: {} };
        expect(planSync(views)).toEqual([{ path: "/a", action: "delete-local" }]);
        expect(planSync({ ...views, unknown: ["/a"] })).toEqual([]);
        expect(planSync({ last: { "/a": A }, local: {}, remote: { "/a": A }, unknown: ["/a"] })).toEqual([]);
        expect(planSync({ last: {}, local: {}, remote: { "/a": A }, unknown: ["/a"] })).toEqual([]);
    });

    it("treats an unknown directory as covering everything beneath it", () => {
        const plan = planSync({
            last: { "/node_modules/x/index.js": A, "/src/a.ts": A },
            local: { "/src/a.ts": A },
            remote: { "/src/a.ts": A },
            unknown: new Set(["/node_modules"]),
        });
        expect(plan).toEqual([]);
    });

    it("matches whole segments, not string prefixes", () => {
        const plan = planSync({ last: {}, local: { "/node_modules2/a": A }, remote: {}, unknown: ["/node_modules"] });
        expect(plan).toEqual([{ path: "/node_modules2/a", action: "push" }]);
    });

    it("costs a path its length, not its length times its depth [review 2]", () => {
        // Each prefix of each path was sliced and hashed afresh: a thousand
        // remote paths 61 deep of 240-character names held the event loop
        // for half a second, and a walk's worth of them for several.
        const deep = (tag) => "/" + Array.from({ length: 61 }, (_, k) => `${tag}_${k}${"a".repeat(240)}`).join("/");
        const remote = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [deep(`t${i}`), A]));
        const unknown = new Set([deep("u0"), "/x"]);
        const t0 = performance.now();
        const plan = planSync({ last: {}, local: {}, remote, unknown });
        expect(performance.now() - t0).toBeLessThan(150);
        expect(plan).toHaveLength(1000);
        expect(planSync({ last: {}, local: {}, remote: { [`${deep("u0")}/f`]: A, "/x/y": A, "/xy": A }, unknown })).toEqual([{ path: "/xy", action: "pull" }]);
    });
});

describe("holdMassDeletes", () => {
    const tracked = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`/f${i}`, A]));
    const deletes = (n, action) => Array.from({ length: n }, (_, i) => ({ path: `/f${i}`, action }));

    it("holds every delete in a direction that would remove most of what is tracked", () => {
        // What a missing or renamed remote root looks like: every tracked path
        // absent on one side at once.
        const plan = [...deletes(10, "delete-local"), { path: "/new", action: "push" }];
        const { plan: kept, held } = holdMassDeletes(plan, tracked(10));
        expect(kept).toEqual([{ path: "/new", action: "push" }]);
        expect(held).toEqual([{ action: "delete-local", count: 10, tracked: 10 }]);
    });

    it("holds each direction on its own count", () => {
        const plan = [...deletes(6, "delete-remote"), { path: "/f9", action: "delete-local" }];
        const { plan: kept, held } = holdMassDeletes(plan, tracked(10));
        expect(kept).toEqual([{ path: "/f9", action: "delete-local" }]);
        expect(held.map((h) => h.action)).toEqual(["delete-remote"]);
    });

    it("lets ordinary deletions through", () => {
        expect(holdMassDeletes(deletes(2, "delete-local"), tracked(10)).held).toEqual([]);
        // Most of a tiny project is still a small number of files.
        expect(holdMassDeletes(deletes(3, "delete-local"), tracked(3)).held).toEqual([]);
        // Many files, but not most of them.
        expect(holdMassDeletes(deletes(40, "delete-remote"), tracked(100)).held).toEqual([]);
    });

    it("holds more than the floor once it is also more than half", () => {
        expect(holdMassDeletes(deletes(4, "delete-local"), tracked(6)).held).toHaveLength(1);
    });
});

describe("holdMassDeletes: an empty view deletes nothing [review]", () => {
    // The count rule alone let a small project's local copy go when the
    // remote came back empty: 3 of 3 is not "more than the floor". An empty
    // view with a non-empty history is a broken view, whatever the count.
    const tracked = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`/f${i}`, A]));
    const deletes = (n, action) => Array.from({ length: n }, (_, i) => ({ path: `/f${i}`, action }));

    it("holds every local delete when the remote view is empty", () => {
        const { plan, held } = holdMassDeletes(deletes(3, "delete-local"), tracked(3), { local: 3, remote: 0 });
        expect(plan).toEqual([]);
        expect(held).toEqual([{ action: "delete-local", count: 3, tracked: 3, empty: true }]);
    });

    it("holds every remote delete when the local view is empty", () => {
        const { plan, held } = holdMassDeletes(deletes(1, "delete-remote"), tracked(1), { local: 0, remote: 1 });
        expect(plan).toEqual([]);
        expect(held.map((h) => h.action)).toEqual(["delete-remote"]);
    });

    it("still lets a small deletion through when both views have files", () => {
        expect(holdMassDeletes(deletes(3, "delete-local"), tracked(3), { local: 3, remote: 1 }).held).toEqual([]);
    });
});

describe("holdMassDeletes measures against the most this session has tracked [L8]", () => {
    // Deleting just under half, pass after pass, kept every pass under the
    // line while the project went. Against the peak, the slices add up.
    const tracked = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`/f${i}`, A]));
    const deletes = (n, action) => Array.from({ length: n }, (_, i) => ({ path: `/f${i}`, action }));

    it("holds a slice that would leave less than half of the peak", () => {
        // 20 at the peak, 11 left: 5 more would leave 6.
        const { held } = holdMassDeletes(deletes(5, "delete-local"), tracked(11), { local: 11, remote: 6 }, 20);
        expect(held.map((h) => h.action)).toEqual(["delete-local"]);
    });

    it("still lets a small deletion through after a large one", () => {
        expect(holdMassDeletes(deletes(2, "delete-local"), tracked(11), { local: 11, remote: 9 }, 20).held).toEqual([]);
    });

    it("measures against what is tracked now when that is the most", () => {
        expect(holdMassDeletes(deletes(9, "delete-local"), tracked(20), { local: 20, remote: 11 }, 12).held).toEqual([]);
        expect(holdMassDeletes(deletes(11, "delete-local"), tracked(20), { local: 20, remote: 9 }, 12).held).toHaveLength(1);
    });
});
