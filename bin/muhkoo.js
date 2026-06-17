#!/usr/bin/env node
/**
 * muhkoo — Muhkoo platform CLI.
 *
 * Thin launcher: delegates to src/index.js, which owns routing. Top-level errors
 * are printed cleanly and exit non-zero. An explicit exit keeps a programmatic ZK
 * login (which leaves prover worker threads alive) from hanging the process.
 */

import { run } from "../src/index.js";

run(process.argv.slice(2))
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`\n✗ ${e?.stack || e?.message || String(e)}\n`);
    process.exit(1);
  });
