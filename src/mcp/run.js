/**
 * Run one CLI command for the MCP server and turn what it prints into a result.
 *
 * Commands run in a child process, never in this one: they print as they go
 * and call `process.exit` when they fail, which would take the server down.
 * The child is this package's own `bin/muhkoo.js` under Node (see `node.js`), so the
 * tools always run the CLI they shipped with, not whatever is on PATH.
 *
 * Nothing in the child may wait on a terminal: stdin is closed and
 * MUHKOO_NONINTERACTIVE makes a prompt fail at once (see `ui.js`).
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nodeForCli, NO_NODE_ERROR } from "./node.js";

const DEFAULT_BIN = fileURLToPath(new URL("../../bin/muhkoo.js", import.meta.url));
const DEFAULT_TIMEOUT_MS = 60_000;
/** The most text a tool hands back; a 50 MB `vfs cat` would swamp the conversation. */
export const MAX_TEXT_BYTES = 1024 * 1024;
const STDERR_TAIL = 2048;
const SIGN_IN = /\b401\b|not signed in|session/i;

/**
 * @param {string[]} argv the command, e.g. ["vfs", "ls", "/apps"]; `--json` is appended
 * @param {{ cwd?: string, timeoutMs?: number, bin?: string, onStderr?: (line: string) => void }} [opts]
 * @returns {Promise<{ ok: true, data: unknown } | { ok: false, error: string }>}
 */
export function runCli(argv, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, bin = DEFAULT_BIN, onStderr, node = nodeForCli() } = {}) {
  return new Promise((resolve) => {
    if (!node) return resolve({ ok: false, error: NO_NODE_ERROR });
    const child = spawn(node, [bin, ...argv, "--json"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout can kill what it started too
      // (deploy runs `vfs import` as a grandchild).
      detached: true,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", MUHKOO_NONINTERACTIVE: "1" },
    });

    const out = [];
    let outBytes = 0;
    let err = "";
    let partial = "";
    let timedOut = false;

    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      // Keep a little past the cap: enough to know it was exceeded.
      if (outBytes - chunk.length <= MAX_TEXT_BYTES) out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      err = (err + text).slice(-STDERR_TAIL * 4);
      if (!onStderr) return;
      const parts = (partial + text).split("\n");
      partial = parts.pop();
      for (const line of parts) if (line.trim()) onStderr(line);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `could not start the muhkoo CLI: ${e.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (onStderr && partial.trim()) onStderr(partial);
      if (timedOut) return resolve({ ok: false, error: `timed out after ${timeoutMs / 1000}s` });

      const stdout = Buffer.concat(out);
      const parsed = parseJson(stdout);
      if (code === 0) {
        if (parsed !== undefined) return resolve({ ok: true, data: parsed });
        // Commands without a JSON result print their answer as progress
        // lines (stderr under --json): that is the answer, not noise.
        if (outBytes === 0) return resolve({ ok: true, data: { text: lastLines(err) } });
        return resolve({ ok: true, data: asText(stdout, outBytes) });
      }

      let message = typeof parsed?.error === "string" ? parsed.error : lastLines(err) || `muhkoo exited with code ${code}`;
      if (SIGN_IN.test(message) && !/login tool/.test(message)) message += " — use the login tool to sign in.";
      resolve({ ok: false, error: message });
    });
  });
}

function killGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function parseJson(buf) {
  const text = buf.toString("utf8").trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asText(buf, totalBytes) {
  if (buf.includes(0)) return { text: "binary output; use vfs_get to save it to a file" };
  if (totalBytes > MAX_TEXT_BYTES) {
    return { text: `${buf.subarray(0, MAX_TEXT_BYTES).toString("utf8")}\n…[truncated: ${totalBytes} bytes]` };
  }
  return { text: buf.toString("utf8") };
}

function lastLines(stderr) {
  return stderr.trim().slice(-STDERR_TAIL).replace(/^✗\s*/gm, "").trim();
}
