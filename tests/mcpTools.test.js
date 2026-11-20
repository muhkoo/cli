/**
 * The MCP tool table: names, safety markings, inputs and the command line
 * each call becomes.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { TOOLS, TOOL_BY_NAME } from "../src/mcp/tools.js";

const DESTRUCTIVE = [
    "promote", "apps_rm", "tables_rm", "vectors_rm", "agents_rm", "functions_rm", "domains_rm", "vfs_rm",
    "tokens_revoke", "devices_rm", "keys_rotate", "vfs_restore", "vfs_sweep", "vfs_rehome", "tokens_create",
    "functions_deploy", "hosting_rollback", "hosting_rm_release", "hosting_unpublish", "vcs_restore", "vcs_checkout",
    "provision", "agents_enable", "agents_disable", "functions_enable", "functions_disable", "vectors_notices", "vfs_get",
];
const READ_ONLY = /_(ls|get|stat|cat|tree|find|history|status|log|show|diff|code|models|query|slug)$/;

const tool = (name) => TOOL_BY_NAME.get(name);
const parse = (name, input) => z.object(tool(name).input).safeParse(input);
const localPathFields = (t) =>
    Object.entries(t.input).filter(([, schema]) => {
        const probe = z.object({ x: schema }).safeParse({ x: "relative/path" });
        const probeArr = z.object({ x: schema }).safeParse({ x: ["relative/path"] });
        return [probe, probeArr].some((p) => !p.success && p.error.issues.some((i) => /must be an absolute path/.test(i.message)));
    });

describe("tool table", () => {
    it("names are unique snake_case", () => {
        const names = TOOLS.map((t) => t.name);
        expect(new Set(names).size).toBe(names.length);
        for (const n of names) expect(n).toMatch(/^[a-z_]+$/);
    });

    it("marks every production-reaching or deleting tool destructive", () => {
        for (const name of DESTRUCTIVE) {
            expect(tool(name), name).toBeDefined();
            expect(tool(name).annotations.destructiveHint, name).toBe(true);
            expect(tool(name).annotations.readOnlyHint, name).toBe(false);
        }
    });

    it("deploy publishes to test and is not destructive", () => {
        expect(tool("deploy").annotations.destructiveHint).toBe(false);
    });

    it("every tool that is neither read-only nor listed destructive says destructiveHint: false explicitly", () => {
        for (const t of TOOLS) {
            if (t.annotations.readOnlyHint || DESTRUCTIVE.includes(t.name)) continue;
            expect(t.annotations.destructiveHint, t.name).toBe(false);
        }
    });

    it("listings and reads are read-only, plus whoami and logs", () => {
        // vfs_get matches the pattern but writes a local file, so the local-files rule wins.
        const reads = TOOLS.filter((t) => READ_ONLY.test(t.name) && !localPathFields(t).length).map((t) => t.name).concat(["whoami", "logs"]);
        expect(reads).not.toContain("vfs_get");
        for (const name of reads) expect(tool(name).annotations.readOnlyHint, name).toBe(true);
    });

    it("no tool that touches local files is read-only", () => {
        for (const t of TOOLS) {
            if (localPathFields(t).length) expect(t.annotations.readOnlyHint, t.name).toBe(false);
        }
    });

    it("only login takes a base", () => {
        for (const t of TOOLS) if (t.name !== "login") expect(Object.keys(t.input), t.name).not.toContain("base");
        expect(Object.keys(tool("login").input)).toContain("base");
    });

    it("long-running tools get long timeouts", () => {
        expect(tool("login").timeoutMs).toBe(5 * 60_000);
        for (const name of ["deploy", "vfs_import", "provision"]) expect(tool(name).timeoutMs, name).toBe(10 * 60_000);
        expect(tool("apps_ls").timeoutMs).toBeUndefined();
    });
});

describe("command lines", () => {
    it("deploy runs in the project folder", () => {
        const t = tool("deploy");
        expect(t.argv({ projectDir: "/p" })).toEqual(["deploy"]);
        expect(t.cwd({ projectDir: "/p" })).toBe("/p");
        expect(t.argv({ projectDir: "/p", dist: "build", noFilesystem: true })).toEqual(["deploy", "--dist", "build", "--no-vfs"]);
    });

    it("filesystem listings", () => {
        expect(tool("vfs_ls").argv({ path: "/apps" })).toEqual(["vfs", "ls", "/apps"]);
        expect(tool("vfs_ls").argv({})).toEqual(["vfs", "ls", "/"]);
        expect(tool("vfs_rm").argv({ path: "/a", recursive: true })).toEqual(["vfs", "rm", "/a", "-r"]);
    });

    it("tokens and login", () => {
        expect(tool("tokens_create").argv({ appId: "a", scopes: ["db:read"] })).toEqual(["tokens", "create", "a", "--scopes", "db:read"]);
        expect(tool("login").argv({ base: "staging" })).toEqual(["login", "--web", "--base", "staging"]);
        expect(tool("login").argv({})).toEqual(["login", "--web"]);
    });

    it("vcs always names the project", () => {
        expect(tool("vcs_commit").argv({ project: "todo", message: "first" })).toEqual(["vcs", "commit", "--project", "todo", "-m", "first"]);
        expect(tool("vcs_log").argv({ project: "todo", count: 5 })).toEqual(["vcs", "log", "--project", "todo", "-n", "5"]);
    });

    it("vfs ignore never sends a bare --accept", () => {
        expect(tool("vfs_ignore").argv({ dir: "/p" })).toEqual(["vfs", "ignore", "/p"]);
        expect(tool("vfs_ignore").argv({ dir: "/p", acceptDigest: "abc" })).toEqual(["vfs", "ignore", "/p", "--accept", "abc"]);
    });
});

describe("inputs", () => {
    it("rejects relative and ~ local paths", () => {
        for (const projectDir of ["rel/dir", "~/x", "./x"]) {
            const r = parse("deploy", { projectDir });
            expect(r.success, projectDir).toBe(false);
            expect(r.error.issues[0].message).toBe("projectDir must be an absolute path");
        }
        expect(parse("deploy", { projectDir: "/Users/me/app" }).success).toBe(true);
        expect(parse("vfs_import", { dirs: ["/a", "b"] }).success).toBe(false);
    });

    it("filesystem paths must start with /", () => {
        expect(parse("vfs_cat", { path: "apps/x" }).success).toBe(false);
        expect(parse("vfs_cat", { path: "/apps/x" }).success).toBe(true);
    });
});

describe("review fixes", () => {
    it("C-1: refuses any argument that looks like a flag", async () => {
        const { flagLikeArgument } = await import("../src/mcp/tools.js");
        expect(flagLikeArgument({ appId: "--base", table: "https://evil.example" })).toBe("appId");
        expect(flagLikeArgument({ project: "p", message: "-v" })).toBe("message");
        expect(flagLikeArgument({ scopes: ["db:read", "--base"] })).toBe("scopes");
        expect(flagLikeArgument({ path: "/apps/x", count: 3 })).toBeNull();
    });

    it("I-2/I-3: provision, live-affecting toggles and vfs_get are destructive", () => {
        for (const name of ["provision", "agents_enable", "agents_disable", "functions_enable", "functions_disable", "vectors_notices", "vfs_get"]) {
            expect(tool(name).annotations.destructiveHint, name).toBe(true);
        }
    });

    it("I-4: login only signs in to prod or staging", () => {
        expect(parse("login", { base: "https://evil.example" }).success).toBe(false);
        expect(parse("login", { base: "staging" }).success).toBe(true);
    });

    it("I-5: vectors_query is excluded (it needs an app key the server won't take)", async () => {
        const { EXCLUDED } = await import("../src/mcp/tools.js");
        expect(tool("vectors_query")).toBeUndefined();
        expect(EXCLUDED["vectors query"]).toMatch(/app key/);
    });
});
