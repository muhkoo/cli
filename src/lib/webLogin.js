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
 * The sealed master seed comes back from the token exchange, but the key that
 * opens it rides in the URL fragment, which browsers never send to the loopback
 * server. So the callback page posts it back to `/fragment`, and the seed lets
 * `muhkoo login` pair this machine in the same step.
 *
 * The loopback redirect URIs below are registered as first-party on the
 * accelerator (FIRST_PARTY_REDIRECT_URIS), so the constant `muhkoo-cli` app id
 * needs no per-developer app record.
 */

import http from "node:http";
import { generatePkce, randomState } from "./pkce.js";
import { openBrowser } from "./browser.js";
import { authBaseFor } from "./bases.js";
import { step, info, die, redact, c } from "./ui.js";

/** The CLI's first-party client id. Override with --app-id / $MUHKOO_CLI_APP_ID. */
export const DEFAULT_CLI_APP_ID = "muhkoo-cli";

/** Loopback ports tried in order — each must be registered in FIRST_PARTY_REDIRECT_URIS. */
const PORTS = [8976, 8977, 8978];

/** How long the loopback stays open after the code for the browser's `/fragment` POST. */
const FRAGMENT_WAIT_MS = 10_000;

/** HTML-escape untrusted text before interpolating it into the loopback page. */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * The unlock key rides in the URL fragment (`#k=…`), which a browser never sends
 * to us. This script, served from the loopback itself, reads it and POSTs it
 * back, then strips it from the address bar. `state` is our own random value,
 * never request data. Without a `k` the script does nothing.
 */
function fragmentScript(state) {
  return `<script>(function(){var m=/[#&]k=([^&]+)/.exec(location.hash);if(!m)return;
var k=decodeURIComponent(m[1]);
fetch("/fragment",{method:"POST",body:JSON.stringify({state:${JSON.stringify(state)},k:k})})
.catch(function(){}).then(function(){history.replaceState(null,"",location.pathname)})})();</script>`;
}

function successPage(message, isError, state) {
  const color = isError ? "#c0392b" : "#0a1929";
  const title = isError ? "Sign-in failed" : "Signed in to the Muhkoo CLI";
  const body = isError ? escapeHtml(message) : "You can close this tab and return to your terminal.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#f6f8fa;color:${color};
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fff;border-radius:12px;padding:40px 48px;box-shadow:0 6px 24px rgba(10,25,41,.08);text-align:center;max-width:420px}
h1{font-size:20px;margin:0 0 8px}p{color:#5b6b7b;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${body}</p></div>${isError ? "" : fragmentScript(state)}</body></html>`;
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

/** The master seed as base64, or null when the key or envelope is missing or does not open. */
async function unsealFragment(sealedKeys, fragmentKey) {
  if (!sealedKeys || !fragmentKey) return null;
  try {
    const { unsealSeed, toBase64 } = await import("@muhkoo/connect");
    return toBase64(await unsealSeed(sealedKeys, fragmentKey));
  } catch {
    return null;
  }
}

/**
 * Run the browser login and resolve `{ token, username, commitment, seed }`.
 * `seed` is the master seed (base64) when the browser handed over the unlock
 * key, else null.
 * `baseUrl` is the API base; `appId` is the CLI client id.
 */
export async function webLogin({ baseUrl, appId, fragmentWaitMs = FRAGMENT_WAIT_MS }) {
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

  let fragmentKey = null;
  let gotFragment;
  const fragmentPromise = new Promise((r) => (gotFragment = r));

  const codePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for browser sign-in (5 min).")),
      300_000,
    );
    srv.on("request", (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname === "/fragment" && req.method === "POST") {
        let raw = "";
        req.on("data", (d) => {
          if (raw.length < 4096) raw += d;
        });
        req.on("end", () => {
          let b = null;
          try { b = JSON.parse(raw); } catch {}
          if (!b || b.state !== state || typeof b.k !== "string" || !b.k) {
            res.writeHead(400);
            res.end("Bad request");
            return;
          }
          fragmentKey = b.k;
          gotFragment();
          res.writeHead(204);
          res.end();
        });
        return;
      }
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
          state,
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
  info(`${opened ? "If it didn't open, visit:" : "Open this URL to sign in:"}`, `  ${c.cyan(authUrl)}`, "");

  try {
    const code = await codePromise;

    // The page's script POSTs the fragment key a moment after the code lands, so
    // the server stays open for it (bounded) while the code is exchanged.
    let waitTimer;
    const fragmentWait = Promise.race([
      fragmentPromise,
      new Promise((r) => (waitTimer = setTimeout(r, fragmentWaitMs))),
    ]).finally(() => clearTimeout(waitTimer));

    step("Exchanging authorization code…");
    const res = await fetch(`${baseUrl}/api/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, codeVerifier: verifier, appId }),
    });
    if (!res.ok) die(`Token exchange failed (${res.status}): ${redact(await res.text())}`);
    const body = await res.json().catch(() => null);
    if (!body?.sessionToken) die("No session token returned from the token exchange.");

    await fragmentWait;
    const seed = await unsealFragment(body.sealedKeys, fragmentKey);
    return { token: body.sessionToken, username: body.username, commitment: body.commitment, seed };
  } finally {
    srv.close();
  }
}
