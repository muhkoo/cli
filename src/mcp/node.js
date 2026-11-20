/**
 * The program the MCP server starts the CLI with.
 *
 * Under plain Node that is the running Node (`process.execPath`). Claude
 * Desktop can instead run the server in its own built-in runtime, where
 * `process.execPath` is the Claude app, and the app cannot be made to act as
 * Node (its RunAsNode fuse is off). There a real `node` has to be found on
 * this computer: PATH first, then the usual install places, then the login
 * shell, which is slow and so asked last.
 */

import { accessSync, constants, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const isExecutableFile = (p) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const listDirSafe = (d) => {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
};

/** `node` as the user's login shell resolves it (nvm, asdf, fnm and the like hook in there). */
function loginShellNodeDefault() {
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const out = execFileSync(shell, ["-ilc", "command -v node"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().split("\n").pop() || null;
  } catch {
    return null;
  }
}

const semverDesc = (a, b) => {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  return 0;
};

/**
 * @returns {string | null} a path to a Node binary, or null when there is none
 */
export function findNode({
  versions = process.versions,
  execPath = process.execPath,
  env = process.env,
  home = homedir(),
  isExecutable = isExecutableFile,
  listDir = listDirSafe,
  loginShellNode = loginShellNodeDefault,
} = {}) {
  if (!versions.electron) return execPath;

  const candidates = [
    ...String(env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "node")),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    join(home, ".volta", "bin", "node"),
    ...listDir(join(home, ".nvm", "versions", "node"))
      .sort(semverDesc)
      .map((v) => join(home, ".nvm", "versions", "node", v, "bin", "node")),
  ];
  for (const c of candidates) if (c !== execPath && isExecutable(c)) return c;

  const viaShell = loginShellNode();
  if (viaShell && viaShell !== execPath && isExecutable(viaShell)) return viaShell;
  return null;
}

let cached;
/** findNode for this process, looked up once. */
export function nodeForCli() {
  if (cached === undefined) cached = findNode();
  return cached;
}

export const NO_NODE_ERROR =
  'Muhkoo\'s tools need Node.js 20 or newer on this computer, and none was found. Install it from https://nodejs.org, or in Claude go to Settings → Extensions → Advanced settings and turn off "Use built-in Node.js for MCP".';
