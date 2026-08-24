/**
 * `muhkoo vcs` — version control over your Muhkoo filesystem.
 *
 * Drives `client.vcs` through the SDK, for the same reason `muhkoo vfs` does:
 * commit hashes are computed from a canonical encoding, and a second
 * implementation here would only have to agree byte-for-byte forever. The first
 * one to drift would fork the history of a project silently.
 *
 * There is no `push` or `pull`. The repository already lives in your account
 * rather than on your disk, so every machine you sign in from is looking at the
 * same objects — there is nowhere to push it to.
 */

import { openClient } from "../lib/vfs.js";
import { loadConfig, saveConfig } from "../lib/config.js";
import { table, json, ok, info, warn, die, c } from "../lib/ui.js";

export const help = `muhkoo vcs — version control for your projects

Usage:
  muhkoo vcs status                      what has changed since the last commit
  muhkoo vcs commit -m <message>         record the current state
  muhkoo vcs log [-n <count>]            history, newest first
  muhkoo vcs show <commit>               what one commit changed
  muhkoo vcs diff [<a>] [<b>]            compare two commits (default: last vs now)
  muhkoo vcs branch [<name>]             list branches, or start one here
  muhkoo vcs switch <name>               move onto a branch
  muhkoo vcs checkout <commit>           inspect an old state (detaches HEAD)
  muhkoo vcs merge <name>                bring a branch into this one
  muhkoo vcs restore <path> [<commit>]   put one file back

Options:
  --project <slug>   which project (default: taken from your vfs working
                     directory, so \`vfs cd /apps/my-app\` then \`vcs log\`)
  -m <message>       the commit message
  -n <count>         how many entries to show
  --discard          throw away uncommitted changes instead of refusing to move
  --json             machine-readable output

There is no push or pull: the repository lives in your account, so every
machine you sign in from already has it.`;

export default async function vcs(args) {
  const sub = args._[1];
  if (sub === undefined) return die("Missing subcommand. See `muhkoo vcs --help`.");

  // `-m "message"` and `-n 20`, pulled out of the positionals by hand.
  //
  // The shared parser only understands `--flags`, and teaching it single-dash
  // options would break the commands that pass `-r` and friends as positionals.
  // Committing without `-m` is muscle memory though, so it is worth the seam.
  const message = pullFlag(args, "-m") ?? args.message ?? (args.m === true ? undefined : args.m);
  const count = pullFlag(args, "-n") ?? args.n;

  const client = await openClient(args);
  const slug = await resolveProject(args);
  const repo = client.vcs.open(slug);
  const a = (n, dflt) => args._[n] ?? dflt;

  switch (sub) {
    case "status": {
      const changes = await repo.status();
      const branch = (await repo.currentBranch()) ?? `${c.dim("detached at")} ${short(await repo.current())}`;
      const pending = await repo.pendingMerge();
      if (args.json) return json({ project: slug, branch, changes, merging: pending?.name ?? null });

      info(`${c.bold(slug)} on ${branch}`);
      if (pending) warn(`Merging ${pending.name} — resolve the files below, then commit to finish it.`);
      if (!changes.length) return info("Nothing has changed since the last commit.");
      return table(["", "PATH"], changes.map((ch) => [mark(ch.kind), ch.path]));
    }

    case "commit": {
      if (!message) return die("A commit needs a message: `muhkoo vcs commit -m \"what changed\"`");
      const hash = await repo.commit(String(message));
      return ok(`${short(hash)}  ${message}`);
    }

    case "log": {
      const entries = await repo.log(Number(count ?? 20));
      if (args.json) return json(entries);
      if (!entries.length) return info("No commits yet.");
      return table(
        ["COMMIT", "WHEN", "MESSAGE"],
        entries.map((e) => [
          short(e.hash) + (e.parents.length > 1 ? c.dim(" (merge)") : ""),
          when(e.at),
          e.message,
        ]),
      );
    }

    case "show": {
      const hash = await repo.resolve(required(a(2), "show <commit>"));
      // The first commit has no parent to compare against; everything in it is
      // an addition, which is what `diff(null, …)` reports.
      const parent = await parentOf(repo, hash);
      const changes = await repo.diff(parent, hash);
      if (args.json) return json(changes);
      return table(["", "PATH"], changes.map((ch) => [mark(ch.kind), ch.path]));
    }

    case "diff": {
      // No arguments means the question people actually ask: what have I
      // changed that is not committed yet.
      if (a(2) === undefined) {
        const pending = await repo.status();
        if (args.json) return json(pending);
        if (!pending.length) return info("No differences.");
        return table(["", "PATH"], pending.map((ch) => [mark(ch.kind), ch.path]));
      }
      const from = await repo.resolve(a(2));
      const to = a(3) === undefined ? await repo.resolve("HEAD") : await repo.resolve(a(3));
      const changes = await repo.diff(from, to);
      if (args.json) return json(changes);
      if (!changes.length) return info("No differences.");
      return table(["", "PATH"], changes.map((ch) => [mark(ch.kind), ch.path]));
    }

    case "branch": {
      const name = a(2);
      if (name) {
        await repo.branch(name);
        return ok(`Branch ${name} starts here. \`muhkoo vcs switch ${name}\` to move onto it.`);
      }
      const branches = await repo.branches();
      const current = await repo.currentBranch();
      if (args.json) return json({ branches, current });
      if (!branches.length) return info("No branches yet — commit something first.");
      return table(["", "BRANCH"], branches.map((b) => [b === current ? "*" : " ", b]));
    }

    case "switch": {
      const name = required(a(2), "switch <name>");
      await repo.switchTo(name, { discardChanges: Boolean(args.discard) });
      return ok(`On ${name}.`);
    }

    case "checkout": {
      const hash = await repo.resolve(required(a(2), "checkout <commit>"));
      await repo.checkout(hash, { discardChanges: Boolean(args.discard) });
      // Say what happened, not just that it worked: a detached HEAD surprises
      // people, and committing from one loses work if they did not expect it.
      return ok(
        `Your files are as they were at ${short(hash)}. HEAD is detached — ` +
          `\`muhkoo vcs switch <branch>\` to go back to working normally.`,
      );
    }

    case "merge": {
      const name = required(a(2), "merge <name>");
      const result = await repo.merge(name, { discardChanges: Boolean(args.discard) });
      if (result.kind === "up-to-date") return info(`Already up to date with ${name}.`);
      if (result.kind === "fast-forward") return ok(`Fast-forwarded to ${short(result.commit)}.`);
      if (result.kind === "merged") return ok(`Merged ${name} — ${short(result.commit)}.`);

      warn(`Merged ${name}, but ${result.conflicts.length} file(s) need you:`);
      table(["", "PATH"], result.conflicts.map((cf) => [c.dim(cf.reason), cf.path]));
      return info("Edit them, then `muhkoo vcs commit -m \"...\"` to finish the merge.");
    }

    case "restore": {
      const path = required(a(2), "restore <path> [<commit>]");
      await repo.restore(path, a(3));
      return ok(`Restored ${path}.`);
    }

    default:
      return die(`Unknown subcommand "${sub}". See \`muhkoo vcs --help\`.`);
  }
}

/**
 * Which project this command is about.
 *
 * Taken from the VFS working directory when it can be, so `vfs cd /apps/my-app`
 * followed by `vcs log` does what you would expect rather than making you name
 * the project twice.
 */
async function resolveProject(args) {
  if (args.project) return String(args.project);
  const cfg = await loadConfig();
  const cwd = cfg.vfsCwd ?? "/";
  const match = cwd.match(/^\/apps\/([^/]+)/);
  if (match) return match[1];
  return die(
    "Which project? Pass `--project <slug>`, or `muhkoo vfs cd /apps/<slug>` first.",
  );
}

/**
 * Take a `-x value` pair out of the positionals and return the value.
 *
 * Mutates `args._` so the positional indices the subcommands read still line up
 * with what the user typed.
 */
function pullFlag(args, flag) {
  const i = args._.indexOf(flag);
  if (i === -1) return undefined;
  const [, value] = args._.splice(i, 2);
  return value;
}

/** A commit's first parent, or null for the very first commit. */
async function parentOf(repo, hash) {
  try {
    return await repo.resolve(`${hash}^`);
  } catch {
    return null;
  }
}

function required(value, usage) {
  if (value === undefined) die(`Usage: muhkoo vcs ${usage}`);
  return value;
}

/** Commit hashes are long; the first 8 characters identify one in practice. */
function short(hash) {
  return hash ? String(hash).slice(0, 8) : "-";
}

function mark(kind) {
  return kind === "added" ? c.dim("+") : kind === "removed" ? c.dim("-") : c.dim("~");
}

function when(at) {
  return new Date(at).toISOString().replace("T", " ").slice(0, 16);
}
