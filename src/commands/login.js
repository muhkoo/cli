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
import { prompt, promptHidden, ok, step, info, die, c } from "../lib/ui.js";

export const help = `muhkoo login — sign in as a developer

Usage:
  muhkoo login --web [--base <env|url>]                 sign in via the browser
  muhkoo login [--username <u>] [--password <p>] [--base <env|url>]
  muhkoo login --token <sessionToken> [--base <env|url>]

--web opens auth.muhkoo.dev in your browser (password, passkey, or Google) and
captures the session over a localhost redirect — no credentials touch the CLI.
Otherwise credentials are read from flags, then $MUHKOO_USERNAME/$MUHKOO_PASSWORD,
then a prompt. The session token is saved to ~/.muhkoo/config.json.`;

export default async function login(args) {
  const cfg = await loadConfig();
  const baseUrl = await resolveBase(args, cfg);

  let token = args.token || process.env.MUHKOO_DEV_TOKEN;
  let username = args.username || process.env.MUHKOO_USERNAME;
  let commitment;

  if (!token && (args.web || args.browser)) {
    const appId = firstOf(args["app-id"], process.env.MUHKOO_CLI_APP_ID, cfg.cliAppId, DEFAULT_CLI_APP_ID);
    const res = await webLogin({ baseUrl, appId });
    token = res.token;
    commitment = res.commitment;
    username = res.username;
  } else if (!token) {
    if (!username) username = await prompt("Username: ");
    let password = args.password || process.env.MUHKOO_PASSWORD;
    if (!password) password = await promptHidden("Password: ");
    if (!username || !password) die("A username and password are required.");
    const res = await zkLogin({ baseUrl, username, password });
    token = res.token;
    commitment = res.commitment;
    username = res.username;
  }

  // Confirm the token works and surface the developer's status.
  step("Verifying session…");
  const me = await devCall({ baseUrl, token }, "GET", "/api/developer/me");
  if (!me.ok && me.status === 401) die("That session token is invalid or expired.");

  await saveConfig({ ...cfg, base: baseUrl, token, username, commitment });
  ok(`Signed in${username ? ` as ${c.bold(username)}` : ""} → ${baseUrl}`);
  if (me.ok && me.body?.needsBootstrap) {
    info(
      `\n${c.yellow("Note:")} your developer account isn't set up yet. Run ` +
        `\`muhkoo apps create --slug <name> --email you@example.com\` to bootstrap it.`,
    );
  } else if (me.ok && me.body?.tier) {
    info(`  plan: ${me.body.tier}`);
  }
}
