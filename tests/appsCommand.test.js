/**
 * `muhkoo apps ls` and `apps get` over a stubbed `fetch`: deleted apps (the
 * server keeps them with `deletedAt` set) are hidden from the list and marked
 * on `get`, the way the portal treats them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseArgs } from "../src/lib/args.js";

vi.mock("../src/lib/config.js", () => ({
    devContext: async () => ({ baseUrl: "https://api.muhkoo.dev", token: "t" }),
}));

const { default: apps } = await import("../src/commands/apps.js");

let printed;
let reply;
const out = () => printed.join("\n");

beforeEach(() => {
    printed = [];
    reply = { status: 200, body: {} };
    vi.spyOn(console, "log").mockImplementation((...a) => printed.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => printed.push(a.join(" ")));
    vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`exit ${code}`);
    });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(reply.body), { status: reply.status }));
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const run = (...argv) => apps(parseArgs(["apps", ...argv]));

const live = { appId: "a1", slug: "live-app", allowedOrigins: "*", createdAt: 1 };
const gone = { appId: "a2", slug: "gone-app", allowedOrigins: "*", createdAt: 1, deletedAt: Date.UTC(2026, 10, 12) };

describe("muhkoo apps", () => {
    it("ls hides deleted apps", async () => {
        reply.body = { apps: [live, gone] };
        await run("ls");
        expect(out()).toContain("live-app");
        expect(out()).not.toContain("gone-app");
        expect(out()).not.toContain("a2");
    });

    it("ls --json leaves deleted apps out", async () => {
        reply.body = { apps: [live, gone] };
        await run("ls", "--json");
        const listed = JSON.parse(out());
        expect(listed.map((a) => a.appId)).toEqual(["a1"]);
    });

    it("ls says there are no apps when every app is deleted", async () => {
        reply.body = { apps: [gone] };
        await run("ls");
        expect(out()).toContain("No apps yet");
        expect(out()).not.toContain("gone-app");
    });

    it("get marks a deleted app with its deletion date", async () => {
        reply.body = gone;
        await run("get", "a2");
        expect(out()).toMatch(/deleted\s+2026-11-12/);
    });

    it("get prints no deleted line for a live app", async () => {
        reply.body = live;
        await run("get", "a1");
        expect(out()).toContain("live-app");
        expect(out()).not.toMatch(/deleted/);
    });
});
