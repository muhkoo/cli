#!/usr/bin/env node
/**
 * muhkoo — Muhkoo platform CLI.
 *
 * Thin launcher: delegates to src/index.js, which owns routing. Top-level errors
 * are printed cleanly and exit non-zero. An explicit exit keeps a programmatic ZK
 * login (which leaves prover worker threads alive) from hanging the process.
 */

import { run } from "../src/index.js";
import { printable } from "../src/lib/ui.js";
import { drained } from "../src/lib/drain.js";

run(process.argv.slice(2))
  .then(() => drained())
  .then(() => process.exit(0))
  .catch(async (e) => {
    // Escaped like everything else printed: an error's message can carry a
    // name or a server's words. The message is one line; the stack's frames
    // are Node's own lines.
    const head = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const stack = e instanceof Error && typeof e.stack === "string" ? e.stack : "";
    const frames = stack.startsWith(head) ? stack.slice(head.length).split("\n").filter(Boolean) : [];
    console.error(["", `✗ ${printable(head)}`, ...frames.map(printable), ""].join("\n"));
    await drained();
    process.exit(1);
  });
