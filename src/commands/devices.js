/**
 * `muhkoo devices` — machines paired to your account.
 *
 * A paired machine holds a key that unwraps the master seed held (encrypted) in
 * your vault. The seed itself is never on that machine's disk, so revoking here
 * genuinely withdraws its access — unlike a copied seed, which nothing can
 * reach out and un-store.
 */

import { openClient } from "../lib/vfs.js";
import { loadConfig, saveConfig } from "../lib/config.js";
import { table, json, ok, info, die } from "../lib/ui.js";

export const help = `muhkoo devices — machines paired to your account

Usage:
  muhkoo devices ls [--json]      list paired machines
  muhkoo devices rm <factorId>    withdraw a machine's access`;

export default async function devices(args) {
  const sub = args._[1] ?? "ls";
  const client = await openClient(args);
  const cfg = await loadConfig();

  switch (sub) {
    case "ls": {
      const list = await client.auth.zk.listDevices();
      if (args.json) return json(list);
      if (!list.length) return info("No paired machines.");
      return table(
        ["ID", "LABEL", "PAIRED", ""],
        list.map((d) => [
          d.id,
          d.label ?? "-",
          d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 10) : "-",
          d.id === cfg.deviceFactorId ? "← this machine" : "",
        ]),
      );
    }

    case "rm": {
      const id = args._[2];
      if (!id) die("Missing device id. Usage: muhkoo devices rm <factorId>");
      const deleted = await client.auth.zk.revokeDevice(id);
      if (!deleted) return die(`No paired machine with id ${id}.`);
      // Revoking THIS machine must clear the now-useless local key, or every
      // later command retries a pairing the server has already forgotten.
      if (id === cfg.deviceFactorId) {
        await saveConfig({ ...cfg, deviceFactorId: undefined, deviceKey: undefined });
        return ok("Revoked this machine. Run any `muhkoo vfs` command to pair it again.");
      }
      return ok(`Revoked ${id}.`);
    }

    default:
      return die(`Unknown subcommand "devices ${sub}". See \`muhkoo devices --help\`.`);
  }
}
