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
 */
export async function openClient(args) {
  const cfg = await loadConfig();
  const baseUrl = await resolveBase(args, cfg);
  const token = args.token || process.env.MUHKOO_DEV_TOKEN || cfg.token;
  if (!token) die("Not signed in. Run `muhkoo login` first.");

  // Storing bytes is METERED, and the shard store attributes them to an app —
  // so a write needs an app key even though the filesystem is the user's own.
  // Reads do not, which is why ls and cat work with no app signed in at all.
  const apiKey = resolveAppKey(args, cfg);

  const Client = await loadClient();
  const client = new Client({
    baseUrl,
    apiKey,
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

  await unlock({ args, cfg, baseUrl, client });

  // Restore the working directory. A CLI is a fresh process each time, so `cd`
  // only means anything if it survives between invocations — the same reason a
  // shell keeps PWD. A directory that has since been deleted silently falls
  // back to the root rather than making every later command fail.
  if (cfg.vfsCwd && cfg.vfsCwd !== "/") {
    await client.vfs.cd(cfg.vfsCwd).catch(async () => {
      await saveConfig({ ...cfg, vfsCwd: "/" });
      info(`Working directory ${cfg.vfsCwd} is gone — back to /.`);
    });
  }
  return client;
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
        await saveConfig({ ...cfg, deviceFactorId: undefined, deviceKey: undefined });
        die(msg);
      }
      info(`Stored device key did not work (${msg}) — signing in to re-pair.`);
    }
  }

  await pairThisMachine({ args, cfg, baseUrl, client });
}

/** Sign in once, pair this machine, and unlock the passed client. */
async function pairThisMachine({ args, cfg, baseUrl, client }) {
  info("This machine is not paired yet — signing in once to pair it.");
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

  if (args.pair === false) {
    client.auth.zk.unlockWithSeed(seed);   // --no-pair: unlock now, store nothing
    return;
  }

  const label = deviceLabel();
  const { factorId, deviceKey } = await authed.auth.zk.enrollDevice(label);
  // `seed: undefined` clears a seed left by an older CLI — the whole point is
  // that it stops living on this disk.
  await saveConfig({ ...cfg, username, deviceFactorId: factorId, deviceKey, seed: undefined });
  client.auth.zk.unlockWithSeed(seed);
  info(`Paired this machine as "${label}". Revoke it any time: muhkoo devices rm ${factorId}`);
}

/** A name the owner will recognise in `muhkoo devices ls`. */
function deviceLabel() {
  return `${userInfo().username}@${hostname()}`;
}

/**
 * The key to write as, from `--key`, the environment, or the app signed in with
 * `muhkoo vfs use-app`.
 *
 * Absent is a legitimate state, not an error: reads work without one, so this
 * returns undefined and lets the write itself fail with an explanation.
 */
function resolveAppKey(args, cfg) {
  if (args.key) return args.key;
  if (process.env.MUHKOO_APP_KEY) return process.env.MUHKOO_APP_KEY;
  const slug = args.app || cfg.vfsApp;
  if (!slug) return undefined;
  return (cfg.vfsApps ?? {})[slug];
}

/**
 * Turn the shard store's 401 into an instruction.
 *
 * "API key required to store shards" is accurate and useless — it names a
 * concept the person at the terminal has no reason to know, and says nothing
 * about what to do next.
 */
export function explainWriteFailure(err, cfg) {
  const msg = err?.message ?? String(err);
  if (!/API key required|store shards|401/.test(msg)) return msg;
  const known = Object.keys(cfg?.vfsApps ?? {});
  return (
    "Writing stores bytes, which are metered to an app — so a write needs one signed in.\n" +
    (known.length
      ? `Try: muhkoo vfs use-app ${known[0]}`
      : "Sign one in with: muhkoo vfs use-app <slug> --key <appKey>\n" +
        "App keys are shown when an app is created (muhkoo apps create).")
  );
}
