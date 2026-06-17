/**
 * Open a URL in the user's default browser, cross-platform. Best-effort: if the
 * launcher isn't found, the caller still prints the URL for manual opening.
 */

import { spawn } from "node:child_process";

export function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
