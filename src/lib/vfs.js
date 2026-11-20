/**
 * Open `client.vfs` for the CLI.
 *
 * Uses the SDK, not raw HTTP, on purpose: the filesystem's on-disk format is
 * encrypted directory records with keys chained from parent to child, and a
 * second implementation over HTTP would be a second thing to keep byte-exact.
 * `muhkoo vfs ls` and the IDE's file tree run the SAME code.
 *
 * Two things are needed: a SESSION (to authenticate the calls) and the master
 * SEED (to derive the root key that decrypts the records). The session comes
 * from `muhkoo login`; the seed comes from the stored key, or from a password
 * prompt when there is none.
 */

import { hostname, userInfo } from "node:os";

import { loadConfig, resolveBase, saveConfig } from "./config.js";
import { loadClient, downloadCircuits } from "./auth.js";
import { die, info, step, prompt, promptHidden } from "./ui.js";

/**
 * Build a Client whose session and identity are both established.
 *
 * Returns the client so callers can reach `client.vfs` — and anything else the
 * SDK offers — rather than a narrow wrapper that would drift from it.
 *
 * `args.readOnly` (a dry run) saves nothing to ~/.muhkoo: no pairing, no reset
 * of a stale working directory, and a revoked pairing is reported but left for
 * the next ordinary command to forget. `--no-pair` (or `pair: false`) skips the
 * pairing alone, unlocking for this command only.
 */
export async function openClient(args) {
  const { cfg, baseUrl, client } = await restoreSession(args);
  requireFilesystemSdk(client);

  await unlock({ args, cfg, baseUrl, client });

  // Restore the working directory. A CLI is a fresh process each time, so `cd`
  // only means anything if it survives between invocations — the same reason a
  // shell keeps PWD. A directory that has since been deleted silently falls
  // back to the root rather than making every later command fail.
  if (cfg.vfsCwd && cfg.vfsCwd !== "/") {
    await client.vfs.cd(cfg.vfsCwd).catch(async () => {
      if (!args.readOnly) await saveConfig({ ...cfg, vfsCwd: "/" });
      info(`Working directory ${cfg.vfsCwd} is gone — back to /.`);
    });
  }
  return client;
}

/**
 * The VFS commands open a Client with no app key, which only an SDK that bills
 * the filesystem to the signed-in account supports (`@muhkoo/connect`
 * 0.15.0-alpha.15, the release that added `vfs.rehome`). An older SDK would
 * fail on the first write with a confusing "API key required", so stop here.
 */
function requireFilesystemSdk(client) {
  if (typeof client?.vfs?.rehome !== "function") {
    die("This CLI needs @muhkoo/connect 0.15.0-alpha.15 or newer — reinstall the CLI.");
  }
}

/**
 * A Client with the session restored and NOTHING unlocked, for commands that
 * only name things (`kv ls`) and never decrypt a value. Unlocking would ask for
 * a password, or pair this machine, for nothing. Saves nothing to ~/.muhkoo.
 */
export async function openSession(args) {
  return (await restoreSession(args)).client;
}

/** The Client both of the above start from: signed in, session verified, not unlocked. */
async function restoreSession(args) {
  const cfg = await loadConfig();
  const baseUrl = await resolveBase(args, cfg);
  const token = args.token || process.env.MUHKOO_DEV_TOKEN || cfg.token;
  if (!token) die("Not signed in. Run `muhkoo login` first.");

  // No app key: the filesystem is the signed-in user's own, and its storage is
  // billed to their account. The session below is all a read or a write needs.
  const Client = await loadClient();
  const client = new Client({
    baseUrl,
    // Hand the SDK the session we already hold instead of logging in again.
    sessionStore: {
      load: () => ({ token, username: cfg.username ?? "", commitment: cfg.commitment ?? "" }),
      save: () => {},
      clear: () => {},
    },
  });

  // Hydrate the session from the store BEFORE unlocking. `SessionState` loads
  // its store asynchronously, so a freshly-constructed client has no commitment
  // yet — and every personal-space call is addressed by commitment, so they all
  // fail with "no session" until this runs. It also verifies the token, so an
  // expired one says so here instead of surfacing later as a confusing
  // filesystem error. Ordering matters: a failed verify clears session state,
  // which would wipe a seed we had already put there.
  const user = await client.auth.zk.restore();
  if (!user) die("Your session has expired. Run `muhkoo login` and try again.");
  return { cfg, baseUrl, client };
}

/**
 * Unlock the client's encryption identity.
 *
 * Prefers this machine's DEVICE PAIRING: the vault holds the master seed
 * wrapped under a key that exists only here, so nothing on this disk IS the
 * seed, and the pairing can be withdrawn from anywhere (`muhkoo devices rm`) —
 * which a stored seed never could be, because nothing can reach out and
 * un-store it.
 *
 * With no pairing, signs in once and pairs. `MUHKOO_SEED` stays supported for
 * CI, where there is no interactive login to pair with.
 */
async function unlock({ args, cfg, baseUrl, client }) {
  if (process.env.MUHKOO_SEED) {
    client.auth.zk.unlockWithSeed(process.env.MUHKOO_SEED);
    return;
  }

  if (cfg.deviceFactorId && cfg.deviceKey && cfg.username) {
    try {
      await client.auth.zk.unlockWithDevice(cfg.username, cfg.deviceFactorId, cfg.deviceKey);
      return;
    } catch (err) {
      const msg = err?.message ?? String(err);
      // A REVOKED pairing is not something to retry through. Falling back to a
      // password prompt would quietly re-pair a machine whose access was
      // deliberately withdrawn.
      if (/revoked|no longer paired/i.test(msg)) {
        if (!args.readOnly) await saveConfig({ ...cfg, deviceFactorId: undefined, deviceKey: undefined });
        die(msg);
      }
      info(`Stored device key did not work (${msg}) — signing in${pairs(args) ? " to re-pair" : " for this command only"}.`);
    }
  }

  await pairThisMachine({ args, cfg, baseUrl, client });
}

/**
 * Sign in once, pair this machine, and unlock the passed client — or, with
 * `--no-pair` or read-only, sign in and unlock for this command alone.
 */
async function pairThisMachine({ args, cfg, baseUrl, client }) {
  const pairing = pairs(args);
  info(
    pairing
      ? "This machine is not paired yet — signing in once to pair it."
      : "This machine is not paired — signing in for this command only; nothing is stored.",
  );
  const username = args.username || cfg.username || (await prompt("Username: "));
  const password = args.password || process.env.MUHKOO_PASSWORD || (await promptHidden("Password: "));
  if (!username || !password) die("A username and password are required to pair this machine.");

  step("Fetching ZK circuit assets…");
  const circuits = await downloadCircuits(baseUrl);
  const Client = await loadClient();
  step("Proving identity…");
  const authed = new Client({ baseUrl, circuits });
  await authed.auth.zk.login(username, password);

  const seed = authed.auth.zk.seedBase64;
  if (!seed) die("Signed in, but no encryption key was recovered — the account may have no password factor.");

  if (!pairing) {
    client.auth.zk.unlockWithSeed(seed);   // unlock now, store nothing
    return;
  }

  const { factorId, label } = await pairWithSeed({ cfg, baseUrl, username, seed, client: authed });
  client.auth.zk.unlockWithSeed(seed);
  info(`Paired this machine as "${label}". Revoke it any time: muhkoo devices rm ${factorId}`);
}

/**
 * Pair this machine from a seed already in hand (the browser login hands one
 * over): enrol a device factor and save its key, so no later command asks for a
 * password. Needs only the session and the seed — `enrollDevice` wraps the seed
 * under a fresh local key and puts it in the vault, with no ZK proof.
 *
 * `client` is for a caller that already holds a signed-in Client; otherwise one
 * is built over the stored session.
 */
export async function pairWithSeed({ cfg, baseUrl, token, username, commitment, seed, client }) {
  if (!client) {
    const Client = await loadClient();
    client = new Client({
      baseUrl,
      sessionStore: {
        load: () => ({ token, username: username ?? "", commitment: commitment ?? "" }),
        save: () => {},
        clear: () => {},
      },
    });
    const user = await client.auth.zk.restore();
    if (!user) throw new Error("Your session has expired. Run `muhkoo login` and try again.");
    client.auth.zk.unlockWithSeed(seed);
  }
  const label = deviceLabel();
  const { factorId, deviceKey } = await client.auth.zk.enrollDevice(label);
  // `seed: undefined` clears a seed left by an older CLI — the whole point is
  // that it stops living on this disk.
  await saveConfig({ ...cfg, username, deviceFactorId: factorId, deviceKey, seed: undefined });
  return { factorId, label };
}

/**
 * Does this command pair a machine that is not paired? Not with `--no-pair`,
 * and not read-only. The parser hands `--no-pair` over as `"no-pair": true`
 * (or the word after it); only `pair: false` was ever read, so the flag did
 * nothing.
 */
function pairs(args) {
  return args.pair !== false && !args["no-pair"] && !args.readOnly;
}

/** A name the owner will recognise in `muhkoo devices ls`. */
function deviceLabel() {
  return `${userInfo().username}@${hostname()}`;
}
