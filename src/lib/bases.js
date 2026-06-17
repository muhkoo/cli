/**
 * Known API bases. A `--base` value that isn't one of these short names is
 * treated as a literal URL, so `--base http://localhost:8787` also works.
 */
export const BASES = {
  prod: "https://api.muhkoo.dev",
  production: "https://api.muhkoo.dev",
  staging: "https://api.staging.muhkoo.dev",
  local: "http://localhost:8787",
};

/** Resolve a `--base` short-name or literal URL to a concrete API base URL. */
export function resolveBaseUrl(value) {
  if (!value) return BASES.prod;
  return BASES[value] || value;
}

/** The public hosting host suffix for an API base (apps.* / apps.staging.*). */
export function appsSuffixFor(baseUrl) {
  return baseUrl.includes("staging") ? "apps.staging.muhkoo.dev" : "apps.muhkoo.dev";
}

/** The hosted-auth SPA origin paired with an API base. */
export function authBaseFor(baseUrl) {
  if (baseUrl.includes("staging")) return "https://auth.staging.muhkoo.dev";
  if (baseUrl.includes("localhost")) return "http://localhost:5173";
  return "https://auth.muhkoo.dev";
}
