/**
 * `muhkoo login` — authenticate as a developer and store the session token in
 * `~/.muhkoo/config.json`. Uses the zero-knowledge login (username + password
 * are never sent to the server). You can also paste a token from the portal.
 */

import { resolveBase, loadConfig, saveConfig } from "../lib/config.js";
import { zkLogin } from "../lib/auth.js";
import { webLogin, DEFAULT_CLI_APP_ID } from "../lib/webLogin.js";
import { devCall } from "../lib/http.js";
import { firstOf } from "../lib/args.js";
import { pairWithSeed } from "../lib/vfs.js";
import { prompt, promptHidden, ok, step, info, die, c, json } from "../lib/ui.js";

export const help = `muhkoo login — sign in as a developer

Usage:
  muhkoo login --web [--base <env|url>]                 sign in via the browser
  muhkoo login [--username <u>] [--password <p>] [--base <env|url>]
  muhkoo login --token <sessionToken> [--base <env|url>]

Options:
  --no-pair   sign in without pairing this machine (later VFS commands will ask)

--web opens auth.muhkoo.dev in your browser (password, passkey, or Google) and
captures the session over a localhost redirect — no credentials touch the CLI.
Otherwise credentials are read from flags, then $MUHKOO_USERNAME/$MUHKOO_PASSWORD,
then a prompt. The session token is saved to ~/.muhkoo/config.json.

Signing in also pairs this machine, so "muhkoo vfs" and deploys need no password
afterwards. Revoke the pairing any time with: muhkoo devices rm <id>`;

export default async function login(args) {
  const cfg = await loadConfig();
  const baseUrl = await resolveBase(args, cfg);

  let token = args.token || process.env.MUHKOO_DEV_TOKEN;
  let username = args.username || process.env.MUHKOO_USERNAME;
  let commitment;
  let seed = null;

  if (!token && (args.web || args.browser)) {
    const appId = firstOf(args["app-id"], process.env.MUHKOO_CLI_APP_ID, cfg.cliAppId, DEFAULT_CLI_APP_ID);
    const res = await webLogin({ baseUrl, appId });
    token = res.token;
    commitment = res.commitment;
    username = res.username;
    seed = res.seed ?? null;
  } else if (!token) {
    if (!username) username = await prompt("Username: ");
    let password = args.password || process.env.MUHKOO_PASSWORD;
    if (!password) password = await promptHidden("Password: ");
    if (!username || !password) die("A username and password are required.");
    const res = await zkLogin({ baseUrl, username, password });
    token = res.token;
    commitment = res.commitment;
    username = res.username;
    seed = res.seed ?? null;
  }

  // Confirm the token works and surface the developer's status.
  step("Verifying session…");
  const me = await devCall({ baseUrl, token }, "GET", "/api/developer/me");
  if (!me.ok && me.status === 401) die("That session token is invalid or expired.");

  // `seed: undefined` clears a seed an older CLI left on disk. A pairing made
  // for another user or base is dropped here too: if no new pairing follows
  // (--no-pair, --token, no seed, a failed pairing), the next VFS command must
  // not unlock with the previous user's device key.
  const pairingIsOurs = cfg.username === username && cfg.base === baseUrl;
  const pairing = pairingIsOurs ? {} : { deviceFactorId: undefined, deviceKey: undefined };
  await saveConfig({ ...cfg, ...pairing, base: baseUrl, token, username, commitment, seed: undefined });
  ok(`Signed in${username ? ` as ${c.bold(username)}` : ""} → ${baseUrl}`);
  let paired = false;
  let deviceFactorId;
  if (!args["no-pair"] && args.pair !== false && !args.token && !process.env.MUHKOO_DEV_TOKEN) {
    const alreadyPaired = cfg.deviceFactorId && cfg.deviceKey && cfg.username === username && cfg.base === baseUrl;
    if (alreadyPaired) {
      info("This machine is already paired.");
      paired = true;
      deviceFactorId = cfg.deviceFactorId;
    } else if (seed) {
      try {
        const made = await pairWithSeed({ cfg: await loadConfig(), baseUrl, token, username, commitment, seed });
        info(`Paired this machine as "${made.label}". Revoke it any time: muhkoo devices rm ${made.factorId}`);
        paired = true;
        deviceFactorId = made.factorId;
      } catch (err) {
        info(
          `Signed in, but pairing this machine failed: ${err?.message ?? err}. ` +
            "Run `muhkoo vfs ls` once to pair it.",
        );
      }
    } else {
      info(
        "Signed in, but this machine is not paired (the browser did not hand over the unlock key). " +
          "Run `muhkoo vfs ls` once in a terminal to pair it.",
      );
    }
  }
  if (me.ok && me.body?.needsBootstrap) {
    info(
      "",
      `${c.yellow("Note:")} your developer account isn't set up yet. Run ` +
        `\`muhkoo apps create --slug <name> --email you@example.com\` to bootstrap it.`,
    );
  } else if (me.ok && me.body?.tier) {
    info(`  plan: ${me.body.tier}`);
  }
  // Never the session token: this result is read by programs, the MCP
  // server among them, and from there by a model.
  if (args.json) json({ base: baseUrl, username, paired, ...(deviceFactorId ? { deviceFactorId } : {}) });
}
