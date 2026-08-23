/**
 * What to do about one path, given three views of it.
 *
 * Sync bugs are hard to see and expensive when they land — a wrong answer here
 * silently deletes work — so the decision is a pure function of three content
 * hashes and nothing else:
 *
 *   last    what we last synced (undefined: never synced)
 *   local   what is on disk now (undefined: not there)
 *   remote  what is in the VFS now (undefined: not there)
 *
 * `last` is what makes a DELETE distinguishable from a file that has simply
 * never been seen. Without it, "missing on one side" is ambiguous and the only
 * safe reading is to copy everything back forever.
 */

/**
 * @returns one of:
 *   "none"          nothing to do
 *   "push"          local → VFS
 *   "pull"          VFS → local
 *   "delete-remote" removed locally; remove it there too
 *   "delete-local"  removed remotely; remove it here too
 *   "forget"        gone from both; drop it from state
 *   "conflict"      changed on BOTH sides since the last sync
 */
export function planPath({ last, local, remote }) {
    if (local === undefined && remote === undefined) return last === undefined ? "none" : "forget";

    if (local === undefined) {
        // Only remote has it. If it matches what we last synced, the local copy
        // was deleted; otherwise it is new (or changed) and should come down.
        return last !== undefined && last === remote ? "delete-remote" : "pull";
    }
    if (remote === undefined) {
        return last !== undefined && last === local ? "delete-local" : "push";
    }
    if (local === remote) return "none";          // identical, whatever the history

    if (local === last) return "pull";            // only the remote moved
    if (remote === last) return "push";           // only the local moved
    return "conflict";                            // both moved
}

/** Plan every path across the three views. Returns a list of {path, action}. */
export function planSync({ last, local, remote }) {
    const paths = new Set([...Object.keys(last), ...Object.keys(local), ...Object.keys(remote)]);
    const plan = [];
    for (const path of [...paths].sort()) {
        const action = planPath({ last: last[path], local: local[path], remote: remote[path] });
        if (action !== "none") plan.push({ path, action });
    }
    return plan;
}
