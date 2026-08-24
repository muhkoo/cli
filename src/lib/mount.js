/**
 * `muhkoo vfs mount` — a local directory kept in step with your filesystem.
 *
 * Pulls a subtree to disk, then watches BOTH ends: local edits queue upward,
 * remote changes arrive over the personal space's socket and land on disk.
 *
 * ## Why content hashes, not timestamps
 *
 * Every decision is made from the SHA-256 of file contents ({@link planSync}),
 * never mtimes. Two reasons. Timestamps disagree across machines and survive
 * round-trips badly. And hashing is what makes the echo problem disappear: when
 * we write a file because the VFS changed, the resulting filesystem event
 * hashes to what we just recorded, so it plans to "none" and the loop stops on
 * its own. Suppression by flag or by timing window is the usual approach and it
 * is fragile — an editor that rewrites the file 20ms late defeats it.
 *
 * ## What is deliberately not here
 *
 * No daemon. `mount` runs in the foreground until interrupted, like a dev
 * server, because a background process needs supervision, log rotation and a
 * story for "which mounts are running" that is worth more than a first version.
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { planSync } from "./syncPlan.js";
import { loadIgnores } from "./ignore.js";
import { info, ok, warn } from "./ui.js";

/**
 * Last-resort deny-list, used only for the watcher's fast path.
 *
 * The real rules come from `.vcsignore` (see `./ignore.js`); this exists so a
 * filesystem event under `node_modules` can be dropped without a scan.
 */
const IGNORE = new Set(["node_modules", "dist", "build", "coverage", "target", "vendor", ".git"]);

/**
 * Skip dot-entries by default.
 *
 * The first version listed known-bad names and synced everything else, which is
 * backwards: the set of tool directories a machine accumulates is open-ended and
 * grows without asking. It uploaded a session-tooling directory (`.remember`) to
 * a user's project on first contact with a real repo — a name no deny-list would
 * have contained, because it did not exist when the list was written.
 *
 * Dot-entries are machine state until proven otherwise. `--hidden` opts back in
 * for a project that genuinely keeps source there.
 */
const isHidden = (name) => name.startsWith(".");

/** Dot-files that describe the project rather than the machine. */
const KEEP_HIDDEN = new Set([".vcsignore", ".gitignore"]);

/**
 * Skip anything enormous.
 *
 * The VFS chunks large files happily, but mounting a directory that happens to
 * contain a disk image should not silently upload it. Named limit, loud skip.
 */
const MAX_BYTES = 100 * 1024 * 1024;

/** Coalesce editor churn — a save is often several events in a few ms. */
const SETTLE_MS = 250;

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Where the last-synced view lives, inside the mount. */
const statePath = (dir) => join(dir, ".muhkoo", "mount.json");

/**
 * The last-synced view, but ONLY if it describes the same remote root.
 *
 * State scoped to the directory alone is actively dangerous. It records "these
 * paths were in sync", and `planSync` reads a path that is present locally and
 * in the state but missing remotely as "deleted on the other side" — so pointing
 * the same directory at a DIFFERENT root makes every local file look deleted,
 * and with `--allow-delete` they would be. Re-rooting has to start from scratch.
 */
async function loadState(dir, root) {
    try {
        const saved = JSON.parse(await readFile(statePath(dir), "utf8"));
        // Pre-versioning files were a bare path→hash map with no root recorded.
        // They cannot be shown to be about this root, so they are not trusted.
        if (!saved || saved.v !== 1 || saved.root !== root) return {};
        return saved.paths ?? {};
    } catch {
        return {};   // first sync, or someone cleared it — a full compare is safe
    }
}

async function saveState(dir, root, paths) {
    await mkdir(dirname(statePath(dir)), { recursive: true });
    await writeFile(statePath(dir), JSON.stringify({ v: 1, root, paths }, null, 2) + "\n");
}

/** Hash every syncable file under `dir`, keyed by VFS-style relative path. */
async function scanLocal(dir, includeHidden = false, ignore = () => false) {
    const out = {};
    const walk = async (abs) => {
        let entries;
        try {
            entries = await readdir(abs, { withFileTypes: true });
        } catch {
            return;   // vanished mid-scan; the next pass will see it
        }
        for (const entry of entries) {
            const child = join(abs, entry.name);
            const rel = relative(dir, child).split(sep).join("/");
            // Pruned at the directory, not per file: never descend into
            // node_modules to decide, file by file, not to sync it.
            if (ignore(rel, entry.isDirectory())) continue;
            // `.vcsignore` and `.gitignore` describe the project and belong with
            // it; every other dot-entry is machine state until asked for.
            const keepDotfile = KEEP_HIDDEN.has(entry.name);
            if (!includeHidden && !keepDotfile && isHidden(entry.name)) continue;
            if (entry.isDirectory()) {
                await walk(child);
                continue;
            }
            if (!entry.isFile()) continue;   // sockets, fifos, symlinks: not ours
            try {
                const info = await stat(child);
                if (info.size > MAX_BYTES) {
                    warn(`skipping ${relative(dir, child)} — ${Math.round(info.size / 1e6)} MB is over the mount limit`);
                    continue;
                }
                out["/" + relative(dir, child).split(sep).join("/")] = sha(await readFile(child));
            } catch {
                // Raced with a delete or a permission change; ignore this pass.
            }
        }
    };
    await walk(dir);
    return out;
}

/**
 * Hash every file under the mounted VFS subtree — through the SAME filters as
 * the local scan.
 *
 * These filters used to run in one direction only. They decided what left the
 * machine and nothing decided what arrived, so a remote `.git/config` was
 * hashed here, found no local counterpart, and was written straight into the
 * developer's repository. `core.pager`, `alias.*` and `core.fsmonitor` are
 * shell commands git runs itself, so that is remote code execution on the next
 * ordinary `git status` — no execute bit required.
 *
 * Anything that can write to a user's VFS is therefore a party that can write
 * files onto the machines they mount from. Treat what comes down as untrusted.
 */
export async function scanRemote(vfs, root, includeHidden = false, ignore = () => false) {
    const out = {};
    if (!(await vfs.exists(root))) return out;
    for (const abs of await vfs.walk(root)) {
        const key = abs.slice(root.length) || "/" + abs.split("/").pop();
        const rel = key.replace(/^\//, "");
        if (!rel) continue;
        if (isRefused(rel)) {
            warn(`refusing ${key} from your filesystem — that path can execute code on this machine`);
            continue;
        }
        if (ignore(rel, false)) continue;
        // Same dot-entry rule as `scanLocal`, applied to every segment: a remote
        // `.vscode/tasks.json` is as dangerous as a remote `.vscode`.
        if (!includeHidden && rel.split("/").some((part) => isHidden(part) && !KEEP_HIDDEN.has(part))) continue;
        out[key] = sha(await vfs.readFile(abs));
    }
    return out;
}

/**
 * Paths no flag may bring down, ever.
 *
 * `--hidden` means "sync dot-files", not "let whatever can write my filesystem
 * rewrite my git config". Each of these reaches code execution without needing
 * an execute bit, which is what the 0644 the writer creates would otherwise
 * deny. Matched on the first segment, or the whole path for the bare files.
 */
const REFUSED_DIRS = new Set([".git", ".ssh", ".muhkoo", ".vscode", ".idea", ".config", "node_modules"]);
const REFUSED_FILES = new Set([".envrc", ".npmrc", ".netrc", ".profile", ".bashrc", ".zshrc", ".bash_profile"]);

// Exported for tests: these three ARE the security boundary, so they are worth
// asserting on directly rather than only through a full sync.
export function isRefused(rel) {
    const parts = rel.split("/");
    if (parts.some((part) => REFUSED_DIRS.has(part))) return true;
    return parts.some((part) => REFUSED_FILES.has(part));
}

/**
 * The local path for a synced path, or null when it escapes the mount.
 *
 * The SDK's `normalizePath` collapses `..` before a path ever leaves `walk()`,
 * so traversal is not reachable that way today — but nothing here depended on
 * that, the guarantee lives in another package, and the state file supplies a
 * second source of keys that never passes through it. This makes the property
 * local and checkable.
 */
export function localPathFor(dir, path) {
    const candidate = resolve(join(dir, path.replace(/^\//, "").split("/").join(sep)));
    const rel = relative(dir, candidate);
    if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
    return candidate;
}

/**
 * Is it safe to write here?
 *
 * `writeFile` opens with O_CREAT|O_TRUNC and FOLLOWS symlinks, so a link
 * anywhere in the mounted tree redirects remote content to whatever it points
 * at — the one way content genuinely escapes the mount directory, and it works
 * on every platform. `scanLocal` already refuses to READ anything that is not a
 * regular file (`entry.isFile()`); this makes the write side agree.
 */
async function writable(localAbs) {
    try {
        const info = await lstat(localAbs);
        return info.isFile();
    } catch {
        return true;   // does not exist yet: creating it is fine
    }
}

/**
 * Reconcile once, and return the new last-synced view.
 *
 * Applied sequentially rather than in parallel: writes touch one directory
 * record each, and two concurrent writes to the same record would have one
 * silently lose ([[VfsNamespace]] consistency note).
 */
export async function reconcile({ vfs, dir, root, state, opts = {} }) {
    // Re-read every pass: editing `.vcsignore` should take effect on the next
    // sync, not require a restart.
    const { match } = await loadIgnores(dir, readFile);
    const [local, remote] = await Promise.all([
        scanLocal(dir, opts.hidden, match),
        scanRemote(vfs, root, opts.hidden, match),
    ]);
    const plan = planSync({ last: state, local, remote });
    if (!plan.length) return state;

    const next = { ...state };
    for (const { path, action } of plan) {
        const localAbs = localPathFor(dir, path);
        if (!localAbs) {
            // Warn and skip rather than throw: one bad path must not abandon
            // the rest of the sync.
            warn(`refusing ${path} — it resolves outside ${dir}`);
            delete next[path];
            continue;
        }
        const remoteAbs = root + path;
        try {
            switch (action) {
                case "push": {
                    const bytes = await readFile(localAbs);
                    await vfs.writeFile(remoteAbs, new Uint8Array(bytes));
                    next[path] = sha(bytes);
                    info(`↑ ${path}`);
                    break;
                }
                case "pull": {
                    if (!(await writable(localAbs))) {
                        warn(`skipping ${path} — ${localAbs} is a symlink or not a regular file`);
                        break;
                    }
                    const bytes = await vfs.readFile(remoteAbs);
                    await mkdir(dirname(localAbs), { recursive: true });
                    await writeFile(localAbs, bytes);
                    next[path] = sha(bytes);
                    info(`↓ ${path}`);
                    break;
                }
                case "delete-remote":
                    // Deletes do NOT propagate unless asked for.
                    //
                    // Everything else this tool does is recoverable: an
                    // overwrite leaves the old version in `vfs history`. A
                    // delete is not — removing a file drops its history record
                    // along with it, so the safety net that justifies
                    // last-writer-wins does not cover this case. Losing a file
                    // to a directory you happened to clean up locally is too
                    // high a price for the convenience.
                    if (!opts.allowDelete) {
                        warn(
                            `${path} is gone locally but still in your filesystem — not deleting it.\n` +
                            `  Pass --allow-delete to propagate deletions, or remove it with: muhkoo vfs rm ${remoteAbs}`,
                        );
                        delete next[path];   // stop re-reporting it every pass
                        break;
                    }
                    await vfs.delete(remoteAbs).catch(() => {});
                    delete next[path];
                    info(`✕ ${path} (removed here)`);
                    break;
                case "delete-local":
                    // Gated like the remote direction. `--allow-delete` used to
                    // cover only deletions going UP, so anything able to remove
                    // a file from the filesystem removed it from the
                    // developer's disk with no flag and no prompt — the exact
                    // unrecoverable case the remote branch takes care over.
                    if (!opts.allowDelete) {
                        warn(
                            `${path} is gone from your filesystem but still here — not deleting it locally.\n` +
                            `  Pass --allow-delete to propagate deletions.`,
                        );
                        delete next[path];
                        break;
                    }
                    if (!(await writable(localAbs))) {
                        warn(`skipping ${path} — ${localAbs} is a symlink or not a regular file`);
                        break;
                    }
                    await rm(localAbs, { force: true });
                    delete next[path];
                    info(`✕ ${path} (removed there)`);
                    break;
                case "forget":
                    delete next[path];
                    break;
                case "conflict": {
                    // Local wins, because that is where the person is working —
                    // but say so, and say how to get the other version back. The
                    // VFS keeps history, so this is recoverable rather than lost,
                    // which is the only reason picking a winner is acceptable.
                    const bytes = await readFile(localAbs);
                    await vfs.writeFile(remoteAbs, new Uint8Array(bytes));
                    next[path] = sha(bytes);
                    warn(
                        `conflict on ${path} — kept your local copy.\n` +
                        `  The other version is still there: muhkoo vfs history ${remoteAbs}`,
                    );
                    break;
                }
            }
        } catch (err) {
            warn(`${path}: ${err?.message ?? err}`);
        }
    }
    await saveState(dir, root, next);
    return next;
}

/**
 * Push a directory up once and stop — no watcher.
 *
 * The same scan, plan and reconcile `mount` uses, so the rules about what is
 * skipped and what a delete means are defined in exactly one place. This is the
 * command for "get this project into my filesystem"; `mount` is for "and keep it
 * that way".
 *
 * One process means ONE vault unlock, which is the practical reason this exists
 * rather than a shell loop over `vfs put`: unlocking per file trips the auth
 * rate limiter well before a real project finishes uploading.
 */
export async function importOnce({ client, dir, root, opts = {} }) {
    const vfs = client.vfs;
    const { match, source } = await loadIgnores(dir, readFile);
    const [local, remote] = await Promise.all([
        scanLocal(dir, opts.hidden, match),
        scanRemote(vfs, root, opts.hidden, match),
    ]);
    const state = await loadState(dir, root);
    const plan = planSync({ last: state, local, remote });

    // Say what will happen before spending metered bytes. A project directory
    // is easy to point at the wrong place, and the bytes are billed either way.
    //
    // Sizes are stat'd here rather than carried out of `scanLocal`, which
    // returns hashes — the scan is shared with `mount`, and widening its return
    // shape to serve one caller's progress line is not worth the churn.
    const pushes = plan.filter((p) => p.action === "push");
    const bytes = (
        await Promise.all(
            pushes.map(async ({ path }) => {
                try {
                    return (await stat(join(dir, path.slice(1).split("/").join(sep)))).size;
                } catch {
                    return 0;
                }
            }),
        )
    ).reduce((n, size) => n + size, 0);

    if (opts.dryRun) {
        if (!plan.length) return ok(`${root} already matches ${dir}.`);
        for (const { path, action } of plan) info(`${SIGN[action] ?? "?"} ${path}`);
        info(`\n${plan.length} change(s); ${pushes.length} file(s) to upload, ${human(bytes)}.`);
        return info(`Ignoring per ${describeSource(source)}.`);
    }

    if (!plan.length) return ok(`${root} already matches ${dir} — nothing to do.`);
    info(`Importing ${dir} → ${root} (${pushes.length} file(s), ${human(bytes)}; ignoring per ${describeSource(source)})`);
    await reconcile({ vfs, dir, root, state, opts });
    ok(`Imported into ${root}.`);
    await noteStateFile(dir);
}

/**
 * Mention the state file, once, in a repository that is not ignoring it.
 *
 * `.muhkoo/mount.json` is what makes a later import or mount incremental, so it
 * has to live in the directory — but appearing as an untracked directory with no
 * explanation is the kind of thing people delete, or commit by accident. Saying
 * it here beats editing someone's `.gitignore` for them.
 */
async function noteStateFile(dir) {
    try {
        await stat(join(dir, ".git"));
    } catch {
        return;   // not a repository; nothing to explain
    }
    try {
        const ignores = await readFile(join(dir, ".gitignore"), "utf8");
        if (/^\.muhkoo\/?$/m.test(ignores)) return;
    } catch {
        // no .gitignore: still worth mentioning
    }
    info("  Tracking state is in .muhkoo/ — add it to .gitignore.");
}

const SIGN = {
    push: "\u2191", pull: "\u2193", conflict: "!",
    "delete-remote": "\u2715", "delete-local": "\u2715", forget: "\u00b7",
};

function describeSource(source) {
    if (source === "defaults") return "the built-in Node defaults (write a .vcsignore to change them)";
    if (source === ".gitignore") return ".gitignore (add a .vcsignore to diverge from it)";
    return source;
}

function human(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Mount `root` at `dir` and keep them in step until `signal` aborts.
 */
export async function mount({ client, dir, root, signal, opts = {} }) {
    const vfs = client.vfs;
    await mkdir(dir, { recursive: true });

    let state = await loadState(dir, root);
    info(`Mounting ${root} → ${dir}`);
    state = await reconcile({ vfs, dir, root, state, opts });
    ok("In sync. Watching for changes — press Ctrl-C to stop.");

    // One reconcile at a time, with a trailing pass if anything arrived while we
    // were busy. Without the trailing pass a change landing mid-sync would wait
    // for the NEXT unrelated event to be noticed.
    let running = false;
    let queued = false;
    let timer = null;
    const sync = async () => {
        if (running) {
            queued = true;
            return;
        }
        running = true;
        try {
            state = await reconcile({ vfs, dir, root, state, opts });
        } catch (err) {
            warn(`sync failed: ${err?.message ?? err}`);
        } finally {
            running = false;
            if (queued) {
                queued = false;
                void sync();
            }
        }
    };
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => void sync(), SETTLE_MS);
    };

    const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        // `filename` can be null on some platforms; a bare reconcile is correct
        // either way, so this never has to trust it.
        if (filename && filename.split(sep).some((part) => IGNORE.has(part))) return;
        schedule();
    });

    const unwatchRemote = vfs.watch(() => schedule());

    await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
    });

    clearTimeout(timer);
    watcher.close();
    unwatchRemote();
    await saveState(dir, state);
}
