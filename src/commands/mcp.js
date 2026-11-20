/**
 * `muhkoo mcp` — run as an MCP server for Claude, over stdio.
 *
 * Claude Desktop (via the .mcpb extension) or Claude Code starts this and
 * talks to it on stdin/stdout, so nothing here may print to stdout: that
 * stream belongs to the protocol.
 */

import { serveStdio } from "../mcp/server.js";

export const help = `muhkoo mcp — run as an MCP server for Claude (stdio)

Usage:
  muhkoo mcp

Started by Claude, not by hand. It gives Claude a tool for every CLI action,
signed in as whoever ran \`muhkoo login\` on this computer. Tools that change
production or delete things are marked so Claude asks first; secret keys and
access tokens are saved to private files and never shown.

Claude Code:     claude mcp add muhkoo -- npx -y @muhkoo/cli mcp
Claude Desktop:  install the Muhkoo extension (.mcpb).`;

export default async function mcp() {
  await serveStdio();
  // Keep running until the client closes stdin.
  await new Promise((resolve) => process.stdin.on("close", resolve));
}
