/**
 * `webLogin` and the one thing the browser can't send it: the unlock key in the
 * redirect fragment. The "browser" here is a stand-in that GETs /callback and
 * (optionally) POSTs /fragment, exactly as the callback page's script does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sealSeed, toBase64 } from "@muhkoo/connect";

let browser;
vi.mock("../src/lib/browser.js", () => ({
    openBrowser: (url) => {
        setTimeout(() => browser(new URL(url)), 0);
        return true;
    },
}));
vi.mock("../src/lib/ui.js", async (importOriginal) => ({
    ...(await importOriginal()),
    step: () => {},
    info: () => {},
}));

const { webLogin } = await import("../src/lib/webLogin.js");

const realFetch = globalThis.fetch;
let sealed, seedBytes, page;

beforeEach(async () => {
    seedBytes = new Uint8Array(32).map((_, i) => i + 1);
    sealed = await sealSeed(seedBytes);
    page = null;
    globalThis.fetch = vi.fn(async (url, init) => {
        if (String(url).endsWith("/api/auth/token")) {
            return new Response(
                JSON.stringify({ sessionToken: "sess", sealedKeys: sealed.sealedKeys, username: "ann", commitment: "c1" }),
                { status: 200 },
            );
        }
        return realFetch(url, init);
    });
});
afterEach(() => {
    globalThis.fetch = realFetch;
});

/** Visit /callback, then run what the page's script would do with `#k=…`. */
function visit({ postFragment, fragState, k }) {
    return async (authUrl) => {
        const redirect = new URL(authUrl.searchParams.get("redirect_uri"));
        const state = authUrl.searchParams.get("state");
        const res = await realFetch(`${redirect.origin}/callback?code=abc&state=${state}`);
        page = await res.text();
        if (postFragment) {
            const r = await realFetch(`${redirect.origin}/fragment`, {
                method: "POST",
                body: JSON.stringify({ state: fragState ?? state, k: k ?? sealed.fragmentKey }),
            });
            visit.lastStatus = r.status;
        }
    };
}

describe("webLogin", () => {
    it("resolves the seed the fragment key opens", async () => {
        browser = visit({ postFragment: true });
        const r = await webLogin({ baseUrl: "https://api.test", appId: "muhkoo-cli" });
        expect(r).toMatchObject({ token: "sess", username: "ann", commitment: "c1", seed: toBase64(seedBytes) });
    });

    it("the callback page posts the fragment to its own origin, and keeps its success text", async () => {
        browser = visit({ postFragment: true });
        await webLogin({ baseUrl: "https://api.test", appId: "muhkoo-cli" });
        expect(page).toContain("You can close this tab");
        expect(page).toContain('fetch("/fragment"');
        expect(page).toContain("location.hash");
        expect(page).toContain("history.replaceState");
    });

    it("with no /fragment POST, resolves seed null once the wait is over", async () => {
        browser = visit({ postFragment: false });
        const t0 = Date.now();
        const r = await webLogin({ baseUrl: "https://api.test", appId: "muhkoo-cli", fragmentWaitMs: 300 });
        expect(r.seed).toBeNull();
        expect(r.token).toBe("sess");
        expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    });

    it("a /fragment with the wrong state is refused (400) and yields no seed", async () => {
        browser = visit({ postFragment: true, fragState: "not-our-state" });
        const r = await webLogin({ baseUrl: "https://api.test", appId: "muhkoo-cli", fragmentWaitMs: 300 });
        expect(visit.lastStatus).toBe(400);
        expect(r.seed).toBeNull();
    });

    it("a key that does not open the envelope yields null, not a throw", async () => {
        browser = visit({ postFragment: true, k: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
        const r = await webLogin({ baseUrl: "https://api.test", appId: "muhkoo-cli" });
        expect(r.seed).toBeNull();
    });
});
