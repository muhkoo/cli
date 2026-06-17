/**
 * Browser-based developer login via the hosted auth page (auth.muhkoo.dev).
 *
 * Loopback OAuth (authorization-code + PKCE), per RFC 8252:
 *   1. start a localhost HTTP server on a fixed loopback port
 *   2. open the browser to auth.muhkoo.dev/authorize?…&redirect_uri=http://127.0.0.1:<port>/callback
 *   3. the user signs in on the Muhkoo origin (credentials never touch the CLI)
 *   4. the hosted page redirects back to the loopback with ?code&state
 *   5. exchange the code (+ PKCE verifier) at /api/auth/token → a session token
 *
 * The CLI only needs the session token (it drives the developer management API).
 * The sealed master seed rides in the URL fragment, which browsers never send to
 * the loopback server — fine, because management ops don't need the seed.
 *
 * The loopback redirect URIs below are registered as first-party on the
 * accelerator (FIRST_PARTY_REDIRECT_URIS), so the constant `muhkoo-cli` app id
 * needs no per-developer app record.
 */

import http from "node:http";
import { generatePkce, randomState } from "./pkce.js";
import { openBrowser } from "./browser.js";
import { authBaseFor } from "./bases.js";
import { step, info, die, c } from "./ui.js";

/** The CLI's first-party client id. Override with --app-id / $MUHKOO_CLI_APP_ID. */
export const DEFAULT_CLI_APP_ID = "muhkoo-cli";

/** Loopback ports tried in order — each must be registered in FIRST_PARTY_REDIRECT_URIS. */
const PORTS = [8976, 8977, 8978];

function successPage(message, isError) {
  const color = isError ? "#c0392b" : "#0a1929";
  const title = isError ? "Sign-in failed" : "Signed in to the Muhkoo CLI";
  const body = isError ? message : "You can close this tab and return to your terminal.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#f6f8fa;color:${color};
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fff;border-radius:12px;padding:40px 48px;box-shadow:0 6px 24px rgba(10,25,41,.08);text-align:center;max-width:420px}
h1{font-size:20px;margin:0 0 8px}p{color:#5b6b7b;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

async function startLoopback() {
  for (const port of PORTS) {
    try {
      const srv = await listen(port);
      return { srv, port };
    } catch (e) {
      if (e?.code === "EADDRINUSE") continue;
      throw e;
    }
  }
  die(`All loopback ports are busy (${PORTS.join(", ")}). Close whatever's using them and retry.`);
}

/**
 * Run the browser login and resolve `{ token, username, commitment }`.
 * `baseUrl` is the API base; `appId` is the CLI client id.
 */
export async function webLogin({ baseUrl, appId }) {
  const { srv, port } = await startLoopback();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const { verifier, challenge } = generatePkce();
  const state = randomState();
  const authUrl = `${authBaseFor(baseUrl)}/authorize?` + new URLSearchParams({
    app_id: appId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const codePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for browser sign-in (5 min).")),
      300_000,
    );
    srv.on("request", (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const code = u.searchParams.get("code");
      const gotState = u.searchParams.get("state");
      const error = u.searchParams.get("error");
      const failed = error || !code || gotState !== state;
      res.writeHead(failed ? 400 : 200, { "Content-Type": "text/html" });
      res.end(
        successPage(
          error
            ? `The authorization server returned: ${error}`
            : !code
              ? "No authorization code was returned."
              : gotState !== state
                ? "State mismatch — please start the login again."
                : "",
          !!failed,
        ),
      );
      clearTimeout(timer);
      if (error) return reject(new Error(`Sign-in failed: ${error}`));
      if (!code) return reject(new Error("No authorization code returned."));
      if (gotState !== state) return reject(new Error("State mismatch — possible CSRF. Start login again."));
      resolve(code);
    });
  });

  step("Opening your browser to sign in…");
  const opened = openBrowser(authUrl);
  info(`${opened ? "If it didn't open, visit:" : "Open this URL to sign in:"}\n  ${c.cyan(authUrl)}\n`);

  let code;
  try {
    code = await codePromise;
  } finally {
    srv.close();
  }

  step("Exchanging authorization code…");
  const res = await fetch(`${baseUrl}/api/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, codeVerifier: verifier, appId }),
  });
  if (!res.ok) die(`Token exchange failed (${res.status}): ${await res.text()}`);
  const body = await res.json().catch(() => null);
  if (!body?.sessionToken) die("No session token returned from the token exchange.");
  return { token: body.sessionToken, username: body.username, commitment: body.commitment };
}
