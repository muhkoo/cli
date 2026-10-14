/**
 * Minimal terminal UI helpers — colors, status lines, tables, and prompts.
 * No dependencies; respects `NO_COLOR`, `FORCE_COLOR` and non-TTY output.
 *
 * Everything printed here is made PRINTABLE first. Commit messages, branch
 * names, authors and file names are written by whatever holds the user's
 * seed, and a terminal obeys escape sequences in anything it prints: OSC 52
 * sets the clipboard in kitty, Alacritty, Windows Terminal and tmux, so a
 * planted "fix typo" could load `curl … | sh` for the user to paste. The
 * escaping lives in these helpers, not at call sites, so no call site can
 * forget it. The CLI's own line breaks are separate arguments, and its
 * colours are marks rendered after the escaping — the only control codes that
 * get through.
 */

import { randomUUID } from "node:crypto";

const ESC = String.fromCharCode(27);
// FORCE_COLOR=0 and =false mean "no colour" to supports-color and chalk, so
// they must not turn it on here — into a log or a pipe.
const force = process.env.FORCE_COLOR;
const forced = Boolean(force) && force !== "0" && force !== "false";
const useColor = Boolean((forced || (process.stdout.isTTY && force !== "0" && force !== "false")) && !process.env.NO_COLOR);

/**
 * A colour is a mark, rendered as an escape code only after the text around
 * it has been escaped. The mark carries a nonce made when this process
 * started, so no text written before — a commit message, a file name — can
 * contain one.
 */
const MARK = `\ue000${randomUUID().replace(/-/g, "")}:`;
const MARKS = new RegExp(`${MARK}(\\d+)m`, "g");
const wrap = (code) => (s) => (useColor ? `${MARK}${code}m${s}${MARK}0m` : String(s));

/**
 * Control characters (C0 — newlines and tabs included — DEL and C1), bidi
 * overrides and isolates, line and paragraph separators, and the invisible
 * characters that make one name look like another.
 */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g;
const escapeChar = (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;

/** `value` with every unprintable character written as a visible \uXXXX escape. */
export function printable(value) {
  return String(value).replace(UNPRINTABLE, escapeChar);
}

/** One line of output: escaped, then the CLI's own colours rendered. */
const render = (line) => printable(line).replace(MARKS, (_, code) => `${ESC}[${code}m`);
const lines = (all) => all.map(render).join("\n");

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  cyan: wrap("36"),
};

// Each argument is one line: a newline INSIDE an argument is escaped like
// any other control character, so a message that runs to several lines
// passes them as separate arguments.
export function info(...all) {
  console.log(lines(all));
}
export function ok(first, ...more) {
  console.log(lines([`${c.green("✓")} ${first}`, ...more]));
}
export function warn(first, ...more) {
  console.log(lines([`${c.yellow("⚠")} ${first}`, ...more]));
}
export function step(first, ...more) {
  console.log(lines([`${c.dim("→")} ${first}`, ...more]));
}

/** Print an error and exit non-zero. */
export function die(first, ...more) {
  console.error(lines(["", `${c.red("✗")} ${first}`, ...more, ""]));
  process.exit(1);
}

/**
 * Pretty-print JSON to stdout (used by `--json` and `get` commands). Still
 * valid JSON: what JSON.stringify leaves raw — C1, bidi and the rest — is
 * written as \uXXXX, which parses back to the same string.
 */
const JSON_UNPRINTABLE = /[\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g;
export function json(obj) {
  console.log(JSON.stringify(obj, null, 2).replace(MARKS, "").replace(JSON_UNPRINTABLE, escapeChar));
}

/**
 * A file's text, as the user asked to see it (`vfs cat`). Piped or
 * redirected, it is written exactly as it is. To a terminal, its own line
 * breaks (LF, CRLF) and tabs are kept and every other control character is
 * escaped — a lone CR included, since it lets one line print over another.
 */
const TEXT_UNPRINTABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]|\r(?!\n)/g;
export function writeText(text) {
  const s = String(text);
  process.stdout.write(process.stdout.isTTY ? s.replace(TEXT_UNPRINTABLE, escapeChar) : s);
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

/**
 * Render a simple aligned table from rows of strings. Cells are escaped
 * before they are measured, so a planted escape cannot misalign a column, and
 * a colour mark takes no width.
 */
export function table(headers, rows) {
  const cells = (row) => row.map((cell) => printable(cell ?? ""));
  const head = cells(headers);
  const body = rows.map(cells);
  const width = (cell) => cell.replace(MARKS, "").length;
  const widths = head.map((h, i) => Math.max(width(h), ...body.map((r) => width(r[i] ?? ""))));
  const line = (row) =>
    row.map((cell, i) => cell + " ".repeat(Math.max(0, widths[i] - width(cell ?? "")))).join("  ");
  const out = (text) => text.replace(MARKS, (_, code) => `${ESC}[${code}m`);
  console.log(out(c.bold(line(head))));
  for (const r of body) console.log(out(line(r)));
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
