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

/**
 * Plan every path across the three views. Returns a list of {path, action}.
 *
 * `unknown` lists paths — or directories, covering everything beneath them —
 * that one side deliberately did not look at: refused, over the size limit,
 * unreadable. Such a path is not ABSENT, and the difference is the whole game:
 * "not in this view" plus "in the last-synced state" is how a deletion is
 * recognised, so a filter read as an absence plans a delete. That is how the
 * local `.git` was deleted when only one side refused it, how a 100MB asset
 * lost its history to a size limit only one side applied, and how one failed
 * read would have cost the local copy. Nothing is planned for an unknown path,
 * so its state entry stays exactly as it was.
 */
export function planSync({ last, local, remote, unknown = [] }) {
    const isUnknown = coveredBy(unknown);
    const paths = new Set([...Object.keys(last), ...Object.keys(local), ...Object.keys(remote)]);
    const plan = [];
    for (const path of [...paths].sort()) {
        if (isUnknown(path)) continue;
        const action = planPath({ last: last[path], local: local[path], remote: remote[path] });
        if (action !== "none") plan.push({ path, action });
    }
    return plan;
}

/**
 * `(path) => boolean`: is `path`, or a directory above it, in `prefixes`?
 *
 * Walked one segment at a time down a tree of them. Slicing and hashing each
 * prefix afresh cost a path its length times its depth — a thousand remote
 * paths 61 deep of 240-character names held the event loop for half a second.
 */
function coveredBy(prefixes) {
    const END = Symbol("end");
    const root = new Map();
    for (const p of prefixes) {
        let node = root;
        for (const seg of p.split("/").slice(1)) {
            if (!node.has(seg)) node.set(seg, new Map());
            node = node.get(seg);
        }
        node.set(END, true);
    }
    if (!root.size) return () => false;
    return (path) => {
        let node = root;
        for (let at = 1; ; ) {
            const next = path.indexOf("/", at);
            node = node.get(next === -1 ? path.slice(at) : path.slice(at, next));
            if (!node) return false;
            if (node.has(END)) return true;
            if (next === -1) return false;
            at = next + 1;
        }
    };
}

/**
 * The circuit breaker: hold back a pass's deletions in a direction when there
 * are more than MASS_DELETE_FLOOR of them AND they would leave fewer than half
 * of the paths tracked — measured against the most this session has tracked
 * (`peak`), so deletes sliced across passes add up rather than each slice
 * being judged against what the last one left.
 *
 * Deletion is the one action that cannot be undone — a delete drops the VFS
 * history record, and a local delete removes what may be the last copy — and
 * the ways a sync goes wrong all look the same from here: a remote root that
 * was renamed or went missing, a walk that came back empty, a local directory
 * wiped by a checkout, read as "the user deleted everything". People delete a
 * few files at a time; they do not delete most of a project between two
 * passes of a sync. Half is the line: past it, the plan is more likely a
 * broken view than an edit.
 *
 * The floor exists for small projects, where "most of the files" is two or
 * three and an ordinary cleanup crosses half. Three is small enough that a
 * broken view of a small project costs at most three files — the same as the
 * cleanups it lets through — and large enough that deleting a couple of files
 * from a four-file project is not treated as an emergency.
 *
 * An EMPTY view is held whatever the count. The count rule alone let a small
 * project's local copy go when the remote came back empty — three of three
 * is not more than the floor — and an empty side with a non-empty history is
 * the broken view in its plainest form. `views` gives how many files each
 * side holds this pass; a delete-local needs something remote, and a
 * delete-remote something local. The cost is that deleting the LAST file of a
 * project has to be done by hand, which the warning says how to do.
 *
 * Held deletes are dropped from the plan outright, so their state entries stay
 * as they were: the next pass sees the same picture rather than "forgotten
 * files" to copy back.
 *
 * What this is NOT: a defence against whatever can write the filesystem. It
 * catches broken views — a renamed root, an empty walk, a wiped checkout. A
 * remote party can add filler files first, so that its deletions are a
 * minority of what is tracked; `--allow-delete` trusts the remote, and the
 * breaker does not change that.
 */
export const MASS_DELETE_FLOOR = 3;

export function holdMassDeletes(plan, last, views = {}, peak = 0) {
    const tracked = Object.keys(last).length;
    const most = Math.max(tracked, peak);
    const held = [];
    for (const [action, other] of [["delete-local", "remote"], ["delete-remote", "local"]]) {
        const count = plan.filter((p) => p.action === action).length;
        if (!count) continue;
        if (views[other] === 0) held.push({ action, count, tracked, empty: true });
        else if (count > MASS_DELETE_FLOOR && tracked - count < most / 2) held.push({ action, count, tracked });
    }
    if (!held.length) return { plan, held };
    const holding = new Set(held.map((h) => h.action));
    return { plan: plan.filter((p) => !holding.has(p.action)), held };
}
