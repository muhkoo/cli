/**
 * HTTP helpers for the management + data-plane APIs. Every call returns a
 * normalized `{ ok, status, body }` so commands can branch on status (e.g. 402
 * → "needs a paid plan") without re-parsing.
 */

import { die } from "./ui.js";

async function request(baseUrl, method, path, { auth, body, raw } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${auth}`;
  if (body !== undefined && !raw) headers["Content-Type"] = "application/json";
  if (raw) headers["Content-Type"] = "application/octet-stream";

  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });

  if (raw) return { ok: res.ok, status: res.status, res };
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

/** A management call authenticated with a developer session token (Bearer). */
export function devCall(ctx, method, path, body) {
  return request(ctx.baseUrl, method, path, { auth: ctx.token, body });
}

/** A hosting/blob call authenticated with an app SECRET key (Bearer). */
export function skCall(baseUrl, key, method, path, body, opts = {}) {
  return request(baseUrl, method, path, { auth: key, body, raw: opts.raw });
}

/** A data-plane GET authenticated with an app key via `X-Muhkoo-Key`. */
export async function appKeyGet(baseUrl, appKey, path) {
  const res = await fetch(baseUrl + path, { headers: { "X-Muhkoo-Key": appKey } });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

/** Exit with a formatted message when a `{ ok, status, body }` result failed. */
export function ensure(result, what) {
  if (result.ok) return result;
  const detail =
    typeof result.body === "string"
      ? result.body
      : result.body
        ? JSON.stringify(result.body)
        : "";
  die(`${what} failed (${result.status})${detail ? `: ${detail}` : ""}`);
}
