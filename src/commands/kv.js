/**
 * `muhkoo kv` — the keys in your personal key/value store.
 *
 * The store is shared by every app you sign into: `client.kv` collections
 * (`todos/…`), your filesystem (`vfs/…`), version control (`vcs/…`) and the
 * SDK's own keys. This lists NAMES only and never reads a value, so it needs a
 * session but not an unlocked vault. (`client.kv` encrypts values by default,
 * but an app may store one with `encrypt: false`, so nothing here says every
 * value is encrypted.)
 * Keys come from whoever wrote them, so they are printed escaped (`info`,
 * `json`), never raw.
 */

import { openSession } from "../lib/vfs.js";
import { json, info, die } from "../lib/ui.js";

export const help = `muhkoo kv — the keys in your personal key/value store

Usage:
  muhkoo kv ls [<prefix>] [--json]   keys that start with <prefix> (default: all)

Options:
  --app <slug>   the app the read is made as (default: the one from
                 \`muhkoo vfs use-app\`); reads work without one
  --json         a JSON array of keys

Keys only: this command never reads a value. Put --json after "ls".

Examples:
  muhkoo kv ls todos/          one client.kv collection
  muhkoo kv ls vfs/d/          your filesystem's directory records`;

export default async function kv(args) {
  // The shared parser gives `--json` the word after it, so `kv ls --json todos/`
  // arrives as `json: "todos/"`. That word goes back on the END of the
  // positionals, as `vfs`'s `booleanFlags` does. So `--json` works anywhere
  // after the subcommand, but not before it: `kv --json ls todos/` reads as
  // `kv todos/ ls` and is refused as an unknown subcommand.
  const words = [...args._.slice(1), ...(typeof args.json === "string" ? [args.json] : [])];
  const sub = words[0] ?? "ls";

  switch (sub) {
    case "ls": {
      if (words.length > 2) return die("Usage: muhkoo kv ls [<prefix>] [--json]");
      const prefix = words[1] ?? "";
      const client = await openSession(args);
      const keys = await client.kv.keys(prefix);
      if (args.json) return json(keys);
      // A human hint, not data: stderr, so `kv ls todos/ | while read k; do …`
      // never reads this sentence as a key. Stdout stays empty and the exit
      // code stays 0.
      if (!keys.length)
        return void process.stderr.write(
          `${prefix ? `No keys start with "${prefix}".` : "Your personal store is empty."}\n`,
        );
      // One key a line, a thousand lines a call: a large space can hold more
      // keys than one function call takes arguments.
      for (let i = 0; i < keys.length; i += 1000) info(...keys.slice(i, i + 1000));
      return;
    }

    default:
      return die(`Unknown subcommand "kv ${sub}". See \`muhkoo kv --help\`.`);
  }
}
