/**
 * PKCE (RFC 7636, S256) + random state for the hosted-auth loopback login.
 * Matches what the hosted auth page + accelerator expect (base64url, SHA-256).
 */

import { randomBytes, createHash } from "node:crypto";

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function generatePkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function randomState() {
  return b64url(randomBytes(16));
}
