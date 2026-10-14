import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compileIgnores, draftIgnores, ruleSystem, NODE_DEFAULTS } from "../src/lib/ignore.js";
import * as ignoreLib from "../src/lib/ignore.js";

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

describe("the root files: which one decides", () => {
    it("prefers .vcsignore", () => {
        const { match, source } = ruleSystem({ ".vcsignore": "secret/", ".gitignore": "other/" });
        expect(source).toBe(".vcsignore");
        expect(match("secret", true)).toBe(true);
        expect(match("other", true)).toBe(false);
    });

    it("falls back to .gitignore so a project works before opting in", () => {
        const { match, source } = ruleSystem({ ".gitignore": "other/" });
        expect(source).toBe(".gitignore");
        expect(match("other", true)).toBe(true);
    });

    it("uses the Node defaults when there is neither", () => {
        const { match, source } = ruleSystem({});
        expect(source).toBe("defaults");
        expect(match("node_modules/x")).toBe(true);
    });

    it("still applies the defaults alongside a project file", () => {
        // A .vcsignore listing one fixture directory must not silently turn
        // node_modules syncing back on.
        const { match } = ruleSystem({ ".vcsignore": "fixtures/" });
        expect(match("node_modules/x")).toBe(true);
        expect(match("fixtures", true)).toBe(true);
    });

    it("lets a project re-include something the defaults ignore", () => {
        const { match } = ruleSystem({ ".vcsignore": "!dist/\n" });
        expect(match("dist", true)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The matcher runs synchronously on every path of every pass, and since the
// ignore files travel with the project, a pattern in one can be written by
// anyone able to write the user's filesystem.

describe("the matcher cannot be made to backtrack catastrophically", () => {
    it("matches the audit's hostile pattern in well under 100ms", () => {
        // `**a` twelve times then `**!`, against a run of "a" it cannot match.
        // As a generated RegExp this was `.*a.*a…a.*!`, which backtracks
        // polynomially in the number of stars: k=8 on 40 characters took
        // 2.5s, and this one never finished.
        const match = m("**a".repeat(12) + "**!");
        const t0 = performance.now();
        expect(match("a".repeat(60))).toBe(false);
        expect(match("x/" + "a".repeat(60), false)).toBe(false);
        expect(performance.now() - t0).toBeLessThan(100);
    });

    it("stays fast when the stars are spread over many segments", () => {
        const match = m("**/a/".repeat(20) + "b");
        const t0 = performance.now();
        expect(match("a/".repeat(40) + "c")).toBe(false);
        expect(performance.now() - t0).toBeLessThan(100);
    });
});

describe("** follows gitignore", () => {
    it("is special only as a whole segment; elsewhere it is a plain *", () => {
        const match = m("a**b");
        expect(match("axyb")).toBe(true);
        expect(match("a/x/b")).toBe(false);   // a plain * never crosses a slash
    });

    it("x/** matches everything inside x, but not x itself", () => {
        const match = m("foo/**");
        expect(match("foo/a")).toBe(true);
        expect(match("foo/a/b")).toBe(true);
        expect(match("foo", true)).toBe(false);
    });

    it("x/**/y matches zero or more directories between", () => {
        const match = m("a/**/b");
        expect(match("a/b")).toBe(true);
        expect(match("a/x/b")).toBe(true);
        expect(match("a/x/y/b")).toBe(true);
        expect(match("c/a/b")).toBe(false);   // anchored: it has a slash
    });

    it("reads character classes, negated classes and ranges", () => {
        expect(m("file[0-9].txt")("file7.txt")).toBe(true);
        expect(m("file[0-9].txt")("filex.txt")).toBe(false);
        expect(m("file[!0-9].txt")("filex.txt")).toBe(true);
        expect(m("file[!0-9].txt")("file7.txt")).toBe(false);
        expect(m("[]]x")("]x")).toBe(true);
        expect(m("a[")("a[")).toBe(true);   // unterminated: a literal bracket
    });

    it("treats a backslash as escaping the next character", () => {
        expect(m("\\*.txt")("*.txt")).toBe(true);
        expect(m("\\*.txt")("a.txt")).toBe(false);
        expect(m("\\#notes")("#notes")).toBe(true);
    });
});

describe("one bad line", () => {
    it("is skipped with a warning; the rest of the file still applies", () => {
        // `new RegExp("[z-a]")` used to throw, and the throw discarded EVERY
        // rule in the file — silently, because the caller read it as "no file".
        const bad = [];
        const match = compileIgnores("secrets/\n[z-a]\n*.pem\n", { onBadLine: (line) => bad.push(line) });
        expect(match("secrets/key.pem")).toBe(true);
        expect(match("server.pem")).toBe(true);
        expect(bad).toEqual(["[z-a]"]);
    });

    it("does not make the rules fall through to .gitignore", () => {
        const files = { ".vcsignore": "secrets/\n[z-a]\n", ".gitignore": "# nothing about secrets\n" };
        const { match, source } = ruleSystem(files, { onBadLine: () => {} });
        expect(source).toBe(".vcsignore");
        expect(match("secrets/key.pem")).toBe(true);
    });
});

describe("ignoreCase", () => {
    it("is off by default, as on a case-sensitive volume", () => {
        expect(m("config/master.key")("Config/Master.key")).toBe(false);
    });

    it("folds case when the volume does (git's core.ignorecase)", () => {
        const match = compileIgnores("config/master.key\n*.PEM\nnode_modules/", { ignoreCase: true });
        expect(match("Config/Master.key")).toBe(true);
        expect(match("server.pem")).toBe(true);
        expect(match("Node_Modules/x/index.js")).toBe(true);
    });

    it("also folds Unicode normalization, as APFS does", () => {
        const nfc = "caf\u00e9.md";
        const nfd = "cafe\u0301.md";
        expect(compileIgnores(nfc, { ignoreCase: true })(nfd)).toBe(true);
    });

    it("is threaded through the whole rule system", () => {
        const { match } = ruleSystem({ ".gitignore": "config/master.key\n" }, { ignoreCase: true });
        expect(match("CONFIG/master.KEY")).toBe(true);
    });
});

describe(".gitignore mode follows git", () => {
    it("honours .git/info/exclude", () => {
        const { match } = ruleSystem({ ".gitignore": "dist/\n", ".git/info/exclude": "local-notes.md\n" });
        expect(match("local-notes.md")).toBe(true);
    });

    it("gives .git/info/exclude lower precedence than any .gitignore", () => {
        const { match } = ruleSystem({ ".gitignore": "!x.txt\n", ".git/info/exclude": "x.txt\n" });
        expect(match("x.txt")).toBe(false);
    });

    it("does not read .git/info/exclude when a .vcsignore wins outright", () => {
        const { match } = ruleSystem({ ".vcsignore": "a/\n", ".git/info/exclude": "local-notes.md\n" });
        expect(match("local-notes.md")).toBe(false);
    });

    it("scopes a nested .gitignore to its own directory", () => {
        const rules = ruleSystem({ ".gitignore": "", "packages/api/.gitignore": "config/credentials.json\n" });
        expect(rules.match("packages/api/config/credentials.json")).toBe(true);
        expect(rules.match("config/credentials.json")).toBe(false);
    });

    it("lets a deeper .gitignore take precedence", () => {
        const rules = ruleSystem({ ".gitignore": "*.log\n", "a/.gitignore": "!keep.log\n" });
        expect(rules.match("a/keep.log")).toBe(false);
        expect(rules.match("keep.log")).toBe(true);
        expect(rules.match("a/other.log")).toBe(true);
    });

    it("keeps the Node defaults as the lowest-precedence base", () => {
        const rules = ruleSystem({ ".gitignore": "!dist/\n" });
        expect(rules.match("dist", true)).toBe(false);
        expect(rules.match("node_modules", true)).toBe(true);
    });

    it("honours nested files even with no root .gitignore", () => {
        const rules = ruleSystem({ "pkg/.gitignore": "secret.txt\n" });
        expect(rules.match("pkg/secret.txt")).toBe(true);
    });

    it("ignores nested .gitignore files when a .vcsignore wins outright", () => {
        const rules = ruleSystem({ ".vcsignore": "", "a/.gitignore": "x\n" });
        expect(rules.match("a/x")).toBe(false);
    });

    it("picks up a nested file registered after it was created", () => {
        // The scan discovers nested files as it descends, so the rule set grows
        // while it is in use.
        const rules = ruleSystem({ ".gitignore": "" });
        expect(rules.match("a/x")).toBe(false);
        rules.set("a/.gitignore", "x\n");
        expect(rules.match("a/x")).toBe(true);
        rules.delete("a/.gitignore");
        expect(rules.match("a/x")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Fix-up round: what the review of the first rewrite found.

describe("a class named after an Object.prototype member [review]", () => {
    // `POSIX_CLASSES[name]` was truthy for `constructor`, `toString` and the
    // rest, so the line compiled — and threw on every MATCH, outside the
    // per-line skip. One planted line failed every later pass.
    it.each(["[[:constructor:]]", "[[:__proto__:]]", "[[:toString:]]", "[[:hasOwnProperty:]]", "x[[:valueOf:]]y"])(
        "%s is skipped as a bad line; the rest of the file still applies",
        (line) => {
            const bad = [];
            const match = compileIgnores(`secrets/\n${line}\n*.pem\n`, { onBadLine: (l) => bad.push(l) });
            expect(() => match("src/a.ts")).not.toThrow();
            expect(match("src/a.ts")).toBe(false);
            expect(match("secrets/key")).toBe(true);
            expect(match("server.pem")).toBe(true);
            expect(bad).toEqual([line]);
        },
    );
});

describe("the matcher does not recurse per pattern segment [A7]", () => {
    it("matches one planted line of 20,000 `**/` without overflowing the stack", () => {
        const match = m("**/".repeat(20000) + "x");
        expect(() => match("a/b/c")).not.toThrow();
        expect(match("a/b/c")).toBe(false);
        expect(match("a/b/x")).toBe(true);
    });

    it("matches a pattern of 20,000 plain segments", () => {
        const match = m("a/".repeat(20000) + "b");
        expect(match("a/b")).toBe(false);
        expect(match("a/".repeat(20000) + "b")).toBe(true);
    });
});

describe("an excluded directory excludes what is in it; a negated directory does not re-include it [A4]", () => {
    // Git evaluates each directory on its own: `!keys/` keeps the directory,
    // and `*.pem` still matches the file inside it. The prefix clause let the
    // negation of a PARENT override a rule that matched the file itself.
    it("`*.pem` then `!keys/` still ignores keys/server.pem", () => {
        const match = m("*.pem\n!keys/\n");
        expect(match("keys/server.pem")).toBe(true);
        expect(match("keys/readme.md")).toBe(false);
        expect(match("keys", true)).toBe(false);
        expect(match("a.pem")).toBe(true);
    });

    it("the whitelist idiom keeps only what it names", () => {
        const match = m("*\n!*/\n!*.js\n!.gitignore\n");
        expect(match("src/a.js")).toBe(false);
        expect(match("top.js")).toBe(false);
        expect(match("src/secret.pem")).toBe(true);
        expect(match("top.pem")).toBe(true);
    });

    it("`secret.txt` then `!docs/` still ignores docs/secret.txt", () => {
        expect(m("secret.txt\n!docs/\n")("docs/secret.txt")).toBe(true);
    });

    it("a nested `!certs/` does not re-include certs/a.pem", () => {
        const rules = ruleSystem({ ".gitignore": "*.pem\n", "sub/.gitignore": "!certs/\n" });
        expect(rules.match("sub/certs/a.pem")).toBe(true);
        expect(rules.match("sub/x.txt")).toBe(false);
    });

    it("still re-includes a directory whose PARENT's contents were excluded", () => {
        const match = m("logs/*\n!logs/important/\n");
        expect(match("logs/important/x.txt")).toBe(false);
        expect(match("logs/other/y.txt")).toBe(true);
    });

    it("still cannot re-include a file under an excluded directory", () => {
        expect(m("build/\n!build/keep.txt\n")("build/keep.txt")).toBe(true);
    });
});

const hasGit = (() => {
    try {
        execFileSync("git", ["--version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
})();

describe.skipIf(!hasGit)("agrees with git on random rule sets [A4, A8]", () => {
    // A seeded version of the review's differential fuzz: random root and
    // nested .gitignore files over a fixed tree, compared with what
    // `git ls-files -o --exclude-standard` would add.
    const FILES = ["c.txt", "x.pem", "a/c.txt", "a/x.pem", "a/b/c.txt", "a/b/x.pem", "b/a/c.txt", "b/x.pem", "ab/c.txt", "a/b/d/e.pem", "d/a/b/c.txt"];
    const SEGS = ["a", "b", "d", "*", "**", "c.txt", "*.pem", "a*", "?", "[ab]", "x.*"];

    it("never excludes less than git, nor more, over 120 seeded rule sets", async () => {
        let seed = 7;
        const rnd = (n) => {   // mulberry32
            seed = (seed + 0x6d2b79f5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) % n;
        };
        const pat = () => {
            let p = Array.from({ length: 1 + rnd(3) }, () => SEGS[rnd(SEGS.length)]).join("/");
            if (rnd(4) === 0) p = "/" + p;
            if (rnd(4) === 0) p += "/";
            if (rnd(3) === 0) p = "!" + p;
            return p;
        };
        const base = await mkdtemp(join(tmpdir(), "muhkoo-gitdiff-"));
        const disagreements = [];
        try {
            for (let it = 0; it < 120; it++) {
                const dir = join(base, String(it));
                await mkdir(dir, { recursive: true });
                execFileSync("git", ["init", "-q"], { cwd: dir });
                // A byte-order mark now and then, as a Windows editor saves one.
                const texts = { ".gitignore": (rnd(4) === 0 ? "\ufeff" : "") + Array.from({ length: 1 + rnd(4) }, pat).join("\n") + "\n" };
                if (rnd(2)) texts["a/.gitignore"] = (rnd(4) === 0 ? "\ufeff" : "") + Array.from({ length: 1 + rnd(2) }, pat).join("\n") + "\n";
                for (const [rel, text] of Object.entries({ ...texts, ...Object.fromEntries(FILES.map((f) => [f, "x"])) })) {
                    await mkdir(dirname(join(dir, rel)), { recursive: true });
                    await writeFile(join(dir, rel), text);
                }
                const added = new Set(
                    execFileSync("git", ["ls-files", "-o", "--exclude-standard"], { cwd: dir, encoding: "utf8" }).split("\n"),
                );
                const rules = ruleSystem(texts);
                for (const file of FILES) {
                    if (added.has(file) === !rules.match(file)) continue;
                    disagreements.push({ texts, file, git: added.has(file) ? "adds" : "ignores" });
                }
            }
        } finally {
            await rm(base, { recursive: true, force: true });
        }
        expect(disagreements.slice(0, 3)).toEqual([]);
    }, 60_000);
});

describe("ignoreCase folds the way the volume does [A1]", () => {
    // APFS applies FULL case folding: ſ is s, ß is ss, the ﬁ and ﬆ ligatures
    // are fi and st. A remote `config/maſter.key` passed a `config/master.key`
    // rule, was pulled, and the developer's later write of the real key landed
    // in it — and uploaded.
    const match = compileIgnores("config/master.key\ncredentials.json\ndist/\nmass.txt\nfile.key\nstuff\n", { ignoreCase: true });

    it.each([
        ["config/maſter.key", "long s"],
        ["credentialſ.json", "long s at the end"],
        ["diſt/bundle.js", "long s in an excluded directory"],
        ["maß.txt", "sharp s"],
        ["MAẞ.txt", "capital sharp s"],
        ["ﬁle.key", "fi ligature"],
        ["ﬆuff", "st ligature"],
        ["config/\u200bmaster.key", "a zero-width space"],
    ])("%j (%s) matches", (path) => {
        expect(match(path)).toBe(true);
    });

    it("normalizes to NFC even when case is not folded, as case-sensitive APFS does", () => {
        expect(m("café.md")("café.md")).toBe(true);
        expect(m("café.md")("café.md")).toBe(true);
    });

    it("keeps pattern syntax apart from the characters it folds to", () => {
        // A fullwidth asterisk folds to `*`, but as a literal character.
        const lit = compileIgnores("a＊b\n", { ignoreCase: true });
        expect(lit("a*b")).toBe(true);
        expect(lit("axb")).toBe(false);
    });
});

describe("ignoreFileProblem: how big an ignore file may be [A6]", () => {
    it("accepts an ordinary file", () => {
        expect(ignoreLib.ignoreFileProblem(Buffer.from(NODE_DEFAULTS))).toBe(null);
    });

    it("refuses more rules than any real project writes", () => {
        const text = Array.from({ length: 10_001 }, (_, i) => `r${i}`).join("\n");
        expect(ignoreLib.ignoreFileProblem(Buffer.from(text))).toMatch(/rules/);
    });

    it("refuses a file over the size limit", () => {
        expect(ignoreLib.ignoreFileProblem(Buffer.alloc(300 * 1024, 0x61))).toMatch(/KB/);
    });

    it("does not count comments and blank lines as rules", () => {
        const text = "# c\n\n".repeat(20_000);
        expect(ignoreLib.ignoreFileProblem(Buffer.from(text))).toBe(null);
    });
});

describe("draftIgnores carries every file git reads [A11]", () => {
    // A .vcsignore wins outright, so a draft of the root .gitignore alone
    // silently dropped every nested .gitignore and .git/info/exclude — and
    // uploaded what they kept home.
    const texts = {
        ".gitignore": "*.log\ncoverage/\n",
        ".git/info/exclude": "local-notes.md\n",
        "packages/api/.gitignore": "config/credentials.json\n/dist\nbuild/\n*.tmp\n!keep.tmp\n",
        "packages/api/src/.gitignore": "!important.log\n",
    };
    const paths = [
        ["packages/api/config/credentials.json"], ["config/credentials.json"], ["packages/api/dist", true],
        ["packages/api/src/dist", true], ["packages/api/src/build", true], ["packages/web/build", true],
        ["packages/api/x.tmp"], ["packages/api/keep.tmp"], ["x.tmp"], ["local-notes.md"], ["deep/local-notes.md"],
        ["debug.log"], ["packages/api/src/important.log"], ["packages/api/important.log"], ["src/index.ts"],
    ];

    it("drafts a .vcsignore that excludes exactly what git's files exclude", () => {
        const git = ruleSystem(texts);
        const draft = ruleSystem({ ".vcsignore": draftIgnores(texts) });
        for (const [p, isDir = false] of paths) expect([p, draft.match(p, isDir)]).toEqual([p, git.match(p, isDir)]);
    });

    it("escapes glob characters in a directory's name", () => {
        const draft = ruleSystem({ ".vcsignore": draftIgnores({ "we[ir]d/.gitignore": "x\n", "#notes/.gitignore": "y\n" }) });
        expect(draft.match("we[ir]d/x")).toBe(true);
        expect(draft.match("wed/x")).toBe(false);
        expect(draft.match("#notes/y")).toBe(true);
    });

    it("keeps a line the defaults also have when a negation comes before it", () => {
        // Dropping the second `dist/` would leave `!dist/` in charge.
        const text = draftIgnores("!dist/\ndist/\n");
        expect(ruleSystem({ ".vcsignore": text }).match("dist", true)).toBe(true);
    });

    it("still takes the text of a lone .gitignore", () => {
        expect(draftIgnores("other/\n")).toMatch(/^other\/$/m);
        expect(draftIgnores("")).toBe(NODE_DEFAULTS);
    });
});

// ---------------------------------------------------------------------------
// Round 3.

describe("what one rule may hold [L3]", () => {
    // The adversary's b2b: 10,000 rules inside every size limit, each a star,
    // a `?` and a long literal run — which defeated the literal, suffix and
    // prefix shortcuts and cost 166ms per 250-character name.
    const hostile = (k = 20, tail = "", count = 10_000) =>
        Array.from({ length: count }, (_, i) => "*?" + "a".repeat(k) + "b" + (i % 10) + tail).join("\n");

    it("a full file of hostile rules costs a few milliseconds per long name, decided or not", () => {
        const text = hostile();
        expect(ignoreLib.ignoreFileProblem(Buffer.from(text))).toBe(null);
        const rules = ruleSystem({ ".vcsignore": text }, { ignoreCase: true });
        rules.match("warm");
        const t0 = performance.now();
        for (let i = 0; i < 20; i++) {
            try {
                expect(rules.match(`d${i}/${"a".repeat(250)}${i}`)).toBe(false);
            } catch (err) {
                expect(err).toBeInstanceOf(ignoreLib.IgnoreBudgetError);
            }
        }
        expect((performance.now() - t0) / 20).toBeLessThan(10);
    });

    it("still matches what those rules describe", () => {
        const rules = ruleSystem({ ".vcsignore": hostile(3) });
        expect(rules.match("xxaaab3")).toBe(true);
        expect(rules.match("aaab3")).toBe(false);   // `?` needs a character before the run
    });

    it("skips a rule with more wildcards than any real rule has, with a warning", () => {
        const bad = [];
        const many = "?".repeat(ignoreLib.MAX_WILDCARDS + 1);
        const match = compileIgnores(`secrets/\n${many}\n*.pem\n`, { onBadLine: (line) => bad.push(line) });
        expect(bad).toEqual([many]);
        expect(match("secrets/x")).toBe(true);
        expect(match("x.pem")).toBe(true);
        expect(compileIgnores("?".repeat(ignoreLib.MAX_WILDCARDS))("a".repeat(ignoreLib.MAX_WILDCARDS))).toBe(true);
    });

    it("keeps the real templates' densest lines well inside the limit", () => {
        const bad = [];
        compileIgnores("[Tt][Hh][Uu][Mm][Bb][Ss].[Dd][Bb]\n**/[Pp]ackages/*\n*.[Cc][Aa][Cc][Hh][Ee]\n", { onBadLine: (l) => bad.push(l) });
        expect(bad).toEqual([]);
    });

    it("skips a class with more members than any real class has, with a warning", () => {
        // The adversary's line: one class of 250,000 members, three wildcards,
        // and 520ms a path.
        const bomb = "*[" + "b".repeat(250_000) + "]*";
        const bad = [];
        const match = compileIgnores(`secrets/\n${bomb}\n*.pem\n`, { onBadLine: (line) => bad.push(line) });
        expect(bad).toEqual([bomb]);
        expect(match("secrets/x")).toBe(true);
        expect(match("x.pem")).toBe(true);
        const most = "[" + Array.from({ length: ignoreLib.MAX_CLASS_ITEMS }, (_, i) => String.fromCharCode(0x100 + i)).join("") + "]";
        expect(compileIgnores(most, { onBadLine: (line) => bad.push(line) })(String.fromCharCode(0x100))).toBe(true);
        expect(bad).toEqual([bomb]);
    });
});

describe("a path's matching is held to a budget [review 2]", () => {
    /** A path `depth` deep whose directories no other path shares, so nothing is cached. */
    const fresh = (tag, depth, name) => Array.from({ length: depth }, (_, k) => `${tag}_${k}${name}`).join("/");
    /** As many copies of `line` as one ignore file may hold. */
    const fullOf = (line) => {
        const n = Math.min(ignoreLib.IGNORE_FILE_MAX_RULES, Math.floor(ignoreLib.IGNORE_FILE_MAX_BYTES / (line.length + 1)));
        return `${line}\n`.repeat(n);
    };
    /** Milliseconds for one fresh path, decided or not, once the JIT has seen the shape. */
    const perPath = (rules, make) => {
        const once = (p) => {
            try {
                rules.match(p);
            } catch (err) {
                if (!(err instanceof ignoreLib.IgnoreBudgetError)) throw err;
            }
        };
        for (let i = 0; i < 20; i++) once(make(`w${i}`));
        const t0 = performance.now();
        for (let i = 0; i < 3; i++) once(make(`t${i}`));
        return (performance.now() - t0) / 3;
    };

    it("a path that would cost more than the budget is not decided, and says so", () => {
        const rules = ruleSystem({ ".vcsignore": "*a*b*c*\n".repeat(50) }, { budget: 5_000 });
        expect(() => rules.match(`${"a".repeat(200)}/x`)).toThrow(ignoreLib.IgnoreBudgetError);
        expect(rules.match("src/app.js")).toBe(false);
        expect(rules.match("abc")).toBe(true);
    });

    it.each([
        ["searched runs", `*${"a".repeat(20)}b*c`, (tag) => fresh(tag, 61, "a".repeat(240) + "c")],
        ["large classes", `*[${Array.from({ length: 63 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("")}]x*`, (tag) => fresh(tag, 61, "a".repeat(240))],
        ["POSIX classes", `*[[:upper:][:punct:][:space:]]x*`, (tag) => fresh(tag, 61, "a".repeat(240))],
        ["globstars", "**/*aab*/**/*aab*/**", (tag) => fresh(tag, 61, "a".repeat(240))],
        ["a run of stars", "*a*a*a*a*a*a*a*a*a*b", (tag) => fresh(tag, 61, "a".repeat(240))],
    ])("a full file of the heaviest line (%s) costs under 25ms a path 61 deep", (_label, line, make) => {
        const rules = ruleSystem({ ".vcsignore": fullOf(line) }, { ignoreCase: true });
        expect(perPath(rules, make)).toBeLessThan(25);
    }, 60_000);

    it("a file many sets of rules share is matched once per path, not once for each of them", () => {
        // The mount's ratchet asks every set of rules a directory has used;
        // a heavy file they all hold must not cost that many times over.
        const bank = ignoreLib.ruleBank({ ignoreCase: true });
        const heavy = `*${"a".repeat(8)}b*c\n`.repeat(100);
        const views = Array.from({ length: 30 }, (_, i) => {
            const v = bank.view();
            v.set(".gitignore", heavy);
            v.set(".git/info/exclude", `only-${i}\n`);
            return v;
        });
        const path = `src/${"a".repeat(100)}`;
        const one = bank.subject(path);
        views[0].excludes(one);
        const all = bank.subject(path);
        for (const v of views) v.excludes(all);
        expect(all.spent).toBeLessThan(2 * one.spent);
    });

    it("a rule under a directory's ** is tried once per directory, not once per pair of them", () => {
        // `web/**/report.[0-9]*…` is what a draft makes of a nested Node
        // .gitignore; tried afresh at every depth, one path 61 deep under
        // web/ cost the depth squared times the rule.
        const rules = ruleSystem({ ".vcsignore": "web/**/report.[0-9]*.[0-9]*.[0-9]*.[0-9]*.json\n" }, { ignoreCase: true, budget: 2_000_000 });
        const deep = `web/${fresh("d", 60, "report.1.2.3" + "9".repeat(200))}`;
        expect(rules.match(deep)).toBe(false);
        expect(rules.match(`web/${fresh("e", 30, "x")}/report.1.2.3.4.json`)).toBe(true);
    });
});

describe("git's syntax, in the corners [L8]", () => {
    it("reads a segment of three or more stars as **", () => {
        const match = m("***/secret.key");
        expect(match("secret.key")).toBe(true);
        expect(match("a/b/secret.key")).toBe(true);
    });

    it("keeps a leading space: ` !server.pem` is a pattern, not a negation", () => {
        const match = m("*.pem\n !server.pem\n");
        expect(match("server.pem")).toBe(true);
        expect(match(" !server.pem")).toBe(true);
    });

    it("strips only unescaped trailing spaces; `\\ ` is a space", () => {
        expect(m("foo\\ ")("foo ")).toBe(true);
        expect(m("foo\\ ")("foo\\")).toBe(false);
        expect(m("bar   ")("bar")).toBe(true);
        expect(m("baz\\  ")("baz ")).toBe(true);
    });

    it("skips a byte-order mark at the start of a file, as git does, on either kind of volume [review]", () => {
        // Windows editors save one. It became part of the first pattern, and
        // on a volume that does not fold case the first rule matched nothing.
        for (const ignoreCase of [false, true]) {
            const rules = ruleSystem({ ".gitignore": "\ufeffconfig/master.key\n*.pem\n" }, { ignoreCase });
            expect([ignoreCase, rules.match("config/master.key")]).toEqual([ignoreCase, true]);
        }
        expect(ignoreLib.ruleText("\ufeffa\r\nb\r\n")).toBe("a\nb");
        // Only at the start: anywhere else it is part of the pattern, in git too.
        expect(ruleSystem({ ".gitignore": "x\n\ufeffy\n" }).match("y")).toBe(false);
    });

    it("does not fold a character class on a case-sensitive volume", () => {
        expect(compileIgnores("[!A-Z]*.key", { ignoreCase: false })("server.key")).toBe(true);
        expect(compileIgnores("[A-Z]*.txt", { ignoreCase: false })("abc.txt")).toBe(false);
        expect(compileIgnores("[A-Z]*.txt", { ignoreCase: false })("Abc.txt")).toBe(true);
        expect(compileIgnores("[A-Z]*.txt", { ignoreCase: true })("abc.txt")).toBe(true);
    });
});

describe.skipIf(!hasGit)("agrees with git in the corners too [L8]", () => {
    const FILES = ["c.txt", "C.txt", "x.pem", "X.PEM", "a/c.txt", "a/b/x.pem", "b/a/c.txt", "sp ace", "sp", " lead", "a/B/c.txt"];
    const SEGS = ["a", "b", "B", "*", "**", "***", "c.txt", "*.pem", "[A-Z]*", "[!a-z]*", "sp\\ ace", "sp ", " lead", "?"];

    it("never excludes less than git, nor more, with core.ignorecase=false", async () => {
        let seed = 11;
        const rnd = (n) => {
            seed = (seed + 0x6d2b79f5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) % n;
        };
        const pat = () => {
            let p = Array.from({ length: 1 + rnd(2) }, () => SEGS[rnd(SEGS.length)]).join("/");
            if (rnd(5) === 0) p += "/";
            if (rnd(4) === 0) p = "!" + p;
            if (rnd(6) === 0) p = " " + p;
            return p;
        };
        const base = await mkdtemp(join(tmpdir(), "muhkoo-gitcorner-"));
        const disagreements = [];
        try {
            for (let it = 0; it < 60; it++) {
                const dir = join(base, String(it));
                await mkdir(dir, { recursive: true });
                execFileSync("git", ["init", "-q"], { cwd: dir });
                execFileSync("git", ["config", "core.ignorecase", "false"], { cwd: dir });
                const texts = { ".gitignore": (rnd(4) === 0 ? "\ufeff" : "") + Array.from({ length: 1 + rnd(3) }, pat).join("\n") + "\n" };
                for (const [rel, text] of Object.entries({ ...texts, ...Object.fromEntries(FILES.map((f) => [f, "x"])) })) {
                    await mkdir(dirname(join(dir, rel)), { recursive: true });
                    await writeFile(join(dir, rel), text);
                }
                const out = execFileSync("git", ["ls-files", "-o", "--exclude-standard", "-z"], { cwd: dir, encoding: "utf8" });
                const added = new Set(out.split("\0"));
                // Two spellings of one name cannot both exist on a folding
                // volume; compare only the files that are really there.
                const present = new Set(execFileSync("git", ["ls-files", "-o", "-z"], { cwd: dir, encoding: "utf8" }).split("\0"));
                const rules = ruleSystem(texts, { ignoreCase: false });
                for (const file of FILES) {
                    if (!present.has(file)) continue;
                    if (added.has(file) === !rules.match(file)) continue;
                    disagreements.push({ texts, file, git: added.has(file) ? "adds" : "ignores" });
                }
            }
        } finally {
            await rm(base, { recursive: true, force: true });
        }
        expect(disagreements.slice(0, 3)).toEqual([]);
    }, 60_000);
});
