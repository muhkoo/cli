/**
 * Minimal terminal UI helpers — colors, status lines, tables, and prompts.
 * No dependencies; respects `NO_COLOR` and non-TTY output.
 */

const ESC = String.fromCharCode(27);
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : String(s));

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  cyan: wrap("36"),
};

export function info(msg = "") {
  console.log(msg);
}
export function ok(msg) {
  console.log(`${c.green("✓")} ${msg}`);
}
export function warn(msg) {
  console.log(`${c.yellow("⚠")} ${msg}`);
}
export function step(msg) {
  console.log(`${c.dim("→")} ${msg}`);
}

/** Print an error and exit non-zero. */
export function die(msg) {
  console.error(`\n${c.red("✗")} ${msg}\n`);
  process.exit(1);
}

/** Pretty-print JSON to stdout (used by `--json` and `get` commands). */
export function json(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

/**
 * Mask secret-shaped substrings (app keys, long bearer-style tokens) in
 * untrusted text — e.g. a server error body — before printing it, so a
 * reflected key/token can't leak into the terminal or CI logs.
 */
export function redact(s) {
  return String(s)
    .replace(/mk_[a-z0-9]+_[a-z0-9]+_[A-Za-z0-9]+/gi, (m) => m.slice(0, 11) + "…")
    .replace(/\b[A-Za-z0-9._-]{40,}\b/g, (m) => m.slice(0, 6) + "…[redacted]");
}

/** Render a simple aligned table from rows of strings. */
export function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)),
  );
  const line = (cells) =>
    cells.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join("  ");
  console.log(c.bold(line(headers)));
  for (const r of rows) console.log(line(r));
}

/** Prompt for a line of input on stdin. */
export async function prompt(question) {
  const rl = (await import("node:readline/promises")).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Prompt for a hidden line (passwords). Masks input on a TTY via raw mode; on a
 * non-TTY (piped) it just reads a line.
 */
export function promptHidden(question) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) return prompt(question);

  return new Promise((resolve) => {
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onKey = (ch) => {
      const code = ch.charCodeAt(0);
      if (ch === "\n" || ch === "\r" || code === 4 /* EOT */) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onKey);
        stdout.write("\n");
        resolve(buf);
      } else if (code === 3 /* Ctrl-C */) {
        stdout.write("\n");
        process.exit(130);
      } else if (code === 127 || ch === "\b" /* Backspace */) {
        buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    stdin.on("data", onKey);
  });
}
