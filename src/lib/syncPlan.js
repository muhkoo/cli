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

/** What a folder is in the state file, in place of a content hash. */
export const DIR = "dir";

/** A folder's key in the state file: its path with a trailing slash, so it can never be a file's. */
export const dirKey = (path) => `${path}/`;

/** The state without its folders: what the file planner, and its breaker, count. */
export function filesOf(state) {
    const out = {};
    for (const [key, hash] of Object.entries(state)) if (!key.endsWith("/")) out[key] = hash;
    return out;
}

/**
 * Plan the folders, by the same three-way rule as the files ({@link planPath}),
 * with {@link DIR} standing in for a hash. `local` and `remote` are the folder
 * paths each side holds (`remote` null when the folders could not be listed:
 * then nothing is planned, since a folder not listed is not a folder gone).
 *
 * Returns `{ path, action }` with action one of: "record" (on both sides, not
 * yet in the state), "mkdir-local", "mkdir-remote", "rmdir-local",
 * "rmdir-remote", "forget". Paths in `unknown` are left alone, and so, when
 * `fold` is given (a volume that folds names), is every folder whose folded
 * name more than one spelling shares: which of them this disk holds cannot be
 * told apart, and reading one as missing would plan its removal.
 */
export function planDirs({ last, local, remote, unknown = [], fold = null }) {
    if (!remote) return [];
    const isUnknown = coveredBy(unknown);
    const before = new Set(Object.keys(last).filter((k) => k.endsWith("/")).map((k) => k.slice(0, -1)));
    const here = new Set(local);
    const there = new Set(remote);
    const paths = new Set([...before, ...here, ...there]);
    const clash = new Set();
    if (fold) {
        const spellings = new Map();
        for (const path of paths) {
            const folded = fold(path);
            if (!spellings.has(folded)) spellings.set(folded, []);
            spellings.get(folded).push(path);
        }
        for (const group of spellings.values()) if (group.length > 1) for (const path of group) clash.add(path);
    }
    const ACTIONS = { push: "mkdir-remote", pull: "mkdir-local", "delete-remote": "rmdir-remote", "delete-local": "rmdir-local", forget: "forget" };
    const plan = [];
    for (const path of [...paths].sort()) {
        if (isUnknown(path) || clash.has(path)) continue;
        const was = before.has(path) ? DIR : undefined;
        const action = planPath({ last: was, local: here.has(path) ? DIR : undefined, remote: there.has(path) ? DIR : undefined });
        if (action === "none") {
            if (!was) plan.push({ path, action: "record" });
        } else if (ACTIONS[action]) {
            plan.push({ path, action: ACTIONS[action] });
        }
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
 * One broken view is answered rather than held: a local side that holds
 * nothing at all (`views.bare`: no files, no folders, nothing refused or
 * unreadable) — a mount folder emptied to start again. Its remote deletes
 * become pulls and `restored` counts them, so the files come back instead of
 * the user deleting the state file by hand. Nothing local can be overwritten,
 * as there is nothing local, and nothing remote is deleted. An empty REMOTE is
 * never answered this way: there an empty view more likely means a renamed or
 * missing root, and uploading everything again would put it in the wrong place.
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
    let restored = 0;
    for (const [action, other] of [["delete-local", "remote"], ["delete-remote", "local"]]) {
        const count = plan.filter((p) => p.action === action).length;
        if (!count) continue;
        if (action === "delete-remote" && views.local === 0 && views.bare === true) restored = count;
        else if (views[other] === 0) held.push({ action, count, tracked, empty: true });
        else if (count > MASS_DELETE_FLOOR && tracked - count < most / 2) held.push({ action, count, tracked });
    }
    if (restored) plan = plan.map((p) => (p.action === "delete-remote" ? { path: p.path, action: "pull" } : p));
    if (!held.length) return { plan, held, restored };
    const holding = new Set(held.map((h) => h.action));
    return { plan: plan.filter((p) => !holding.has(p.action)), held, restored };
}
