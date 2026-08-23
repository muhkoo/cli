import { describe, it, expect } from "vitest";
import { planPath, planSync } from "../src/lib/syncPlan.js";

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
