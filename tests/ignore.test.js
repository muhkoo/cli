import { describe, it, expect } from "vitest";
import { compileIgnores, loadIgnores, NODE_DEFAULTS } from "../src/lib/ignore.js";

const m = (text) => compileIgnores(text);

describe("compileIgnores", () => {
    it("ignores a bare name at any depth", () => {
        const match = m("node_modules/");
        expect(match("node_modules", true)).toBe(true);
        expect(match("packages/web/node_modules", true)).toBe(true);
    });

    it("ignores everything beneath an ignored directory", () => {
        // The whole point: pruning a directory has to cover its contents.
        const match = m("node_modules/");
        expect(match("node_modules/react/index.js")).toBe(true);
        expect(match("packages/web/node_modules/react/index.js")).toBe(true);
    });

    it("anchors a pattern that contains a slash", () => {
        const match = m("/dist");
        expect(match("dist", true)).toBe(true);
        expect(match("packages/web/dist", true)).toBe(false);
    });

    it("matches an extension at any depth", () => {
        const match = m("*.log");
        expect(match("debug.log")).toBe(true);
        expect(match("src/deep/debug.log")).toBe(true);
        expect(match("debug.log.js")).toBe(false);
    });

    it("keeps * from crossing a separator", () => {
        const match = m("src/*.ts");
        expect(match("src/a.ts")).toBe(true);
        expect(match("src/deep/a.ts")).toBe(false);
    });

    it("lets ** cross separators, including none at all", () => {
        const match = m("**/fixtures");
        expect(match("fixtures", true)).toBe(true);
        expect(match("tests/fixtures", true)).toBe(true);
        expect(match("a/b/c/fixtures", true)).toBe(true);
    });

    it("applies a directory-only rule to directories alone", () => {
        const match = m("build/");
        expect(match("build", true)).toBe(true);
        expect(match("build", false)).toBe(false);   // a FILE named build stays
    });

    it("lets a later ! rule win", () => {
        const match = m("*.log\n!keep.log");
        expect(match("debug.log")).toBe(true);
        expect(match("keep.log")).toBe(false);
    });

    it("respects rule order — an ignore after a negation re-ignores", () => {
        expect(m("!keep.log\n*.log")("keep.log")).toBe(true);
    });

    it("skips blanks and comments", () => {
        const match = m("# a comment\n\n  \n*.log\n");
        expect(match("x.log")).toBe(true);
        expect(match("# a comment")).toBe(false);
    });

    it("treats ? as exactly one non-separator character", () => {
        const match = m("file?.txt");
        expect(match("file1.txt")).toBe(true);
        expect(match("file12.txt")).toBe(false);
        expect(match("file/.txt")).toBe(false);
    });

    it("does not let a dot in a pattern act as a wildcard", () => {
        const match = m("config.json");
        expect(match("config.json")).toBe(true);
        expect(match("configXjson")).toBe(false);
    });

    it("ignores nothing when given nothing", () => {
        const match = m("");
        expect(match("anything")).toBe(false);
        expect(match("node_modules", true)).toBe(false);
    });
});

describe("the Node defaults", () => {
    const match = compileIgnores(NODE_DEFAULTS);

    it("covers dependencies and build output", () => {
        expect(match("node_modules/left-pad/index.js")).toBe(true);
        expect(match("dist/app.js")).toBe(true);
        expect(match("coverage/lcov.info")).toBe(true);
        expect(match(".next/cache/x")).toBe(true);
    });

    it("covers secrets, but keeps the example", () => {
        // Uploading a .env by accident is the expensive mistake here.
        expect(match(".env")).toBe(true);
        expect(match(".env.local")).toBe(true);
        expect(match(".env.example")).toBe(false);
    });

    it("leaves source alone", () => {
        expect(match("src/index.ts")).toBe(false);
        expect(match("package.json")).toBe(false);
        expect(match("README.md")).toBe(false);
    });
});

describe("loadIgnores", () => {
    const fake = (files) => async (path) => {
        const name = path.split("/").pop();
        if (!(name in files)) throw new Error("ENOENT");
        return files[name];
    };

    it("prefers .vcsignore", async () => {
        const { match, source } = await loadIgnores("/p", fake({ ".vcsignore": "secret/", ".gitignore": "other/" }));
        expect(source).toBe(".vcsignore");
        expect(match("secret", true)).toBe(true);
        expect(match("other", true)).toBe(false);
    });

    it("falls back to .gitignore so a project works before opting in", async () => {
        const { match, source } = await loadIgnores("/p", fake({ ".gitignore": "other/" }));
        expect(source).toBe(".gitignore");
        expect(match("other", true)).toBe(true);
    });

    it("uses the Node defaults when there is neither", async () => {
        const { match, source } = await loadIgnores("/p", fake({}));
        expect(source).toBe("defaults");
        expect(match("node_modules/x")).toBe(true);
    });

    it("still applies the defaults alongside a project file", async () => {
        // A .vcsignore listing one fixture directory must not silently turn
        // node_modules syncing back on.
        const { match } = await loadIgnores("/p", fake({ ".vcsignore": "fixtures/" }));
        expect(match("node_modules/x")).toBe(true);
        expect(match("fixtures", true)).toBe(true);
    });

    it("lets a project re-include something the defaults ignore", async () => {
        const { match } = await loadIgnores("/p", fake({ ".vcsignore": "!dist/\n" }));
        expect(match("dist", true)).toBe(false);
    });
});
