/**
 * `muhkoo --help` is where people find commands, so it must not fall behind
 * the commands themselves. It did: `vfs mount`, `vfs import` and `vfs ignore`
 * — the commands that write to your disk — were not listed at all.
 *
 * Runs the real binary, with its own HOME, and compares against each command's
 * own help rather than a copy of the list, so the next command added to one and
 * not the other fails here — in either direction, so a stale or misspelled
 * name in the top-level help fails too. Both are checked against the
 * subcommands the source actually dispatches.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(cliRoot, "bin", "muhkoo.js");

function run(...args) {
    const home = mkdtempSync(join(tmpdir(), "muhkoo-help-home-"));
    try {
        return execFileSync(process.execPath, [bin, ...args], { env: { ...process.env, HOME: home, NO_COLOR: "1" } }).toString();
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
}

/** Subcommands a command's own help documents: every `muhkoo <cmd> <sub>` line. */
const documented = (help, cmd) => new Set([...help.matchAll(new RegExp(`^\\s+muhkoo ${cmd} ([a-z-]+)`, "gm"))].map((m) => m[1]));
/** Subcommands the top-level help lists: its `<cmd> a|b|c` lines. */
const listed = (top, cmd) => new Set([...top.matchAll(new RegExp(`^\\s+${cmd} ([a-z|-]+)`, "gm"))].flatMap((m) => m[1].split("|")));
/**
 * Subcommands the command's source dispatches: its `case "…":` labels, and a
 * `sub === "…"` handled before the switch. Aliases are not documented.
 */
const ALIASES = { vfs: ["push"], vcs: [], kv: [] };
const implemented = (cmd) => {
    const src = readFileSync(join(cliRoot, "src", "commands", `${cmd}.js`), "utf8");
    const names = [...src.matchAll(/case "([a-z-]+)":/g), ...src.matchAll(/sub === "([a-z-]+)"/g)].map((m) => m[1]);
    return new Set(names.filter((n) => !ALIASES[cmd].includes(n)));
};
const minus = (a, b) => [...a].filter((x) => !b.has(x)).sort();

describe("muhkoo --help", () => {
    const top = run("--help");

    for (const cmd of ["vfs", "vcs"]) {
        it(`lists every ${cmd} subcommand that \`muhkoo ${cmd} --help\` documents`, () => {
            const want = documented(run(cmd, "--help"), cmd);
            expect(want.size).toBeGreaterThan(5);
            const have = listed(top, cmd);
            expect(minus(want, have)).toEqual([]);
        });

        it(`lists no ${cmd} subcommand that \`muhkoo ${cmd} --help\` does not document`, () => {
            const want = documented(run(cmd, "--help"), cmd);
            const have = listed(top, cmd);
            expect(have.size).toBeGreaterThan(5);
            expect(minus(have, want)).toEqual([]);
        });

        it(`documents exactly the ${cmd} subcommands the command implements`, () => {
            const code = implemented(cmd);
            const want = documented(run(cmd, "--help"), cmd);
            expect(code.size).toBeGreaterThan(5);
            expect({ undocumented: minus(code, want), unimplemented: minus(want, code) }).toEqual({ undocumented: [], unimplemented: [] });
        });
    }

    it("lists `kv ls`, which `muhkoo kv --help` documents and kv.js implements", () => {
        expect([...documented(run("kv", "--help"), "kv")]).toEqual(["ls"]);
        expect([...listed(top, "kv")]).toEqual(["ls"]);
        expect([...implemented("kv")]).toEqual(["ls"]);
    });
});
