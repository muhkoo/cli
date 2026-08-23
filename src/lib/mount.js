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
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { planSync } from "./syncPlan.js";
import { info, ok, warn } from "./ui.js";

/** Never sync these. Build output and dependencies belong to the machine. */
const IGNORE = new Set([".git", "node_modules", ".muhkoo", ".DS_Store", "dist", ".cache", ".next"]);

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

async function loadState(dir) {
    try {
        return JSON.parse(await readFile(statePath(dir), "utf8"));
    } catch {
        return {};   // first mount, or someone cleared it — a full compare is safe
    }
}

async function saveState(dir, state) {
    await mkdir(dirname(statePath(dir)), { recursive: true });
    await writeFile(statePath(dir), JSON.stringify(state, null, 2) + "\n");
}

/** Hash every syncable file under `dir`, keyed by VFS-style relative path. */
async function scanLocal(dir) {
    const out = {};
    const walk = async (abs) => {
        let entries;
        try {
            entries = await readdir(abs, { withFileTypes: true });
        } catch {
            return;   // vanished mid-scan; the next pass will see it
        }
        for (const entry of entries) {
            if (IGNORE.has(entry.name)) continue;
            const child = join(abs, entry.name);
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

/** Hash every file under the mounted VFS subtree. */
async function scanRemote(vfs, root) {
    const out = {};
    if (!(await vfs.exists(root))) return out;
    for (const abs of await vfs.walk(root)) {
        out[abs.slice(root.length) || "/" + abs.split("/").pop()] = sha(await vfs.readFile(abs));
    }
    return out;
}

/**
 * Reconcile once, and return the new last-synced view.
 *
 * Applied sequentially rather than in parallel: writes touch one directory
 * record each, and two concurrent writes to the same record would have one
 * silently lose ([[VfsNamespace]] consistency note).
 */
async function reconcile({ vfs, dir, root, state }) {
    const [local, remote] = await Promise.all([scanLocal(dir), scanRemote(vfs, root)]);
    const plan = planSync({ last: state, local, remote });
    if (!plan.length) return state;

    const next = { ...state };
    for (const { path, action } of plan) {
        const localAbs = join(dir, path.slice(1).split("/").join(sep));
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
                    const bytes = await vfs.readFile(remoteAbs);
                    await mkdir(dirname(localAbs), { recursive: true });
                    await writeFile(localAbs, bytes);
                    next[path] = sha(bytes);
                    info(`↓ ${path}`);
                    break;
                }
                case "delete-remote":
                    await vfs.delete(remoteAbs).catch(() => {});
                    delete next[path];
                    info(`✕ ${path} (removed here)`);
                    break;
                case "delete-local":
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
    await saveState(dir, next);
    return next;
}

/**
 * Mount `root` at `dir` and keep them in step until `signal` aborts.
 */
export async function mount({ client, dir, root, signal }) {
    const vfs = client.vfs;
    await mkdir(dir, { recursive: true });

    let state = await loadState(dir);
    info(`Mounting ${root} → ${dir}`);
    state = await reconcile({ vfs, dir, root, state });
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
            state = await reconcile({ vfs, dir, root, state });
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
