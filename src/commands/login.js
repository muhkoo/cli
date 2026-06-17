/**
 * `muhkoo login` — authenticate as a developer and store the session token in
 * `~/.muhkoo/config.json`. Uses the zero-knowledge login (username + password
 * are never sent to the server). You can also paste a token from the portal.
 */

import { resolveBase, loadConfig, saveConfig } from "../lib/config.js";
import { zkLogin } from "../lib/auth.js";
import { devCall } from "../lib/http.js";
import { prompt, promptHidden, ok, step, info, die, c } from "../lib/ui.js";

export const help = `muhkoo login — sign in as a developer

Usage:
  muhkoo login [--username <u>] [--password <p>] [--base <env|url>]
  muhkoo login --token <sessionToken> [--base <env|url>]

Credentials are read from flags, then $MUHKOO_USERNAME/$MUHKOO_PASSWORD, then
an interactive prompt. The resulting session token is saved to ~/.muhkoo/config.json.`;

export default async function login(args) {
  const cfg = await loadConfig();
  const baseUrl = await resolveBase(args, cfg);

  let token = args.token || process.env.MUHKOO_DEV_TOKEN;
  let username = args.username || process.env.MUHKOO_USERNAME;
  let commitment;

  if (!token) {
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
