/**
 * `muhkoo vfs` — your Muhkoo filesystem from the terminal.
 *
 * Drives `client.vfs` through the SDK, the same code the IDE runs. The
 * directory records are encrypted with keys chained parent-to-child, so a
 * separate HTTP implementation here would be a second copy of that format to
 * keep byte-exact — and the first one to drift would corrupt real files.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { openClient, explainWriteFailure } from "../lib/vfs.js";
import { mount as mountDir } from "../lib/mount.js";
import { loadConfig, saveConfig } from "../lib/config.js";
import { table, json, ok, info, die } from "../lib/ui.js";

export const help = `muhkoo vfs — your encrypted filesystem

Usage:
  muhkoo vfs cd <path>                   change directory (remembered)
  muhkoo vfs pwd                         print the working directory
  muhkoo vfs ls [path] [--json]          list a directory
  muhkoo vfs stat <path>                 size, versions, modified
  muhkoo vfs tree [path]                 every file beneath a path
  muhkoo vfs cat <path>                  print a file
  muhkoo vfs put <local> <path>          upload a file
  muhkoo vfs get <path> [local]          download a file
  muhkoo vfs mkdir <path>                create a directory
  muhkoo vfs rm <path> [-r]              delete a file or directory
  muhkoo vfs cp <from> <to>              copy (a file copy moves no bytes)
  muhkoo vfs mv <from> <to>              move or rename
  muhkoo vfs find <glob>                 e.g. '/apps/**/*.ts'
  muhkoo vfs history <path>              prior versions, newest first
  muhkoo vfs restore <path> [index]      restore a version (default 0)
  muhkoo vfs mount <dir> [--path <p>]    sync a subtree to disk and keep it live
  muhkoo vfs sweep [--force]             reclaim orphaned records
  muhkoo vfs use-app <domain>            use an app, by the domain you use it at
  muhkoo vfs app                         show which app you are writing as

Reading your files is free. WRITING stores bytes, which are metered to an
app — so put, rm, cp, mv and restore need an app signed in first.

Options:
  --app <name>   write as this app for one command
  --key <k>      supply the app key yourself (apps that publish their public
                 config at /.well-known/muhkoo.json need no key)
  --no-pair      unlock for this command only; pair nothing to this machine`;

export default async function vfs(args) {
  const sub = args._[1];
  if (sub === undefined) return die("Missing subcommand. See `muhkoo vfs --help`.");

  const client = await openClient(args);
  const fs = client.vfs;
  const a = (n, dflt) => args._[n] ?? dflt;

  try {
    return await run();
  } catch (err) {
    const cfg = await loadConfig();
    const explained = explainWriteFailure(err, cfg);
    if (explained !== (err?.message ?? String(err))) die(explained);
    throw err;
  }

  async function run() {
  switch (sub) {
    case "cd": {
      const target = await fs.cd(a(2, "/"));
      const current = await loadConfig();
      await saveConfig({ ...current, vfsCwd: target });
      return ok(target);
    }

    case "pwd":
      return info(fs.cwd);

    case "stat": {
      const st = await fs.stat(required(a(2), "stat <path>"));
      if (args.json) return json(st);
      return table(
        ["PATH", "TYPE", "SIZE", "VERSIONS", "MODIFIED"],
        [[st.path, st.kind, st.kind === "dir" ? "-" : humanSize(st.size), String(st.versions), new Date(st.mtime).toISOString().replace("T", " ").slice(0, 19)]],
      );
    }

    case "ls": {
      const path = a(2, ".");
      const entries = await fs.list(path);
      if (args.json) return json(entries);
      if (!entries.length) return info(`${path} is empty.`);
      return table(
        ["TYPE", "SIZE", "VERSIONS", "MODIFIED", "NAME"],
        entries.map((e) => [
          e.kind === "dir" ? "dir" : "file",
          e.kind === "dir" ? "-" : humanSize(e.size),
          e.versions ? String(e.versions) : "-",
          new Date(e.mtime).toISOString().slice(0, 16).replace("T", " "),
          e.kind === "dir" ? `${e.name}/` : e.name,
        ]),
      );
    }

    case "tree": {
      const paths = await fs.walk(a(2, "."));
      if (args.json) return json(paths);
      return paths.forEach((p) => info(p));
    }

    case "cat": {
      const path = required(a(2), "cat <path>");
      process.stdout.write(await fs.readText(path));
      return;
    }

    case "put": {
      const local = required(a(2), "put <local> <path>");
      const bytes = await readLocal(local);
      // Default the destination to the file's own name, so `put ./a.txt` in a
      // directory does the obvious thing.
      const path = a(3) ?? `/${basename(local)}`;
      const stat = await fs.writeFile(path, bytes);
      return ok(`Wrote ${path} (${humanSize(stat.size)})`);
    }

    case "get": {
      const path = required(a(2), "get <path> [local]");
      const bytes = await fs.readFile(path);
      const dest = a(3) ?? basename(path);
      await writeFile(dest, bytes).catch((err) =>
        die(`Could not write ${dest}: ${err.code === "EACCES" ? "permission denied" : err.message}`),
      );
      return ok(`Saved ${dest} (${humanSize(bytes.length)})`);
    }

    case "mkdir":
      await fs.mkdir(required(a(2), "mkdir <path>"), { recursive: true });
      return ok(`Created ${a(2)}`);

    case "rm": {
      const path = required(a(2), "rm <path>");
      await fs.delete(path, { recursive: Boolean(args.r || args.recursive) });
      return ok(`Deleted ${path}`);
    }

    case "cp": {
      const [from, to] = pair(args, "cp <from> <to>");
      await fs.copy(from, to);
      return ok(`Copied ${from} → ${to}`);
    }

    case "mv": {
      const [from, to] = pair(args, "mv <from> <to>");
      await fs.rename(from, to);
      return ok(`Moved ${from} → ${to}`);
    }

    case "find": {
      const matches = await fs.glob(required(a(2), "find <glob>"));
      if (args.json) return json(matches);
      if (!matches.length) return info("No matches.");
      return matches.forEach((p) => info(p));
    }

    case "history": {
      const versions = await fs.history(required(a(2), "history <path>"));
      if (args.json) return json(versions);
      if (!versions.length) return info("No prior versions — this file has been written once.");
      return table(
        ["#", "SIZE", "SAVED"],
        versions.map((v, i) => [String(i), humanSize(v.size), new Date(v.mtime).toISOString().replace("T", " ").slice(0, 19)]),
      );
    }

    case "restore": {
      const path = required(a(2), "restore <path> [index]");
      const index = Number(a(3, "0"));
      const stat = await fs.restore(path, index);
      return ok(`Restored ${path} to version ${index} (${humanSize(stat.size)})`);
    }

    case "use-app": {
      const slug = args._[2];
      if (!slug) die("Missing app. Usage: muhkoo vfs use-app <slug> [--key <appKey>]");
      const saved = await useApp(slug, args.key);
      return ok(
        `Writing as "${saved.slug}". Reads never needed this; writes are now metered to that app.`,
      );
    }

    case "app": {
      const current = await loadConfig();
      const slug = current.vfsApp;
      if (args.json) return json({ app: slug ?? null, known: Object.keys(current.vfsApps ?? {}) });
      if (!slug) {
        return info(
          "Not writing as any app — reads work, writes will not.\n" +
          "Sign one in with: muhkoo vfs use-app <slug> --key <appKey>",
        );
      }
      return info(`Writing as "${slug}".`);
    }

    case "mount": {
      const dir = required(a(2), "mount <dir> [--path /apps]");
      const root = normalizeRoot(args.path ?? "/");
      // Ctrl-C is the way out of a foreground watcher, so it has to be a clean
      // stop that flushes state — not a process kill mid-write.
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await mountDir({ client, dir: resolve(dir), root, signal: controller.signal });
      return ok("Unmounted.");
    }

    case "sweep": {
      const { removed } = await fs.sweep({ force: Boolean(args.force) });
      if (args.json) return json(removed);
      return removed.length
        ? ok(`Reclaimed ${removed.length} orphaned record${removed.length === 1 ? "" : "s"}.`)
        : info("Nothing to reclaim — the filesystem is tidy.");
    }

    default:
      return die(`Unknown subcommand "vfs ${sub}". See \`muhkoo vfs --help\`.`);
  }
  }
}

function required(value, usage) {
  if (!value) die(`Missing argument. Usage: muhkoo vfs ${usage}`);
  return value;
}

function pair(args, usage) {
  const from = args._[2];
  const to = args._[3];
  if (!from || !to) die(`Missing argument. Usage: muhkoo vfs ${usage}`);
  return [from, to];
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Point the CLI at an app, by the domain you use it at.
 *
 * A domain is how a USER knows an app — not a slug, and certainly not a key —
 * and this is meant to work for anyone who uses an app, not only whoever built
 * it. So the app publishes its own public config and we read it from there.
 *
 * It has to come from the app rather than the platform: key plaintexts are
 * never stored server-side (only `keyHashPrefix`), so no API can answer "what
 * is the key for this domain". A publishable key is public by design — it ships
 * in the app's own bundle — so the app serving it at a well-known path gives
 * away nothing that loading the app in a browser does not.
 *
 * A bare slug still works for an app you own and have a key for.
 */
async function useApp(nameOrDomain, key) {
  const cfg = await loadConfig();
  const known = cfg.vfsApps ?? {};
  const looksLikeDomain = nameOrDomain.includes(".");

  if (!key && !known[nameOrDomain] && looksLikeDomain) {
    key = await fetchPublicKey(nameOrDomain);
  }

  if (!key && !known[nameOrDomain]) {
    die(
      `Could not work out the app key for "${nameOrDomain}".\n` +
      (looksLikeDomain
        ? `That app does not publish ${WELL_KNOWN} yet. Pass it once with --key <appKey>.`
        : `Pass it once with --key <appKey>, or use the domain you access the app at.\n` +
          `App keys are shown when an app is created (muhkoo apps create).`),
    );
  }
  const next = key ? { ...known, [nameOrDomain]: key } : known;
  await saveConfig({ ...cfg, vfsApps: next, vfsApp: nameOrDomain });
  return { slug: nameOrDomain, key: next[nameOrDomain] };
}

const WELL_KNOWN = "/.well-known/muhkoo.json";

/** Read an app's published public config. Returns the key, or null. */
async function fetchPublicKey(domain) {
  const host = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const url = `https://${host}${WELL_KNOWN}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.json();
    const key = body?.publishableKey ?? body?.key;
    // Only ever accept a PUBLISHABLE key from a public document. A site that
    // served a secret key here would be leaking it, and storing it because it
    // was offered would make us complicit in that.
    if (typeof key !== "string" || !/_pk_/.test(key)) return null;
    info(`Read ${host}'s public config (app ${body?.slug ?? body?.appId ?? "?"}).`);
    return key;
  } catch {
    return null;
  }
}

/**
 * Read a local file for upload.
 *
 * A missing file is the most likely thing to go wrong here and it is entirely
 * mundane — a typo, or the wrong directory. A Node stack trace for that is
 * noise that buries the one fact that matters: which path was not found.
 */
async function readLocal(path) {
  try {
    return new Uint8Array(await readFile(path));
  } catch (err) {
    if (err.code === "ENOENT") die(`No such file: ${resolve(path)}`);
    if (err.code === "EISDIR") die(`${path} is a directory — put takes a single file.`);
    if (err.code === "EACCES") die(`Cannot read ${path}: permission denied.`);
    throw err;
  }
}

/** A mount root is always an absolute directory path, with no trailing slash. */
function normalizeRoot(path) {
  const p = ("/" + path).replace(/\/+/g, "/").replace(/\/$/, "");
  return p === "" ? "/" : p;
}
