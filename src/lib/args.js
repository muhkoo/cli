/**
 * Tiny dependency-free argv parser. Mirrors the convention used across the
 * platform's `.mjs` scripts: `--flag value`, bare `--flag` → `true`, and
 * positionals collected in `_`.
 *
 *   parseArgs(["apps", "get", "--base", "staging", "--json"])
 *   → { _: ["apps", "get"], base: "staging", json: true }
 */
export function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) a[key] = true;
      else {
        a[key] = next;
        i++;
      }
    } else {
      a._.push(t);
    }
  }
  return a;
}

/** First defined value among the candidates (skips `undefined`/`null`/`""`). */
export function firstOf(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
}
