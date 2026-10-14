/**
 * `muhkoo vfs` — your Muhkoo filesystem from the terminal.
 *
 * Drives `client.vfs` through the SDK, the same code the IDE runs. The
 * directory records are encrypted with keys chained parent-to-child, so a
 * separate HTTP implementation here would be a second copy of that format to
 * keep byte-exact — and the first one to drift would corrupt real files.
 */

import { lstat, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { openClient, explainWriteFailure } from "../lib/vfs.js";
import { mount as mountDir, importOnce, previewMount, heldBack, acceptIgnores, diskIgnoreTexts, assertMountable, mountTarget } from "../lib/mount.js";
import { draftIgnores, ignoreFileProblem } from "../lib/ignore.js";
import { loadConfig, saveConfig } from "../lib/config.js";
import { table, json, ok, info, warn, die, writeText, prompt } from "../lib/ui.js";

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
  muhkoo vfs ignore [dir]                show whether ignore rules this directory
                                        used earlier still hold files back, which
                                        ignore files changed, and which local
                                        files they hold
  muhkoo vfs ignore [dir] --accept       show what accepting would let through,
                                        and a digest of the ignore files as they
                                        now stand (on a terminal, asks y/N)
  muhkoo vfs ignore [dir] --accept <d>   make exactly the files with digest <d> the
                                        only rules; refused if they changed since
                                        (a running mount acts on it at once)
  muhkoo vfs ignore [dir] --draft        print a .vcsignore drafted from the Node
                                        defaults + every .gitignore and
                                        .git/info/exclude on disk (it replaces them
                                        all); --write saves it (--force to replace),
                                        unless it is past an ignore file's limits
  muhkoo vfs import <dir…> [--path <p>]  upload whole projects, once. Each <dir> is a
                                        folder on this computer; --path is the Muhkoo
                                        path it goes to (default /apps/<its name>).
                                        Upload only: never writes or deletes
                                        anything here
  muhkoo vfs mount <dir> [--path <p>]    sync a subtree to disk and keep it live.
                                        <dir> is the folder on this computer, made
                                        if missing (but not the folders above it);
                                        --path is the Muhkoo path to sync, e.g.
                                        /apps/my-app (default /)
                                        (dot-files skipped; deletes need --allow-delete;
                                        Ctrl-C or closing the terminal stops it after
                                        the current file; a second Ctrl-C quits now)
  muhkoo vfs sweep [--force]             reclaim orphaned records
  muhkoo vfs use-app <domain>            use an app, by the domain you use it at
  muhkoo vfs app                         show which app you are writing as

What gets synced is decided by .vcsignore if there is one. Otherwise git's
rules apply: every .gitignore, each scoped to its own directory, and
.git/info/exclude. Built-in Node defaults sit underneath either way (they
exclude .env and .env.*, but not .env.example).

Once a path has been kept home, no edit to an ignore file lets it sync —
pulled or local, a rule removed or a blank line added. Each directory keeps
every set of ignore rules it has used since the last accept
(.muhkoo/ignore-rules.json, never synced, with a copy under ~/.muhkoo), and a
path is ignored if any of them, or the files as they now stand, ignore it.
New exclusions apply at once; a loosening waits until you accept it:
\`muhkoo vfs ignore <dir> --accept\` shows what that lets through, which ignore
files changed, and the digest that accepts exactly those files. Check them
first — one that came from your filesystem may not be yours. Comments, blank
lines and line endings change nothing, and neither does going back to rules
already kept; any other change to the ignore files — a rule added, removed or
reworded, a file added or removed, here or from your filesystem — is kept as
another set of rules, up to 64 or 2 MB. Past that, or if the stored rules
cannot be read, nothing syncs until you accept. An ignore file from your
filesystem too large to read as rules is not pulled. Until every ignore file
due has come down, nothing uploads. A path too costly to match against the
rules is left alone — neither synced nor deleted — and named.

Some paths never sync in either direction, whatever the rules say: .git,
.ssh, node_modules, .muhkoo, editor and agent config (.vscode, .idea, .claude,
.cursor, .zed, .fleet), .husky, and shell and credential files (.npmrc,
.netrc, .zshrc, .zshenv, …). Neither import nor mount will run on your home
directory, or on anything that contains it. One pass of mount pulls at most
2 GiB or 10,000 files, and reads at most as much to compare, carrying on at
once in another pass; what it has read before it does not read again. A pull
leaves the disk 5% of its space free, at least 1 GiB and at most 10 GiB —
judged by the bytes that arrive, not the sizes your filesystem reports.
Ignore files are held to these limits like any other file.

Reading your files is free. WRITING stores bytes, which are metered to an
app — so put, rm, cp, mv and restore need an app signed in first.

Options:
  --app <name>   write as this app for one command
  --key <k>      supply the app key yourself (apps that publish their public
                 config at /.well-known/muhkoo.json need no key)
  --allow-delete propagate deletions (import: only to your filesystem). OFF by
                 default: a delete removes the file's history too, so unlike an
                 overwrite it cannot be undone. It trusts the remote side. A pass
                 that would leave fewer than half the files this run has tracked,
                 or delete anything when one side is empty, deletes nothing in
                 that direction and says why — a guard against a broken or
                 missing root, not against whatever can write your filesystem
  --hidden       also sync dot-files and dot-directories (never the ones above)
  --dry-run      import: list what would be uploaded, the total size, and what
                 import skips. mount: list what mounting would download,
                 upload and delete, then stop. Neither writes anything, here,
                 in your filesystem or under ~/.muhkoo, and neither pairs this
                 machine (it signs in for the one command if it must)
  --no-pair      unlock for this command only; pair nothing to this machine`;

export default async function vfs(args) {
  const sub = args._[1];
  if (sub === undefined) return die("Missing subcommand. See `muhkoo vfs --help`.");

  // Purely local subcommands run BEFORE the client exists. Unlocking the vault
  // to write a file on this disk is both pointless and expensive: each unlock
  // is a vault read, and a loop over a dozen projects trips the auth rate
  // limiter long before it finishes.
  if (sub === "ignore") return ignoreCommand(args);

  // Where to sync is checked before the session opens, which can ask for a
  // password: `vfs mount /apps/x --path ./`, the two swapped, unlocked the
  // vault and then set about creating /apps at the top of this disk.
  const mounting = sub === "mount" ? await mountArgs(args) : null;
  if ((sub === "import" || sub === "push") && args.path !== undefined) {
    const problem = pathProblem(args.path);
    if (problem) return die(pathError("import into", problem));
  }

  // A dry run writes nothing, and that includes ~/.muhkoo: unlocking would
  // otherwise pair a machine not paired yet (a device enrolled on the server,
  // its key saved) and reset a stale working directory. It unlocks for this
  // command only. A swallowed directory (`--dry-run <dir>`) still counts.
  const dryRun = (sub === "import" || sub === "push" || sub === "mount") && Boolean(args["dry-run"]);
  const client = await openClient(dryRun ? { ...args, pair: false, readOnly: true } : args);
  const fs = client.vfs;
  const a = (n, dflt) => args._[n] ?? dflt;

  try {
    return await run();
  } catch (err) {
    const explained = explainWriteFailure(err, await loadConfig());
    if (explained) die(...explained);
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
      writeText(await fs.readText(path));
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
      // `-r` arrives as a POSITIONAL: the shared parser only understands
      // `--flags`. Filter it out before reading the path, so `rm -r <path>` and
      // `rm <path> -r` both work and neither tries to delete a file named "-r".
      const recursive = args._.includes("-r") || Boolean(args.r || args.recursive);
      const path = required(args._.filter((t) => t !== "-r")[2], "rm <path> [-r]");
      await fs.delete(path, { recursive });
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
          "Not writing as any app — reads work, writes will not.",
          "Sign one in with: muhkoo vfs use-app <slug> --key <appKey>",
        );
      }
      return info(`Writing as "${slug}".`);
    }

    case "import":
    case "push": {
      const { flags, positionals: dirs } = booleanFlags(args, ["hidden", "allow-delete", "dry-run", "no-pair"]);
      if (!dirs.length) return die("Usage: muhkoo vfs import <dir…> [--path /apps/<slug>]");
      // `--path` names ONE destination, so it cannot mean anything sensible for
      // several directories at once.
      if (dirs.length > 1 && args.path) {
        return die("--path takes a single directory. Without it each one goes to /apps/<its name>.");
      }

      // Several directories in ONE process, on purpose: every invocation of the
      // CLI unlocks the vault, and a shell loop over a dozen projects trips the
      // auth rate limiter before it finishes.
      const opts = { hidden: flags.hidden, allowDelete: flags["allow-delete"], dryRun: flags["dry-run"] };
      let failed = 0;
      for (const d of dirs) {
        const root = normalizeRoot(args.path ?? `/apps/${await slugFor(resolve(d))}`);   // --path checked above
        try {
          await importOnce({ client, dir: resolve(d), root, opts });
        } catch (err) {
          // One unreadable project must not abandon the other twelve.
          warn(`${d}: ${err?.message ?? err}`);
          failed++;
        }
      }
      // ...but it must still fail the command, or `import ~ && deploy` carries
      // on as if it had worked. `die`, not `process.exitCode`: the launcher
      // exits 0 explicitly once a command returns.
      if (failed) return die(`${failed} of ${dirs.length} director${dirs.length === 1 ? "y was" : "ies were"} not imported — see above.`);
      return;
    }

    case "mount": {
      const { dir, root, flags } = mounting;
      if (flags["dry-run"]) {
        return previewMount({ client, dir, root, opts: { allowDelete: flags["allow-delete"], hidden: flags.hidden } });
      }
      // Ctrl-C is the way out of a foreground watcher, so it has to be a clean
      // stop that flushes state — not a process kill mid-write.
      // A closed terminal (SIGHUP) is the same request: killed outright, a
      // pass could stop between writing a pulled file and recording it.
      const controller = new AbortController();
      const stop = stopOnSignals(controller);
      const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
      for (const sig of signals) process.on(sig, stop);
      try {
        await mountDir({
          client, dir, root, signal: controller.signal,
          opts: { allowDelete: flags["allow-delete"], hidden: flags.hidden },
        });
      } finally {
        for (const sig of signals) process.off(sig, stop);
      }
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

/**
 * `vfs ignore`: what the ignore ratchet holds back, accepting the ignore files
 * as they now stand, and drafting a `.vcsignore`. Local only — no session, no
 * network.
 */
async function ignoreCommand(args) {
  // `--accept <digest>`: the shared parser hands the flag the next word, which
  // is either the digest a preview printed or — `--accept ~/proj` — the
  // directory, taken as one below.
  const digest = typeof args.accept === "string" && DIGEST.test(args.accept) ? args.accept : undefined;
  const { flags, positionals: named } = booleanFlags(digest ? { ...args, accept: true } : args, ["accept", "draft", "write", "force", "hidden"]);
  if (named.length > 1) return die(`vfs ignore takes one directory, not ${named.length}: ${named.join(", ")}`);
  const on = (flag) => flags[flag];
  const dir = resolve(named[0] ?? ".");
  // Accepting, or writing a draft, would otherwise create the directory.
  if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) return die(`${dir} does not exist, or is not a directory.`);
  if (on("write") || on("draft")) return draftIgnoreFile(dir, { write: on("write"), force: on("force") });
  if (on("accept")) return acceptCommand(dir, digest);

  const shown = await heldBack(dir);
  if (shown.unreadable) return die(shown.unreadable.message);
  if (!shown.mounted) return info(`${dir} has no stored ignore rules: it has not been mounted or imported here.`);
  if (!shown.inForce) {
    return info(
      `Nothing in ${dir} is held back: the ignore files as they now stand are the ones last accepted.`,
      "(`--draft` prints a .vcsignore drafted from them; `--write` saves it.)",
    );
  }
  showHeld(dir, shown);
  return info("", `To see what accepting the ignore files as they now stand would let through: muhkoo vfs ignore ${dir} --accept`);
}

/** A digest `--accept` prints, and takes back. */
const DIGEST = /^[0-9a-f]{16}$/;

/** What the older rules still hold, as `vfs ignore` and `--accept` both show it. */
function showHeld(dir, { changed, held }) {
  info(`Ignore rules ${dir} used earlier — when they were last accepted, or since — still apply here, beside the files as they now stand.`);
  if (changed.length) info("Changed since they were last accepted — check them, since one that came from your filesystem may not be yours:", ...changed.map((c) => `  ${c}`));
  if (held.length) info("Local files they hold back, which accepting lets through:", ...held.map((p) => `  ${p}`));
  else info("No local file is held back by them; accepting only tidies the stored rules.");
  info("Files arriving from your filesystem that they keep out may be held too, and would then come down.");
}

/**
 * `--accept`: show what accepting lets through, with a digest of the ignore
 * files as they now stand; `--accept <digest>` accepts exactly those, and
 * refuses when they have changed since. On a terminal it asks instead, and
 * accepts the files it showed — the same digest, checked the same way.
 *
 * Bound to what was shown, because an accept adopts whatever ignore files are
 * on disk, one that arrived from elsewhere included: `--accept --yes` re-read
 * the disk, so a file that landed after the preview was adopted unseen.
 */
async function acceptCommand(dir, digest) {
  try {
    await assertMountable(dir);
  } catch (err) {
    return die(err?.message ?? String(err));
  }
  const shown = await heldBack(dir);
  if (!shown.mounted) return die(`${dir} has never been mounted or imported, so it has no ignore rules to accept.`);
  if (digest) return accept(dir, digest);
  if (shown.unreadable) warn(shown.unreadable.message, "  So what accepting lets through cannot be listed.");
  else if (!shown.inForce) return info(`Nothing to accept: the ignore files in ${dir} as they now stand are the ones last accepted.`);
  else showHeld(dir, shown);
  info("", `Those are the ignore files as they now stand (digest ${shown.digest}). To accept exactly them: muhkoo vfs ignore ${dir} --accept ${shown.digest}`);
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return;
  if (!/^y(es)?$/i.test(await prompt("Accept them now? [y/N] "))) return info("Not accepted — nothing has changed.");
  return accept(dir, shown.digest);
}

async function accept(dir, digest) {
  let eligible;
  try {
    ({ eligible } = await acceptIgnores(dir, digest));
  } catch (err) {
    return die(err?.message ?? String(err));
  }
  return ok(
    `Accepted the ignore files in ${dir} as they now stand: only they decide what syncs from now on.`,
    ...(eligible?.length ? [`  Now eligible to sync: ${eligible.join(", ")}`] : []),
    "  A running `muhkoo vfs mount` acts on this at once.",
  );
}

/**
 * Draft a `.vcsignore` from every ignore file git reads, as it stands on disk,
 * and print it — or with --write, save it.
 *
 * From every file, not the root `.gitignore` alone: a `.vcsignore` replaces
 * them all, so leaving the nested ones out switched them off. From the files
 * ON DISK: the draft is what the directory says now. Writing a looser
 * `.vcsignore` than the rules it replaces lets nothing new through until it is
 * accepted — the ignore ratchet holds whatever the older rules excluded.
 */
async function draftIgnoreFile(dir, { write, force }) {
  const target = `${dir}/.vcsignore`;
  const existing = await readFile(target, "utf8").catch(() => null);
  if (write && existing && !force) {
    return die(`${target} already exists. Pass --force to replace it.`);
  }
  const texts = await diskIgnoreTexts(dir);
  const draft = draftIgnores(texts);
  const carried = [...texts.keys()].filter((file) => file !== ".gitignore");
  const note = carried.length ? [`  Carried over: ${carried.join(", ")} — a .vcsignore replaces them all.`] : [];
  // One flat file of what several said can be past what one ignore file may
  // hold. Written, it would stop every pass that read it.
  const problem = ignoreFileProblem(draft);
  const refusal = problem && [
    `A .vcsignore drafted from them would not be read: ${problem}.`,
    "  Without a .vcsignore the mount reads every .gitignore as git does, so there is no need for one to keep them.",
  ];
  if (!write) {
    info(...draft.replace(/\n$/, "").split("\n"));
    if (refusal) warn(...refusal);
    return info("", `(nothing written — pass --write to save this to ${target})`, ...note);
  }
  if (refusal) return die(`Not written. ${refusal[0]}`, ...refusal.slice(1));
  await writeFile(target, draft);
  return ok(`Wrote ${target}`, ...note);
}

/**
 * The signal handler for a running mount: the first Ctrl-C stops it after the
 * step under way, the second quits at once.
 *
 * A step can be a 100MB file on a slow link, and waiting on it in silence
 * read as a hang — and a second Ctrl-C did nothing, leaving kill as the way
 * out. Quitting mid-step is safe: every file lands by rename, so a hard exit
 * leaves the old file or the new one, and the next pass sorts out the rest.
 */
export function stopOnSignals(controller, { exit = (code) => process.exit(code) } = {}) {
  return () => {
    if (controller.signal.aborted) return exit(130);
    info("Stopping after the current file — press Ctrl-C again to quit now.");
    controller.abort();
  };
}

/**
 * Where a project belongs in the filesystem.
 *
 * The app's own slug when the directory declares one, because that is the name
 * everything else addresses it by: the portal opens the IDE at `?app=<slug>`,
 * and the IDE reads `/apps/<slug>`. A project imported under its DIRECTORY name
 * is invisible to both whenever the two differ — which they do for half of these
 * (`portfolio` is `mattgagliardo`, `theater` is `muhkoo-theater`).
 *
 * Falls back to the directory name, which is right for a project that is not
 * deployed anywhere yet.
 */
async function slugFor(dir) {
  const declared = await readFile(`${dir}/.muhkoo-app.json`, "utf8")
    .then((raw) => JSON.parse(raw).slug)
    .catch(() => null);
  return declared || basename(dir);
}

/**
 * `vfs mount`'s folder, Muhkoo path and switches, checked before the session
 * opens: `{ dir, root, flags }`, with `dir` resolved.
 *
 * `<dir>` is the folder on this computer and `--path` the Muhkoo path. When
 * `<dir>` reads as a Muhkoo path instead — absolute, starting at a folder this
 * computer does not have (`/apps`), and --path either not given or refused —
 * the error carries the command with the two swapped. A folder mistyped here,
 * such as /Users/me/GitHub/tpyo/app, starts at one it has, and gets no
 * suggestion. It is only ever suggested, never run: a mount writes into the
 * folder, and with --allow-delete deletes there, so a guess is not acted on.
 */
async function mountArgs(args) {
  const { flags, positionals } = booleanFlags(args, ["hidden", "allow-delete", "dry-run", "no-pair"]);
  if (positionals.length > 1) return die(`vfs mount takes one directory, not ${positionals.length}: ${positionals.join(", ")}`);
  const dir = required(positionals[0], "mount <dir> [--path /apps]");
  const given = args.path !== undefined;
  const problem = given ? pathProblem(args.path) : null;
  const suggestion = async () => {
    if ((given && !problem) || !isAbsolute(dir)) return [];
    const here = await lstat(topFolder(dir)).then(() => true, (err) => err.code !== "ENOENT");
    if (here) return [];
    return [`  Did you mean: ${swappedCommand(args, flags, problem?.local ? args.path : null, dir)}`];
  };
  if (problem) return die(pathError("mount", problem), ...(await suggestion()));
  try {
    await mountTarget(resolve(dir));
  } catch (err) {
    return die(err?.message ?? String(err), ...(await suggestion()));
  }
  return { dir: resolve(dir), root: normalizeRoot(args.path ?? "/"), flags };
}

/** The folder at the top of absolute `path`: /apps for /apps/my-app. */
function topFolder(path) {
  let top = resolve(path);
  while (dirname(top) !== dirname(dirname(top))) top = dirname(top);
  return top;
}

/**
 * Why `value`, given as --path, cannot be a Muhkoo path, or null when it can.
 *
 * --path names a place in your Muhkoo filesystem, never a folder here, so what
 * reads as one is refused: a `.` or `..` segment, or a leading `~`. `./` used
 * to become the Muhkoo root "/.", accepted without a word. No value at all is
 * refused too: an empty one read as "/". A missing leading slash is still
 * forgiven, as before: `apps/x` is /apps/x.
 */
function pathProblem(value) {
  if (typeof value !== "string" || value === "") return { why: "It was given no value." };
  if (value.startsWith("~") || value.split("/").some((part) => part === "." || part === "..")) {
    return { why: `"${value}" looks like a folder on this computer.`, local: true };
  }
  return null;
}

/** The one error for a refused --path. `verb`: what the Muhkoo path is for. */
function pathError(verb, { why }) {
  return `--path is the Muhkoo path to ${verb}, starting with / (for example --path /apps/my-app). ${why}`;
}

/**
 * `muhkoo vfs mount <folder> --path <dir>`: the command given, with the folder
 * and the Muhkoo path the other way round. `folder` is the refused --path
 * when it read as a folder here, or a placeholder. The other options come
 * along, so a dry run stays one; a key is never printed.
 */
function swappedCommand(args, flags, folder, dir) {
  const words = ["muhkoo", "vfs", "mount", folder === null ? "<folder>" : shellWord(folder), "--path", shellWord(dir)];
  for (const [name, value] of Object.entries(args)) {
    if (name === "_" || name === "path") continue;
    if (name in flags) {
      if (flags[name]) words.push(`--${name}`);
    } else if (name === "key") {
      words.push("--key <key>");
    } else {
      words.push(value === true ? `--${name}` : `--${name} ${shellWord(String(value))}`);
    }
  }
  return words.join(" ");
}

/** `word` as a shell reads it back: quoted unless it is made of the plainest characters. */
function shellWord(word) {
  return /^[\w@%+=:,./~-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/**
 * `names` read as on/off switches, and the positionals from index 2 on.
 *
 * The shared parser gives a flag the next word as its value, so a flag given
 * before a directory swallowed it: `vfs import ~/a --dry-run ~/b` dry-ran
 * ~/a and skipped ~/b without a word, and `vfs mount --allow-delete ~/proj`
 * died asking for a directory. A string value of a switch is a positional.
 */
function booleanFlags(args, names) {
  const flags = {};
  const positionals = args._.slice(2);
  for (const name of names) {
    flags[name] = Boolean(args[name]);
    if (typeof args[name] === "string") positionals.push(args[name]);
  }
  return { flags, positionals };
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
      `Could not work out the app key for "${nameOrDomain}".`,
      ...(looksLikeDomain
        ? [`That app does not publish ${WELL_KNOWN} yet. Pass it once with --key <appKey>.`]
        : [
            `Pass it once with --key <appKey>, or use the domain you access the app at.`,
            `App keys are shown when an app is created (muhkoo apps create).`,
          ]),
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

/**
 * A mount root is always an absolute directory path, with no trailing slash.
 * A --path reaches here only once `pathProblem` has passed it.
 */
function normalizeRoot(path) {
  const p = ("/" + path).replace(/\/+/g, "/").replace(/\/$/, "");
  return p === "" ? "/" : p;
}
