/**
 * Secrets never reach a conversation. A tool that creates one saves it to an
 * owner-only file and hands back the path and a masked prefix.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealSecrets, scrub, SECRET_PATTERNS } from "../src/mcp/secrets.js";

const SK = "mk_test_sk_" + "A1b2C3d4".repeat(4);
const LIVE_SK = "mk_live_sk_" + "Z9y8X7w6".repeat(4);
const PK = "mk_test_pk_" + "p".repeat(24);
const AT = "mk_live_at_" + "t0k3n".repeat(6);
const SESSION = "f".repeat(64);

const leaks = (value) => SECRET_PATTERNS.some((re) => re.test(JSON.stringify(value)));

let secretsDir;
beforeEach(async () => {
    secretsDir = join(await mkdtemp(join(tmpdir(), "mcp-secrets-")), "secrets");
});

const created = () => ({
    appId: "app1",
    slug: "todo",
    keys: [
        { env: "test", type: "pk", plaintext: PK },
        { env: "test", type: "sk", plaintext: SK },
        { env: "live", type: "sk", plaintext: LIVE_SK },
    ],
});

describe("sealSecrets", () => {
    it("moves sk keys to an owner-only file and keeps pk keys", async () => {
        const result = await sealSecrets("apps_create", created(), { secretsDir });
        expect(result.keys[0].plaintext).toBe(PK);
        const sk = result.keys[1];
        expect(sk.plaintext).toBeUndefined();
        expect(sk.masked).toBe(SK.slice(0, 11) + "…");
        expect(sk.savedTo).toBe(join(secretsDir, "app1-keys.json"));
        const file = await stat(sk.savedTo);
        expect(file.mode & 0o777).toBe(0o600);
        expect((await stat(secretsDir)).mode & 0o777).toBe(0o700);
        const saved = JSON.parse(await readFile(sk.savedTo, "utf8"));
        expect(saved.keys.map((k) => k.plaintext)).toEqual([PK, SK, LIVE_SK]);
        expect(leaks(result)).toBe(false);
    });

    it("updates the project's .muhkoo-app.json when there is one", async () => {
        const projectDir = await mkdtemp(join(tmpdir(), "mcp-proj-"));
        const recordPath = join(projectDir, ".muhkoo-app.json");
        await writeFile(recordPath, JSON.stringify({ appId: "app1", slug: "todo", keys: [{ env: "test", type: "sk", plaintext: "mk_test_sk_old" }] }));
        const result = await sealSecrets("keys_rotate", created(), { projectDir, secretsDir });
        expect(result.keys[1].savedTo).toBe(recordPath);
        const record = JSON.parse(await readFile(recordPath, "utf8"));
        expect(record.slug).toBe("todo");
        expect(record.keys.find((k) => k.type === "sk" && k.env === "test").plaintext).toBe(SK);
        expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
    });

    it("provision's record already holds the keys: just mask them", async () => {
        const projectDir = await mkdtemp(join(tmpdir(), "mcp-prov-"));
        const recordPath = join(projectDir, ".muhkoo-app.json");
        await writeFile(recordPath, JSON.stringify(created()));
        const result = await sealSecrets("provision", { ...created(), recordPath }, { projectDir, secretsDir });
        expect(result.keys[1].savedTo).toBe(recordPath);
        expect(leaks(result)).toBe(false);
    });

    it("saves a new access token to its own file", async () => {
        const result = await sealSecrets("tokens_create", { keyId: "k_42", env: "live", scopes: ["db:read"], plaintext: AT }, { secretsDir });
        expect(result.plaintext).toBeUndefined();
        expect(result.savedTo).toBe(join(secretsDir, "token-k_42.txt"));
        expect((await readFile(result.savedTo, "utf8")).trim()).toBe(AT);
        expect((await stat(result.savedTo)).mode & 0o777).toBe(0o600);
        expect(result.scopes).toEqual(["db:read"]);
        expect(leaks(result)).toBe(false);
    });

    it("leaves results without secrets alone", async () => {
        const data = { apps: [{ appId: "a", slug: "b" }] };
        expect(await sealSecrets("apps_ls", data, { secretsDir })).toEqual(data);
    });
});

describe("scrub", () => {
    it("masks secret keys and known credentials anywhere, but not content hashes", () => {
        const sha = "a".repeat(64);
        const out = scrub(
            { error: `bad key ${SK} and ${AT}`, nested: [{ token: "whatever", deviceKey: "dk", commit: sha }], note: `session ${SESSION}` },
            { known: [SESSION] },
        );
        expect(leaks(out)).toBe(false);
        expect(JSON.stringify(out)).not.toContain(SESSION);
        expect(out.nested[0].token).toBe("[redacted]");
        expect(out.nested[0].deviceKey).toBe("[redacted]");
        expect(out.nested[0].commit).toBe(sha);
    });
});
