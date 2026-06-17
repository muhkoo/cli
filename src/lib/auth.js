/**
 * Programmatic developer auth. Uses `@muhkoo/connect` to run the zero-knowledge
 * login and returns the issued session token. The SDK is imported lazily so the
 * rest of the CLI (provision/deploy/etc., which only need a token) works even
 * when the SDK or its prover isn't installed.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { die, step } from "./ui.js";

/**
 * Download the ZK login circuit assets (wasm + zkey) to a temp dir and return
 * local file paths — in Node the prover reads them off disk, not over HTTP.
 */
async function downloadCircuits(baseUrl) {
  const dir = await mkdtemp(join(tmpdir(), "muhkoo-circuits-"));
  const fetchTo = async (path, file) => {
    const res = await fetch(baseUrl + path);
    if (!res.ok) die(`Could not fetch circuit asset ${path} (${res.status}).`);
    const out = join(dir, file);
    await writeFile(out, Buffer.from(await res.arrayBuffer()));
    return out;
  };
  const [wasmUrl, zkeyUrl] = await Promise.all([
    fetchTo("/circuits/build/preimagePoK_js/preimagePoK.wasm", "preimagePoK.wasm"),
    fetchTo("/circuits/build/preimagePoK_0001.zkey", "preimagePoK_0001.zkey"),
  ]);
  return { wasmUrl, zkeyUrl };
}

/** Resolve `@muhkoo/connect`'s `Client` from the CLI's own dependencies. */
async function loadClient() {
  try {
    const mod = await import("@muhkoo/connect");
    if (!mod.Client) throw new Error("Client export missing");
    return mod.Client;
  } catch (e) {
    die(
      "Couldn't load @muhkoo/connect for programmatic login.\n" +
        "  Reinstall the CLI, or sign in via the portal and pass --token instead.\n" +
        `  Underlying error: ${e?.message || e}`,
    );
  }
}

/**
 * Run a zero-knowledge login and return `{ token, commitment, username }`.
 * Throws (via `die`) on failure.
 */
export async function zkLogin({ baseUrl, username, password }) {
  const Client = await loadClient();
  step("Fetching ZK circuit assets…");
  const circuits = await downloadCircuits(baseUrl);
  step("Proving identity…");
  const client = new Client({ baseUrl, circuits });
  const user = await client.auth.zk.login(username, password);
  const token = client.auth.zk.token;
  if (!token) die("Login succeeded but no session token was issued.");
  return { token, commitment: user?.commitment, username: user?.username ?? username };
}
