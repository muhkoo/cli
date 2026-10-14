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
 * ## What comes down is untrusted
 *
 * Anything able to write a user's VFS — today every app they sign into, since
 * hosted auth hands the app the master seed — chooses the paths, names and
 * bytes that arrive here. It cannot touch this disk directly, so everything it
 * can do goes through three places, and those are where the care is:
 *
 *   - `admission`, the one rule for what syncs at all, applied identically to
 *     both sides and to the watcher;
 *   - `writeTarget`, the one gate every write and delete on this disk passes;
 *   - the ignore ratchet, which stops any edit to an ignore file — pulled or
 *     local — from widening what leaves this machine.
 *
 * ## What is deliberately not here
 *
 * No daemon. `mount` runs in the foreground until interrupted, like a dev
 * server, because a background process needs supervision, log rotation and a
 * story for "which mounts are running" that is worth more than a first version.
 */

import { createHash, randomBytes } from "node:crypto";
import {
    access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, stat, statfs, unlink, writeFile,
} from "node:fs/promises";
import { constants as fsConstants, watch } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { DIR, dirKey, filesOf, holdMassDeletes, planDirs, planSync } from "./syncPlan.js";
import {
    DEPTH_MAX, IgnoreBudgetError, NAME_MAX, caseFold, ignoreFileProblem, ruleBank, ruleText, withinMatchBounds,
} from "./ignore.js";
import { configDir } from "./config.js";
import { info, ok, warn } from "./ui.js";

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
 * for a project that genuinely keeps source there. Compared on the folded name
 * as well, so a fullwidth or zero-width-prefixed dot is still a dot — and on
 * the raw one, because folding strips trailing dots and `...` must stay hidden.
 */
const isHidden = (name) => name.startsWith(".") || foldName(name).startsWith(".");

/** Dot-files that describe the project rather than the machine. */
const KEEP_HIDDEN = new Set([".vcsignore", ".gitignore"]);

/**
 * Skip anything enormous.
 *
 * The VFS chunks large files happily, but mounting a directory that happens to
 * contain a disk image should not silently upload it. Named limit, loud skip.
 */
const MAX_BYTES = 100 * 1024 * 1024;

/**
 * How many files the scan reads at once.
 *
 * Enough to hide per-request latency; low enough not to open a connection per
 * file on a large project. A read costs 0.3–0.5 s against production, nearly
 * all of it fixed, so throughput comes from overlapping them: 96 small files
 * took 6.35 s eight at a time, 4.50 s at sixteen, and 4.12 s at thirty-two.
 */
export const SCAN_CONCURRENCY = 16;

/**
 * And the most the files being read may claim between them — by their
 * records' sizes, and their manifests' — before another read waits for one
 * to finish. So raising the count does not raise the memory a run of large
 * files holds at once. A file that claims more than this on its own is read
 * alone: nothing else starts until it is done.
 */
export const SCAN_WINDOW_BYTES = 64 * 1024 * 1024;

/**
 * How many pulls to fetch at once while the oldest lands (see `applyPlan`).
 *
 * A pull the scan did not keep the bytes of — past BLOB_CACHE_BYTES, or a
 * follow-up pass — is a round trip of its own, and one at a time they cost
 * the SUM of the latencies. Only the fetches overlap; every pull still lands
 * one at a time, in plan order.
 */
const PULL_CONCURRENCY = 8;

/**
 * And the most the records of the pulls being fetched may claim between
 * them before the window waits for one to land — so a run of large files is
 * not held in memory eight at a time. One is always let through.
 */
const PULL_WINDOW_BYTES = 64 * 1024 * 1024;

/**
 * The most one pass pulls: bytes and files. Past it, the rest wait for a
 * follow-up pass, which a running mount starts at once.
 *
 * MAX_BYTES bounds one file, and nothing bounded their number. The VFS lets
 * many entries share one stored blob — a copy moves no bytes — so a remote
 * party that stored one 100MB file and made a million cheap entries pointing
 * at it had this disk write it a million times, in one pass. The budget turns
 * that into steady passes the free-space reserve below can stop.
 */
export const PULL_BUDGET = { bytes: 2 * 1024 * 1024 * 1024, files: 10_000 };

/**
 * The most one pass of a mount READS to compare with this disk, the same
 * sizes. Past it, the files not yet read are left alone for the pass —
 * neither pulled nor deleted — and a running mount carries on in a
 * follow-up pass.
 *
 * A file whose content was read before is not read again (`remoteContent`),
 * so this bounds a first pass over a large project, and a remote party that
 * keeps storing new content. Every pass used to read and decrypt every
 * remote file to hash it: two hundred entries sharing one 4 MB blob were
 * 868 MB a pass, steady passes included. `import` reads what it has to
 * compare, once, and is not held to this.
 */
export const READ_BUDGET = { bytes: 2 * 1024 * 1024 * 1024, files: 10_000 };

/**
 * The most a read may fetch, going by the file's manifest: MAX_BYTES and the
 * Reed–Solomon parity stored beside it (half as much again, by default).
 */
const FETCH_MAX = 2 * MAX_BYTES;

/** Bytes a pass keeps of what it has read, so entries sharing content are fetched once. */
const BLOB_CACHE_BYTES = MAX_BYTES;

/**
 * Space a pull must leave free on the volume holding the mount: 5% of it,
 * but at least 1 GiB and at most 10 GiB. A pull that would cut into it waits
 * — with one warning — until something frees space; filling a disk breaks
 * everything else on the machine, which is a worse failure than a file
 * arriving late. Capped because 5% of a 1 TB disk is 50 GB, and many laptops
 * live below that for good: past it the mount pushed and never pulled.
 */
const RESERVE_MIN = 1024 * 1024 * 1024;
const RESERVE_MAX = 10 * RESERVE_MIN;
const RESERVE_SHARE = 0.05;

/** Coalesce editor churn — a save is often several events in a few ms. */
const SETTLE_MS = 250;

/** Temp files for replace-by-rename. Never synced, never watched. */
const TMP_PREFIX = ".muhkoo-tmp-";

/**
 * The longest a scan computes before handing the event loop back.
 *
 * Filtering is pure CPU over every path and every rule, and while it runs
 * nothing else does — Ctrl-C included. Counting paths between yields was not
 * enough: ten thousand planted rules made each path slow, and 256 slow paths
 * in a row held the loop for 42 seconds. So yield by the clock.
 */
const SLICE_MS = 25;

/** `() => Promise | null`: a promise to await when the current slice is used up. */
function pacer() {
    let since = performance.now();
    return () => {
        if (performance.now() - since < SLICE_MS) return null;
        return new Promise((resolve) => setImmediate(resolve)).then(() => {
            since = performance.now();
        });
    };
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Bytes as text. `vfs.readFile` returns a plain Uint8Array, whose own
 * `toString` lists the byte values — never call that on bytes that came down.
 */
const utf8 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");

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
    await writeAtomic(statePath(dir), JSON.stringify({ v: 1, root, paths }, null, 2) + "\n");
}

/**
 * What the scan has hashed, kept between runs, so a restarted mount does not
 * download the whole tree again just to learn it has not changed.
 *
 * It maps a content key — the SHA-256 of a file's manifest, which names the
 * exact shards and the key that decrypts them, so one key is one content — to
 * that content's hash and size. Unlike `mount.json` it decides nothing on its
 * own: an entry only spares a read. So a file that cannot be read, or an entry
 * that is not in the shape written here, is ignored, and that content is read.
 */
const hashCachePath = (dir) => join(dir, ".muhkoo", "content-hashes.json");
const HEX64 = /^[0-9a-f]{64}$/;
/** Entries kept: well past any tree the read budget lets one pass hash. */
const HASH_CACHE_MAX = 200_000;

async function loadHashCache(dir) {
    const hashes = new Map();
    try {
        const saved = JSON.parse(await readFile(hashCachePath(dir), "utf8"));
        if (saved?.v !== 1 || !saved.contents || typeof saved.contents !== "object") return hashes;
        for (const [key, entry] of Object.entries(saved.contents)) {
            if (hashes.size >= HASH_CACHE_MAX) break;
            const [hash, size] = Array.isArray(entry) ? entry : [];
            if (!HEX64.test(key) || !HEX64.test(hash ?? "") || !Number.isSafeInteger(size) || size < 0) return new Map();
            hashes.set(key, { hash, size });
        }
    } catch {
        return new Map();   // none yet, or unreadable: the scan reads, as it always did
    }
    return hashes;
}

function sameHashes(a, b) {
    if (a.size !== b.size) return false;
    for (const [key, { hash }] of a) if (b.get(key)?.hash !== hash) return false;
    return true;
}

async function saveHashCache(dir, hashes) {
    const contents = {};
    for (const [key, { hash, size }] of hashes) contents[key] = [hash, size];
    await writeAtomic(hashCachePath(dir), JSON.stringify({ v: 1, contents }) + "\n");
}

function sameState(a, b) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/**
 * What one running mount remembers between passes — in memory, on purpose.
 *
 * `warned` holds the warnings already given, so a refusal is said once rather
 * than every pass; `ignoreCase` is the volume probe; `more` says the last pass
 * stopped at a budget; `hashes` maps each remote content read so far to its
 * hash and size, so an unchanged file is not read again. None is persisted:
 * a restart says everything once more, and a warning saved to disk would
 * hide a problem for good. Tests may set `pullBudget`, `readBudget` (null:
 * none), `pathBudget` (ignore.js PATH_BUDGET) and `statfs`.
 */
function session(s = {}) {
    s.warned ??= new Set();
    s.pullBudget ??= PULL_BUDGET;
    if (s.readBudget === undefined) s.readBudget = READ_BUDGET;
    s.statfs ??= statfs;
    s.hashes ??= new Map();
    return s;
}

/** Warn once per session for each `key`: a refusal is news once, then noise. */
function warnOnce(sess, key, ...lines) {
    if (sess.warned.has(key)) return;
    sess.warned.add(key);
    warn(...lines);
}

// ---- what syncs at all --------------------------------------------------------

/**
 * Paths no flag may bring down, and no ignore file may negate, ever.
 *
 * `--hidden` means "sync dot-files", not "let whatever can write my filesystem
 * rewrite my git config". Each of these either holds credentials that must
 * never leave, or reaches code execution without needing an execute bit: git
 * runs `core.pager` and `core.fsmonitor` from `.git/config` itself, a shell
 * sources its startup files, `.husky` is git's hooks path, and the editor and
 * agent directories hold tasks and hooks that run on open. Matched against
 * every segment, and upward as firmly as downward.
 *
 * Deliberately NOT here: `bin/`, `Library/`, and the yarn/pnpm/cargo/bun
 * configs. Those are ordinary committed project files — a package's `bin/` is
 * its entry point — and code the user runs on purpose is the surface an app
 * holding the seed can already change by editing source (SEC-3). Refusing them
 * would stop real projects syncing without closing anything.
 */
const REFUSED_DIRS = new Set([
    ".git", ".ssh", ".muhkoo", ".vscode", ".idea", ".config", "node_modules",
    ".husky", ".claude", ".cursor", ".zed", ".fleet",
]);
const REFUSED_FILES = new Set([
    ".envrc", ".npmrc", ".netrc", ".gitconfig", ".pam_environment", ".xprofile",
    ".profile", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout",
    ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".kshrc",
]);
const REFUSED = new Set([...REFUSED_DIRS, ...REFUSED_FILES]);

/**
 * A name as a folding filesystem might see it — for COMPARING, never writing.
 *
 * APFS and NTFS fold case, and APFS folds Unicode normalization, so a remote
 * `Node_Modules/` or `.GIT/` opens the real `node_modules/` or `.git/`. HFS+
 * also drops zero-width and direction marks; Win32 strips trailing dots and
 * spaces and reads `name:stream` as a stream of `name`. `caseFold` is the
 * ignore matcher's own fold — full case folding (`ß` to ss, as APFS does) plus
 * NFKC (`ſ` to s, the Kelvin sign to k, a fullwidth dot to a dot) — so what
 * this refuses and what the rules exclude agree. This folds further than any
 * one filesystem does. Over-folding only ever refuses more, which is safe
 * here; the written name is always the exact one the write boundary verified.
 */
export function foldName(name) {
    return caseFold(String(name).split(":")[0]).replace(/[. ]+$/, "");
}

/**
 * Windows 8.3 short names reach the long name they abbreviate — `GIT~1` opens
 * `.git`, `NODE_M~1` opens `node_modules` (git's CVE-2014-9390 class). The
 * short form is the first six characters of the name without its leading dots,
 * or, after a few collisions, two characters and a four-hex-digit hash.
 */
const SHORT_NAME = /^([^~]{1,6})~[0-9]+(?:\..*)?$/;
const REFUSED_STEMS = [...REFUSED].map((n) => n.replace(/^\.+/, "").replace(/[^a-z0-9_-]/g, ""));

function isShortFormOfRefused(folded) {
    const m = SHORT_NAME.exec(folded);
    if (!m) return false;
    const p = m[1];
    const hashed = p.length === 6 && /^[0-9a-f]{4}$/.test(p.slice(2));
    return REFUSED_STEMS.some((stem) => p === stem.slice(0, 6) || (hashed && stem.startsWith(p.slice(0, 2))));
}

// Exported for tests: these ARE the security boundary, so they are worth
// asserting on directly rather than only through a full sync.
export function isRefused(rel) {
    return rel.split("/").some((part) => {
        const folded = foldName(part);
        return REFUSED.has(folded) || isShortFormOfRefused(folded);
    });
}

/** The names an ignore file goes by — these spellings exactly. */
const IGNORE_NAMES = new Set([".vcsignore", ".gitignore"]);

/**
 * A name a folding volume would open AS an ignore file, spelled otherwise:
 * `.VCSIGNORE`, `.GitIgnore`, `.gitignore.`. Refused both ways, like an alias
 * of anything else. With --hidden a remote `/.VCSIGNORE` was pulled under that
 * spelling, so nothing marked it as pulled — and the next pass read it back as
 * `.vcsignore`, on a volume that folds case, as a file the user had written.
 */
const ignoreAlias = (name) => !IGNORE_NAMES.has(name) && IGNORE_NAMES.has(foldName(name));

/**
 * The one admission rule: what syncs, in either direction, and what the
 * watcher wakes for. Returns "refused" or "alias" (never synced, and never
 * mistaken for absent), "excluded", "held" (excluded, but only by ignore rules
 * this directory used earlier — see `ignoreContext`), "unknown" (too
 * costly to match, so not decided either way), or null (admitted).
 *
 * The order is the point. Refusal first, so no ignore file can negate it —
 * `!node_modules/` in a pulled `.vcsignore` used to be enough. Then the fixed
 * exclusions no rule can lift: our own temp files, and dot-entries without
 * --hidden. Then the ignore rules, whose matchers answer for every ANCESTOR
 * too, as git does: a file under an excluded directory is excluded, whatever
 * a later rule says.
 *
 * `ignore` is the rules as the files now stand; `held`, when given, the rules
 * as they stood before.
 *
 * The two scans used to filter differently — refusal on one side only, a size
 * limit on one side only, pruning on one side only — and the planner read each
 * difference as a deletion.
 */
function admission(rel, isDir, hidden, ignore, held) {
    if (isRefused(rel)) return "refused";
    const parts = rel.split("/");
    const name = parts.at(-1);
    if (ignoreAlias(name)) return "alias";
    // A replace-by-rename left behind by a process that died mid-write.
    if (name.startsWith(TMP_PREFIX)) return "excluded";
    if (!hidden && parts.some((part) => isHidden(part) && !KEEP_HIDDEN.has(part))) return "excluded";
    try {
        if (ignore(rel, isDir)) return "excluded";
        if (held?.(rel, isDir)) return "held";
    } catch (err) {
        // Too costly to decide (ignore.js PATH_BUDGET): left alone, like a
        // path that cannot be read — never synced, and never read as gone.
        if (err instanceof IgnoreBudgetError) return "unknown";
        throw err;
    }
    return null;
}

// ---- the ignore ratchet ---------------------------------------------------------

/** Plan steps that change your filesystem to match this disk. */
const UPLOADS = new Set(["push", "conflict", "delete-remote"]);

/** Paths whose text is ignore rules (relative, no leading slash). */
const isIgnoreFile = (rel) => rel === ".vcsignore" || rel === ".gitignore" || rel.endsWith("/.gitignore");

/** Inside a refused directory, so never synced and never remote — but rules all the same. */
const EXCLUDE_FILE = ".git/info/exclude";

/** Where the ratchet keeps its snapshots (see `ignoreContext`). */
const rulesPath = (dir) => join(dir, ".muhkoo", "ignore-rules.json");

/**
 * And a copy outside the project, keyed by where it is and the remote root
 * mounted there: `git clean -fdX` removes `.muhkoo/` — the CLI suggests
 * git-ignoring it — and with no rules file a pass starts afresh from the
 * ignore files on disk, a pulled one included. The root is in the key so
 * that another project checked out at the same path, from another root,
 * starts afresh rather than being held by the old one's rules. The copy in
 * the project is the one that counts; this one is read only when that is
 * gone, and written as best it can be. `root` null: no copy.
 */
async function mirrorPath(dir, root) {
    const real = await plannedRealpath(dir);
    const key = createHash("sha256").update(`${real}\0${root}`).digest("hex").slice(0, 32);
    return join(configDir(), "mounts", key, "ignore-rules.json");
}

/**
 * `dir`'s realpath — or, for a directory not created yet, its nearest existing
 * ancestor's realpath with the rest appended: what the realpath will be once a
 * mount creates it. A dry run of a mount on a directory that is gone must find
 * the copy of the rules that the mount, having created it, will find.
 */
async function plannedRealpath(dir) {
    const rest = [];
    for (let at = resolve(dir); ; at = dirname(at)) {
        try {
            return join(await realpath(at), ...rest.reverse());
        } catch {
            if (dirname(at) === at) return resolve(dir);
            rest.push(basename(at));
        }
    }
}

/**
 * How many snapshots, and how many bytes of them, the ratchet keeps before a
 * pass refuses. A snapshot is added only when the RULES change — not a
 * comment, a blank line or a line ending, and not a set of files the list
 * already holds, so switching branches back and forth adds nothing. Anything
 * else adds one, a rule added included. Each version of a file is stored
 * once, however many snapshots hold it. At either cap the pass FAILS CLOSED:
 * dropping the oldest snapshot would drop exactly the exclusions only it
 * still holds.
 */
const MAX_SNAPSHOTS = 64;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/**
 * The ignore rules for one pass: a sticky exclusion ratchet.
 *
 * Ignore files travel with the project, so anything able to write the user's
 * filesystem can write them — and the rules they hold decide what leaves this
 * machine. A pulled `.vcsignore` reading `# tidy-up` replaced a project's
 * `.gitignore` outright, and the next pass uploaded `config/master.key`.
 *
 * Two earlier designs tried to tell a pulled file from the user's own edit of
 * it, and each was undone by one ordinary local edit — a blank line, a rule
 * added, CRLF line endings — to a file that had arrived from elsewhere. So
 * nothing here asks where a file came from.
 *
 * `.muhkoo/ignore-rules.json` (never synced: `.muhkoo` is refused) keeps a
 * list of SNAPSHOTS. A snapshot is every ignore file a pass reads — the root
 * `.vcsignore` and `.gitignore`, every nested `.gitignore` in a directory the
 * scan enters, and `.git/info/exclude` — path to rules (`ruleText`), as they
 * stood. The first is the set last accepted: on the first pass, the files on
 * disk BEFORE anything is pulled. Every pass after that appends the files as
 * they now stand whenever the list does not already hold them. Only an accept
 * ever removes or replaces a snapshot: a check that let rules "only added" to
 * a file replace the snapshot they extended was fooled by a byte-order mark
 * hiding a `!`, and dropped the one snapshot keeping `config/master.key` home.
 *
 * A path is ignored if ANY snapshot, or the files as they now stand, ignore
 * it — each read on its own, with the usual rules (a `.vcsignore` wins
 * outright within its own snapshot). The same test decides both directions.
 * So once a path has been kept home, no edit — pulled or local, a rule or a
 * blank line — makes it sync. Tightening applies at once, since it is in the
 * files as they now stand; loosening waits for `muhkoo vfs ignore <dir>
 * --accept`, which shows what it lets through, the ignore files changed since
 * the last accept, and a digest of the files as they now stand;
 * `--accept <digest>` resets the snapshots to exactly those files, and refuses
 * when they have changed since. A pass that holds files back says so, once.
 *
 * It fails closed. At either cap, or when the rules file cannot be read, the
 * pass stops with a message to review and accept — never a fresh start, which
 * would adopt whatever ignore files are on disk, a pulled one included. Ignore
 * files from elsewhere count toward the caps like any others, so a remote
 * party can force that review: a refusal, never a leak.
 *
 * `stored` is what `loadSnapshots` gave: null on the first pass here,
 * undefined when it could not be read and the caller (an accept) is replacing
 * it anyway. `hidden` is whether this pass reads dot-directories, recorded
 * beside the snapshots so that `vfs ignore` reads the tree as the mount does.
 */
function ignoreContext(sess, stored, { hidden = false } = {}) {
    const bank = ruleBank({
        ignoreCase: sess.ignoreCase,
        budget: sess.pathBudget,
        onBadLine: (line, reason, file) =>
            warnOnce(sess, `bad-line:${file}:${line}`, `ignoring "${line}" in ${file ?? "an ignore file"}: ${reason}`),
    });
    const current = bank.view();   // the ignore files as they now stand, as the scan finds them

    const snapshots = [];   // oldest first; the first is the set last accepted
    const holds = (v) => snapshots.some((s) => s.same(v));
    // Is every snapshot the files as they now stand — the steady state, where
    // the ratchet has nothing to add? Worked out again only when either changes.
    let steadyAt = null;
    let steady = false;
    let recorded = 0;
    const isSteady = () => {
        const at = `${current.changes}:${recorded}`;
        if (steadyAt !== at) {
            steadyAt = at;
            steady = snapshots.every((s) => s.same(current));
        }
        return steady;
    };
    for (const files of stored?.snapshots ?? []) {
        const v = bank.view();
        for (const [rel, text] of files) v.put(rel, bank.version(rel, text));
        snapshots.push(v);
    }

    const ctx = {
        current,
        source: () => current.source,
        /** Ignored by the files as they now stand. */
        now: (path, isDir = false) => current.excludes(bank.subject(path), isDir),
        /**
         * Ignored by a snapshot — rules other than the files as they now
         * stand. One whose files governing the path are those now on disk
         * gives the same verdict, and is not asked: the latest snapshot almost
         * always IS the files as they now stand, so this is what keeps the
         * ratchet free in the steady state.
         */
        held(path, isDir = false) {
            if (isSteady()) return false;
            const subj = bank.subject(path);
            return snapshots.some((s) => !s.alike(current, subj) && s.excludes(subj, isDir));
        },
        /** Are rules other than the files as they now stand still in force? */
        inForce: () => !isSteady(),
        /** The ignore files as they now stand against the last accepted, as "path (new|changed|removed)". */
        changed: () => (snapshots.length ? changedFiles(snapshots[0], current) : []),
        /** The files as they now stand, path to rules. */
        texts: () => new Map([...current.files].map(([rel, v]) => [rel, v.text])),

        /**
         * Record what an ignore file on disk holds now (`bytes` null: absent).
         * A file too big to be rules stops the pass: reading part of it, or
         * none, would drop exclusions it holds.
         */
        see(rel, bytes) {
            const problem = bytes && ignoreFileProblem(bytes);
            if (problem) throw new Error(`${rel} cannot be read as ignore rules: ${problem}. Nothing was synced — shorten it.`);
            current.put(rel, bytes ? bank.version(rel, ruleText(utf8(bytes))) : null);
        },

        /**
         * After the local scan, before anything is pulled: append the files
         * as they now stand, unless a snapshot already holds them. `save`
         * false (a dry run) checks the caps without writing.
         */
        async record(dir, root, save = true) {
            // Rules read from the copy outside the project go back into it
            // first: `vfs ignore` finds that copy only by the root in the
            // state file, which `git clean -fdX` took too, and a pass that
            // refuses below never writes again.
            if (save && stored?.mirrored) await saveSnapshots(dir, root, serializeRules(snapshots, hidden));
            if (holds(current)) {
                // Rewritten only when the mode changed, so that `vfs ignore`
                // reads the tree as the last pass did. Writing it otherwise
                // would wake a running mount into another pass.
                if (save && stored && Boolean(stored.hidden) !== hidden) await saveSnapshots(dir, root, serializeRules(snapshots, hidden));
                return;
            }
            const latest = bank.view(current.files);
            const text = serializeRules([...snapshots, latest], hidden);
            const bytes = Buffer.byteLength(text);
            const why = snapshots.length + 1 > MAX_SNAPSHOTS
                ? `they have changed ${snapshots.length} times since they were last accepted, and at most ${MAX_SNAPSHOTS - 1} changes are kept`
                : bytes > MAX_SNAPSHOT_BYTES
                    ? `the rules they have held come to ${Math.round(bytes / 1024)} KB, and at most ${MAX_SNAPSHOT_BYTES / 1024} KB are kept`
                    : null;
            if (why) {
                const changed = ctx.changed();
                throw new Error(
                    `the ignore files in ${dir} cannot all be kept: ${why}. Nothing was synced.` +
                    (changed.length ? ` Changed since they were last accepted: ${changed.join(", ")} — check them, since one that came from your filesystem may not be yours.` : "") +
                    ` Then see what accepting them would let through with \`muhkoo vfs ignore ${dir} --accept\`.`,
                );
            }
            snapshots.push(latest);
            recorded++;
            if (save) await saveSnapshots(dir, root, text);
        },
    };

    return ctx;
}

/** Each ignore file that differs between two views, as "path (new|changed|removed)". */
function changedFiles(before, after) {
    const out = [];
    for (const rel of [...new Set([...before.files.keys(), ...after.files.keys()])].sort()) {
        if (before.files.get(rel) === after.files.get(rel)) continue;
        out.push(`${rel} (${!before.files.has(rel) ? "new" : !after.files.has(rel) ? "removed" : "changed"})`);
    }
    return out;
}

/**
 * Read the root ignore files into `ignores` — only under their exact names: on
 * a volume that folds case, `readFile(".vcsignore")` opens a `.VCSIGNORE` too,
 * and the rules in whatever it opened would be read as the project's own.
 */
async function seeRootFiles(dir, ignores, skip) {
    const names = new Set(await readdir(dir).catch(() => []));
    for (const name of IGNORE_NAMES) {
        if (name !== skip) ignores.see(name, names.has(name) ? await readIgnoreFile(join(dir, name)) : null);
    }
    ignores.see(EXCLUDE_FILE, await readIgnoreFile(join(dir, EXCLUDE_FILE)));
}

/**
 * The rules file: every version of a file once, and each snapshot as the
 * list of versions it holds, so a file many snapshots share — a heavy
 * `.vcsignore` among them — is stored, and counted against the byte cap,
 * once.
 */
function serializeRules(snapshots, hidden) {
    const index = new Map();
    const files = [];
    const sets = snapshots.map((s) =>
        [...s.files.values()].map((v) => {
            let i = index.get(v);
            if (i === undefined) {
                index.set(v, (i = files.length));
                files.push([v.file, v.text]);
            }
            return i;
        }),
    );
    return JSON.stringify({ v: 2, hidden, files, snapshots: sets }) + "\n";
}

/** Write the rules file: in the project, and — as best it can — the copy outside it. */
async function saveSnapshots(dir, root, text) {
    await writeAtomic(rulesPath(dir), text);
    if (root !== null) await writeAtomic(await mirrorPath(dir, root), text).catch(() => {});
}

/**
 * The stored snapshots, as `{ hidden, snapshots }` — each snapshot a Map of
 * path to rules: null when there are none yet (the first pass here), or
 * thrown when the file cannot be read — never an empty start, which would
 * adopt whatever ignore files are on disk now, a pulled one included. The
 * copy in the project counts; the one outside it (for `root`) only when that
 * is gone, and is then `mirrored`.
 */
async function loadSnapshots(dir, root) {
    const own = await readSnapshots(rulesPath(dir), dir);
    if (own || root === null) return own;
    const copy = await readSnapshots(await mirrorPath(dir, root), dir);
    return copy && { ...copy, mirrored: true };
}

async function readSnapshots(path, dir) {
    let text;
    try {
        text = await readFile(path, "utf8");
    } catch (err) {
        if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
        throw rulesUnreadable(dir, path, err.code ?? err.message);
    }
    let saved;
    try {
        saved = JSON.parse(text);
    } catch {
        throw rulesUnreadable(dir, path, "it is not valid JSON — a write cut short, perhaps");
    }
    const snapshots = snapshotsFrom(saved);
    if (!snapshots) throw rulesUnreadable(dir, path, "it is not in the format this version writes");
    return { hidden: saved.hidden === true, snapshots };
}

/**
 * The snapshots in a parsed rules file, as Maps of path to rules, or null when
 * it is not one. Each version's rules are taken as stored — they are what
 * `ruleText` gave. Read through it again, a byte-order mark that began a
 * later line began the text, and was stripped: rules unlike any stored, on
 * every pass.
 */
function snapshotsFrom(saved) {
    const named = (rel, text) => typeof rel === "string" && typeof text === "string" && (isIgnoreFile(rel) || rel === EXCLUDE_FILE);
    if (saved?.v !== 2 || !Array.isArray(saved.files) || !Array.isArray(saved.snapshots) || !saved.snapshots.length) return null;
    if (!saved.files.every((f) => Array.isArray(f) && f.length === 2 && named(f[0], f[1]))) return null;
    const out = [];
    for (const set of saved.snapshots) {
        if (!Array.isArray(set)) return null;
        const files = new Map();
        for (const i of set) {
            const entry = Number.isInteger(i) ? saved.files[i] : undefined;
            if (!entry || files.has(entry[0])) return null;
            files.set(entry[0], entry[1]);
        }
        out.push(files);
    }
    return out;
}

function rulesUnreadable(dir, path, why) {
    return new Error(
        `${path} cannot be read (${why}). It holds every set of ignore rules ${dir} has used, and without it ` +
        `nothing can be shown to stay home, so nothing was synced. Check the ignore files as they now stand, then ` +
        `accept them: \`muhkoo vfs ignore ${dir} --accept\` shows how.`,
    );
}

/** Replace `path` by rename, so a crash leaves the old file or the new one — never half of either. */
async function writeAtomic(path, text) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${TMP_PREFIX}${randomBytes(6).toString("hex")}`;
    try {
        await writeFile(tmp, text, { flag: "wx" });
        await rename(tmp, path);
    } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
    }
}

/**
 * The files the ignore rules hold back, as a warning's lines: named, and with
 * the command that shows what accepting would let through. "Earlier" rules,
 * not "dropped" ones: on a fresh machine the first snapshot is the defaults
 * alone, and what holds a file there is a pulled rule re-including it.
 */
function heldNotice(paths, dir) {
    const shown = paths.slice(0, 5).map((p) => p.replace(/^\//, "")).join(", ");
    return [
        `${paths.length} path${paths.length === 1 ? " is" : "s are"} held back — the ignore rules as they now stand would sync ` +
        `${paths.length === 1 ? "it" : "them"}, but rules this directory used earlier (when last accepted, or since) exclude ` +
        `${paths.length === 1 ? "it" : "them"}: ${shown}${paths.length > 5 ? ", …" : ""}`,
        `  Nothing is synced for ${paths.length === 1 ? "it" : "them"} until you accept the ignore files as they now stand. ` +
        `See what that would let through: muhkoo vfs ignore ${dir} --accept`,
    ];
}

/** Is `relDir` in, or under, a dot-directory? */
const inDotDir = (relDir) => relDir.split("/").some((part) => isHidden(part));

/**
 * The ignore files on disk, and the local files only the stored snapshots
 * hold back. Changes nothing. Walks the way git reads: exact names, and never
 * inside a directory the files as they now stand exclude — the pruning a pass
 * will do once the snapshots are accepted.
 *
 * Nested `.gitignore` files in dot-directories count only where the mount
 * reads them — with --hidden, as the rules file records (`hidden`). Reading
 * them regardless put a pytest cache's own `*` among the files as they now
 * stand, which no pass records, so `vfs ignore` said for good that older
 * rules were in force, and flagged a tool's file as possibly planted. HELD
 * files are listed in dot-directories whatever the mode: listing one costs
 * nothing, and leaving out one a --hidden mount would release did. `draft`
 * reads the tree as git would, with no `.vcsignore` — the file a draft
 * replaces.
 */
async function diskRules(dir, { draft = false, stored, hidden = false } = {}) {
    const sess = session();
    sess.ignoreCase = await foldsCase(dir);
    const ignores = ignoreContext(sess, stored, { hidden });
    await seeRootFiles(dir, ignores, draft ? ".vcsignore" : null);
    const held = [];
    const walk = async (abs, relDir) => {
        const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
        if (relDir && (hidden || !inDotDir(relDir))) {
            // As scanLocal reads it, so an accept records what a pass will see.
            const file = entries.find((e) => e.name === ".gitignore" && (e.isFile() || e.isSymbolicLink()));
            ignores.see(`${relDir}/.gitignore`, file ? await readIgnoreFile(join(abs, ".gitignore")) : null);
        }
        for (const entry of entries) {
            const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
            const isDir = entry.isDirectory();
            if (admission(rel, isDir, true, ignores.now)) continue;
            if (isDir) await walk(join(abs, entry.name), rel);
            else if (entry.isFile() && heldBy(ignores, rel)) held.push("/" + rel);
        }
    };
    await walk(dir, "");
    return { ignores, held: held.sort(), changed: ignores.changed(), inForce: ignores.inForce() };
}

/** Does only a snapshot exclude `rel`? A path too costly to decide is not listed. */
function heldBy(ignores, rel) {
    try {
        return ignores.held(rel);
    } catch (err) {
        if (err instanceof IgnoreBudgetError) return false;
        throw err;
    }
}

/**
 * What `muhkoo vfs ignore <dir>` shows, and `--accept` previews, changing
 * nothing: whether rules other than the ignore files as they now stand still
 * apply (`inForce`), which ignore files changed since the last accept
 * (`changed`), the local files those rules hold back, which an accept lets
 * through (`held`), and `digest`, naming exactly the ignore files an accept
 * would adopt. Files arriving from elsewhere may be held too, and are not
 * listed: that needs the filesystem, and this is local. `mounted` is false
 * where no rules were ever stored; `unreadable` is the error when the stored
 * rules cannot be read, so that nobody can say what they hold.
 */
export async function heldBack(dir) {
    return (await toAccept(dir)).shown;
}

/**
 * `muhkoo vfs ignore <dir> --accept <digest>`: make the ignore files as they
 * now stand the only rules — if they are still the ones `heldBack` showed
 * under `digest`. Otherwise it throws, and accepts nothing: an ignore file
 * that arrived between the preview and the accept was never shown to anyone.
 * Returns the local files that lets through (`eligible`; null when the old
 * rules could not be read, so nobody can say).
 */
export async function acceptIgnores(dir, digest) {
    const { root, text, shown } = await toAccept(dir);
    if (digest !== shown.digest) {
        throw new Error(
            `the ignore files in ${dir} have changed since that preview (it showed ${digest}; they are now ${shown.digest}), ` +
            `so nothing was accepted. See what accepting them now would let through: muhkoo vfs ignore ${dir} --accept`,
        );
    }
    await saveSnapshots(dir, root, text);
    return { eligible: shown.unreadable ? null : shown.held };
}

/** The rules file an accept would write, and what `heldBack` shows of it. */
async function toAccept(dir) {
    const root = await syncedRoot(dir);
    let stored;   // undefined when it cannot be read: the accept replaces it
    let unreadable = null;
    try {
        stored = await loadSnapshots(dir, root);
    } catch (err) {
        unreadable = err;
    }
    const hidden = Boolean(stored?.hidden);
    const { ignores, held, changed, inForce } = await diskRules(dir, { stored, hidden });
    // Of the rules themselves, in a fixed order: the order the walk met the
    // files in is not part of what is being accepted.
    const rules = [...ignores.current.files.values()].map((v) => [v.file, v.text]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const digest = sha(JSON.stringify({ hidden, rules })).slice(0, 16);
    const text = serializeRules([ignores.current], hidden);
    return { root, text, shown: { mounted: stored !== null, unreadable, inForce, changed, held, digest } };
}

/** The remote root `dir` was last synced with, from its state file, or null. */
async function syncedRoot(dir) {
    const saved = await readFile(statePath(dir), "utf8").then(JSON.parse).catch(() => null);
    return saved?.v === 1 && typeof saved.root === "string" ? saved.root : null;
}

/**
 * Every ignore file git would read under `dir`, path to rules, as it stands
 * on disk — what `vfs ignore --write` drafts a `.vcsignore` from. A
 * `.vcsignore` already there is left out: the draft replaces it.
 */
export async function diskIgnoreTexts(dir) {
    const { ignores } = await diskRules(dir, { draft: true, stored: null, hidden: true });
    return ignores.texts();
}

/** An ignore file's bytes, or null when it is absent or unreadable. */
async function readIgnoreFile(abs) {
    try {
        return await readFile(abs);
    } catch {
        return null;
    }
}

/**
 * Does the volume holding `dir` fold case? Mirrors git's `core.ignorecase`.
 *
 * Probed rather than assumed from the platform: macOS volumes can be
 * case-sensitive, and Linux can mount case-insensitive ones. If the probe
 * cannot run, fold: that only ever excludes and refuses more.
 */
async function foldsCase(dir) {
    const probeDir = join(dir, ".muhkoo");
    let made;
    const name = `case-probe-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
        made = await mkdir(probeDir, { recursive: true });
        await writeFile(join(probeDir, name), "", { flag: "wx" });
        return await lstat(join(probeDir, name.toUpperCase())).then(() => true, () => false);
    } catch {
        return true;
    } finally {
        await rm(join(probeDir, name), { force: true }).catch(() => {});
        if (made) await rmdir(probeDir).catch(() => {});   // leave no .muhkoo/ made only for this
    }
}

/**
 * The same question, asked without writing anything — for a dry run, which
 * promises to change nothing, not even for a moment. `foldsCase` writes a
 * probe file and removes it: no name is left behind, but the directory (or
 * `.muhkoo/`, or wherever a symlinked `.muhkoo` points) has changed.
 *
 * So look an entry already there up under its other spelling: found, and not
 * a second entry of that name, means the volume folded the name. Nothing in
 * `dir` with a letter in its name, and `dir`'s own name is asked of its parent,
 * when that is on the same volume. With neither, fold — as a directory that is
 * not there yet does — which only ever refuses more.
 */
export async function foldsCaseReadOnly(dir) {
    const swapped = (name) => name.replace(/[a-z]/gi, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()));
    // true or false when `name` in `parent` tells, undefined when it does not.
    const ask = async (parent, name, listed) => {
        const other = swapped(name);
        if (other === name) return undefined;
        if (listed.has(other)) return false;   // both spellings, side by side: nothing folded
        const a = await lstat(join(parent, name), { bigint: true }).catch(() => null);
        if (!a) return undefined;   // gone since it was listed
        let b;
        try {
            b = await lstat(join(parent, other), { bigint: true });
        } catch (err) {
            return err.code === "ENOENT" ? false : undefined;
        }
        if (!a.ino || !b.ino) return true;   // found under a spelling not listed; no inodes to compare
        return a.dev === b.dev && a.ino === b.ino ? true : undefined;
    };
    try {
        const names = await readdir(dir);
        const listed = new Set(names);
        for (const name of names) {
            const answer = await ask(dir, name, listed);
            if (answer !== undefined) return answer;
        }
    } catch {
        // unreadable: the parent may still tell
    }
    try {
        const parent = dirname(dir);
        const [here, above] = await Promise.all([lstat(dir, { bigint: true }), lstat(parent, { bigint: true })]);
        if (parent !== dir && here.dev === above.dev) {
            const answer = await ask(parent, basename(dir), new Set(await readdir(parent)));
            if (answer !== undefined) return answer;
        }
    } catch {
        // nothing more to ask
    }
    return true;
}

// ---- the scans ------------------------------------------------------------------

/**
 * Hash every syncable file under `dir`, keyed by VFS-style relative path.
 *
 * Also returns the paths it deliberately did not look at — refused, over the
 * size limit, unreadable, or not a regular file — as `unknown`, so the planner
 * leaves them alone rather than reading them as deleted, and as `held` the
 * ones only earlier ignore rules keep out (a directory with a trailing slash),
 * for the notice. Discovers nested `.gitignore` files on the way down,
 * registering each before anything in its directory is matched, and never
 * descends into an excluded directory to look for one (neither does git).
 */
async function scanLocal(dir, { hidden = false, ignores, sess, signal }) {
    const files = {};
    const dirs = [];
    const unknown = new Set();
    const held = new Set();
    const pace = pacer();

    const walk = async (abs, relDir) => {
        let entries;
        try {
            entries = await readdir(abs, { withFileTypes: true });
        } catch (err) {
            if (!relDir) throw err;              // the mount itself: fail the pass loudly
            if (err.code === "ENOENT") return;   // vanished mid-scan; the next pass will see it
            warnOnce(sess, `unreadable:/${relDir}`, `could not read ${relDir}/ (${err.code ?? err.message}) — leaving it alone`);
            unknown.add("/" + relDir);
            return;
        }
        if (relDir) {
            const file = entries.find((e) => e.name === ".gitignore" && (e.isFile() || e.isSymbolicLink()));
            ignores.see(`${relDir}/.gitignore`, file ? await readIgnoreFile(join(abs, ".gitignore")) : null);
        }
        for (const entry of entries) {
            const breather = pace();
            if (breather) await breather;
            if (signal?.aborted) return;   // the caller must not plan from half a scan
            const child = join(abs, entry.name);
            const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
            const key = "/" + rel;
            // Pruned at the directory, not per file: never descend into
            // node_modules to decide, file by file, not to sync it.
            const verdict = admission(rel, entry.isDirectory(), hidden, ignores.now, ignores.held);
            if (verdict === "unknown") costly(sess, key);
            if (verdict === "refused" || verdict === "alias" || verdict === "unknown") {
                unknown.add(key);
                continue;
            }
            if (verdict === "held") held.add(entry.isDirectory() ? `${key}/` : key);
            if (verdict) continue;
            if (entry.isDirectory()) {
                dirs.push(key);
                await walk(child, rel);
                continue;
            }
            // Sockets, fifos, symlinks: not ours to read — or to replace, so
            // they are unknown rather than absent.
            if (!entry.isFile()) {
                unknown.add(key);
                continue;
            }
            try {
                const info = await lstat(child);
                if (info.size > MAX_BYTES) {
                    warnOnce(sess, `big:${key}`, `skipping ${rel} — ${Math.round(info.size / 1e6)} MB is over the mount limit`);
                    unknown.add(key);
                    continue;
                }
                files[key] = sha(await readFile(child));
            } catch (err) {
                if (err.code === "ENOENT") continue;   // deleted mid-scan: genuinely gone
                warnOnce(sess, `unreadable:${key}`, `could not read ${rel} (${err.code ?? err.message}) — leaving it alone`);
                unknown.add(key);
            }
        }
    };
    await walk(dir, "");
    return { files, dirs, unknown, held };
}

/**
 * Every file path under the remote root, or none when it does not exist yet.
 *
 * `/` is the one root that must not be asked: through 0.14.0-alpha.8 the SDK
 * answered `exists("/")` with false (the root has no entry of its own), and
 * asking made every pass see an empty filesystem — pass one uploaded the
 * project, pass two planned deleting all of it locally. Newer SDKs answer true,
 * but this CLI may run against either.
 */
async function walkRemote(vfs, root) {
    // `dirs` is null when the folders cannot be told: a root that is not there
    // (missing or renamed — never "every folder deleted"), or an SDK without
    // `walkEntries`. Folders are then left alone.
    if (root !== "/" && !(await vfs.exists(root))) return { paths: [], dirs: null };
    if (typeof vfs.walkEntries !== "function") return { paths: await vfs.walk(root), dirs: null };
    const entries = await vfs.walkEntries(root);
    return {
        paths: entries.filter((e) => e.kind === "file").map((e) => e.path),
        dirs: entries.filter((e) => e.kind === "dir").map((e) => e.path),
    };
}

/**
 * The remote folders, keyed like the local ones, through the same admission
 * rule: a refused, ignored or hidden folder is not made here, any more than a
 * file in it would be.
 */
function remoteDirs(dirs, root, { hidden, ignores, ignoreCase }) {
    if (!dirs) return null;
    const out = [];
    for (const abs of dirs) {
        const key = root === "/" ? abs : abs.slice(root.length);
        if (!key.startsWith("/") || key === "/") continue;
        const rel = key.slice(1);
        if (!withinMatchBounds(rel, ignoreCase)) continue;
        if (admission(rel, true, hidden, ignores.now, ignores.held)) continue;
        out.push(key);
    }
    return out;
}

/**
 * Hash every file under the mounted VFS subtree — through the SAME admission
 * rule as the local scan.
 *
 * These filters used to run in one direction only. They decided what left the
 * machine and nothing decided what arrived, so a remote `.git/config` was
 * hashed here, found no local counterpart, and was written straight into the
 * developer's repository. Anything that can write to a user's VFS is a party
 * that can write files onto the machines they mount from.
 *
 * Returns `{ files, unknown, held }`: `unknown` is every path deliberately
 * not read — refused, over the size limit, unreadable, left for the next pass
 * (`deferred`), or an alias of another remote path — which the planner must
 * not mistake for absent; `held` the paths only earlier ignore rules keep out.
 *
 * `ctx`: `paths` (an already-walked listing), `held` (the earlier rules; see
 * `ignoreContext`), `ignoreCase` (the local volume folds names), `localKeys`
 * (for resolving fold collisions), `session`, `spent` (what the pass has read
 * so far, against the session's `readBudget`), and `signal`, which stops the
 * reads early — the caller must then not plan.
 *
 * `ignore` must answer for a path's ancestors as well as the path, as every
 * matcher in ignore.js does.
 */
export async function scanRemote(vfs, root, includeHidden = false, ignore = () => false, ctx = {}) {
    const sess = session(ctx.session);
    const files = {};
    const sizes = {};
    const unknown = new Set();
    const unreadable = new Set();
    const held = new Set();
    const paths = ctx.paths ?? (await walkRemote(vfs, root)).paths;

    // Decide what to read BEFORE reading anything, so the filters are applied
    // once and the reads that survive them can go out together.
    let wanted = [];
    const pace = pacer();
    for (const abs of paths) {
        const breather = pace();
        if (breather) await breather;
        if (ctx.signal?.aborted) return { files, sizes, unknown, unreadable, held };   // not to be planned from
        // Always with a leading slash, to match the local keys: at root "/" the
        // old `abs.slice(root.length)` dropped it, and every file became two
        // paths that pushed, pulled and deleted each other in turn.
        const key = root === "/" ? abs : abs.slice(root.length);
        if (!key.startsWith("/") || key === "/") continue;
        const rel = key.slice(1);
        // Setting a path up to be matched costs its depth squared before any
        // rule runs (ignore.js `withinMatchBounds`), and nothing deeper, or
        // with longer names, than a filesystem holds could land here anyway,
        // so such a path is not matched at all.
        if (!withinMatchBounds(rel, ctx.ignoreCase)) {
            warnOnce(sess, `bounds:${key}`, `skipping ${key} from your filesystem — it is more than ${DEPTH_MAX} directories deep, or has a name longer than ${NAME_MAX} characters`);
            unknown.add(key);
            continue;
        }
        const verdict = admission(rel, false, includeHidden, ignore, ctx.held);
        if (verdict === "held") held.add(key);
        if (verdict === "refused") {
            warnOnce(sess, `refused:${key}`, `refusing ${key} from your filesystem — that path can execute code on this machine`);
            unknown.add(key);
            continue;
        }
        if (verdict === "alias") {
            warnOnce(sess, `alias:${key}`, `refusing ${key} from your filesystem — a volume that folds names would read it as an ignore file`);
            unknown.add(key);
            continue;
        }
        if (verdict === "unknown") {
            costly(sess, key);
            unknown.add(key);
            continue;
        }
        if (verdict) continue;
        wanted.push([key, abs]);
    }
    if (ctx.ignoreCase) wanted = await refuseFoldCollisions(wanted, ctx.localKeys, unknown, sess, ctx.signal, { ignoreCase: true });

    // Read in PARALLEL. Each file is an independent round trip - a manifest
    // lookup plus its shards - so reading them one after another cost the SUM
    // of the latencies. On a project of any size that is the difference between
    // `mount` taking a moment and looking like it has hung: doodledottie is 38
    // files and 16.5MB, which took over twenty seconds in series.
    //
    // And only what has not been read before: content read in an earlier pass
    // (`sess.hashes`) or earlier in this one (`reading`) is not fetched again.
    const queue = [...wanted];
    const readPace = pacer();   // reads from a cache resolve at once, and never yield on their own
    const seen = new Map();      // content key → { hash, size }, for the next pass
    const reading = new Map();   // content key → the read under way
    const oversize = new Map();  // content key → its length, for a read that came back over MAX_BYTES
    const blobs = ctx.blobs ?? blobCache(BLOB_CACHE_BYTES);
    const budget = sess.readBudget;
    const spent = ctx.spent ?? { bytes: 0, files: 0 };
    const deferred = new Set();
    // Bytes in flight are bounded as well as reads (SCAN_WINDOW_BYTES), by the
    // same claim the budget is charged. A read waiting for room is not
    // started once the scan is stopped.
    const window = byteWindow(SCAN_WINDOW_BYTES);
    const STOPPED = Symbol("stopped");
    await Promise.all(
        Array.from({ length: Math.min(SCAN_CONCURRENCY, queue.length) }, async () => {
            for (let item = queue.shift(); item !== undefined && !ctx.signal?.aborted; item = queue.shift()) {
                const breather = readPace();
                if (breather) await breather;
                const [key, abs] = item;
                try {
                    // The record's size, and the manifest's chunk sizes, skip a
                    // file they admit is too big BEFORE fetching it. The record
                    // is only a hint — the remote party writes it, and one that
                    // says 0 can hold anything — so the limit is also the bytes
                    // that come back. The manifest is what a read is held to.
                    const content = await remoteContent(vfs, abs);
                    const { bound } = content;
                    if (content.size > MAX_BYTES || (bound && (bound.plain > MAX_BYTES || bound.fetched > FETCH_MAX))) {
                        tooBig(sess, key, Math.max(content.size, bound?.plain ?? 0, bound?.fetched ?? 0));
                        unknown.add(key);
                        continue;
                    }
                    const known = content.key && (seen.get(content.key) ?? sess.hashes.get(content.key));
                    if (known) {
                        seen.set(content.key, known);
                        files[key] = known.hash;
                        sizes[key] = known.size;
                        continue;
                    }
                    const over = content.key && oversize.get(content.key);
                    if (over) {
                        tooBig(sess, key, over);
                        unknown.add(key);
                        continue;
                    }
                    let read = content.key && reading.get(content.key);
                    if (!read) {
                        // Ignore files included: a 256 KB file of comments is
                        // 256 KB to fetch however little it adds to the rules.
                        const claim = Math.max(content.size, content.bound?.plain ?? 0);
                        if (budget) {
                            if (spent.files && (spent.files + 1 > budget.files || spent.bytes + claim > budget.bytes)) {
                                deferred.add(key);
                                unknown.add(key);
                                continue;
                            }
                            spent.files++;
                            spent.bytes += claim;
                        }
                        read = (async () => {
                            const admitted = await window.acquire(claim, ctx.signal);
                            if (admitted && ctx.signal?.aborted) window.release(claim);   // let in, but stopped since
                            if (!admitted || ctx.signal?.aborted) {
                                if (budget) {   // never read: give back what it was charged
                                    spent.files--;
                                    spent.bytes -= claim;
                                }
                                throw STOPPED;
                            }
                            try {
                                const bytes = await content.read();
                                spent.bytes += bytes.length - claim;
                                return bytes;
                            } finally {
                                window.release(claim);
                            }
                        })();
                        if (content.key) reading.set(content.key, read);
                    }
                    const bytes = await read;
                    if (bytes.length > MAX_BYTES) {
                        tooBig(sess, key, bytes.length);
                        unknown.add(key);
                        if (content.key) {
                            // Only its length is kept: entries sharing this
                            // content get the same answer without the read
                            // (up to 100 MB) staying referenced.
                            oversize.set(content.key, bytes.length);
                            reading.delete(content.key);
                        }
                        continue;
                    }
                    const hash = sha(bytes);
                    files[key] = hash;
                    sizes[key] = bytes.length;
                    if (content.key) {
                        seen.set(content.key, { hash, size: bytes.length });
                        blobs.put(content.key, bytes);
                        // `seen` answers for this content from here on. Left
                        // in `reading`, the settled read held every byte the
                        // pass read, past the blob cache's limit and the window.
                        reading.delete(content.key);
                    }
                } catch (err) {
                    // Stopped before its read began: not read, and nothing to
                    // warn of. The caller does not plan from a stopped scan.
                    if (err === STOPPED) {
                        unknown.add(key);
                        continue;
                    }
                    // One unreadable entry — a lost shard, a planted manifest, a
                    // dropped request — must not stop the whole sync, and must
                    // not read as a deletion either.
                    warnOnce(sess, `unreadable:${key}`, `could not read ${key} from your filesystem (${err?.message ?? err}) — leaving it alone`);
                    unknown.add(key);
                    unreadable.add(key);
                }
            }
        }),
    );
    // What this pass read or recognised is what the next one starts from; a
    // pass cut short keeps what came before as well.
    if (ctx.signal?.aborted) for (const [k, v] of seen) sess.hashes.set(k, v);
    else sess.hashes = seen;
    if (deferred.size) {
        sess.more = true;
        warnOnce(
            sess,
            "read-budget",
            `read ${spent.files} files (${human(spent.bytes)}) from your filesystem in one pass, the most one pass reads; ` +
            `the other ${deferred.size} are compared in the next pass, and left alone until then.`,
        );
    }
    return { files, sizes, unknown, unreadable, deferred, held, blobs };
}

/**
 * How to fetch a remote file, and a key for its content.
 *
 * The key is the file's manifest, which fixes the bytes — shards addressed by
 * their hashes, and the keys that open them — so one key is one content,
 * however many entries point at it and however many passes ask. `read`
 * fetches exactly that content. `bound` is the most a read of it can bring
 * back, from the manifest's own chunk sizes, which the reader holds it to:
 * `plain` bytes out, `fetched` bytes of shards in. Where this vfs cannot say,
 * the key and bound are null and the path is read as it stands.
 */
async function remoteContent(vfs, abs) {
    if (typeof vfs.statManifest !== "function") {
        const size = recordSize((await vfs.stat(abs)).size);
        return { size, key: null, bound: null, read: () => vfs.readFile(abs) };
    }
    const { manifest, size: claimed } = await vfs.statManifest(abs);
    const size = recordSize(claimed);
    const exact = typeof vfs.readByManifest === "function";
    return {
        size,
        key: exact ? sha(JSON.stringify(manifest)) : null,
        bound: manifestBound(manifest),
        read: exact ? () => vfs.readByManifest(manifest) : () => vfs.readFile(abs),
    };
}

/**
 * A record's size, as a number the budgets can add. The record is written by
 * the remote party, so the size may be absent, a string, negative or NaN; any
 * of those counts as 0 (the bytes that come back are what is held to the limit).
 */
function recordSize(size) {
    return Number.isSafeInteger(size) && size >= 0 ? size : 0;
}

/**
 * What a manifest lets a read bring back (see `remoteContent`), or null when
 * it is not in a shape this knows. Each chunk decrypts to its ciphertext less
 * the 16-byte tag, after the reader has fetched every shard at exactly the
 * size the manifest gives — it refuses one that is not.
 */
function manifestBound(manifest) {
    const chunks = manifest?.chunks;
    if (!Array.isArray(chunks)) return null;
    let plain = 0;
    let fetched = 0;
    for (const chunk of chunks) {
        const { ciphertextSize, shardSize, shardHashes } = chunk ?? {};
        if (!Number.isFinite(ciphertextSize) || !Number.isFinite(shardSize) || !Array.isArray(shardHashes)) return null;
        plain += Math.max(0, ciphertextSize - 16);
        fetched += shardHashes.length * shardSize;
    }
    return { plain, fetched };
}

/**
 * A first-come, first-served allowance of `limit` bytes for reads in flight.
 *
 * `acquire(n, signal)` resolves true once `n` more bytes fit — or at once
 * when nothing is held, so one claim larger than the whole window is still
 * let through, alone — and false, without taking anything, when `signal`
 * has fired. Waiters are served in order, so a large claim is not starved by
 * small ones arriving behind it. `release(n)` gives back what an acquire took.
 */
function byteWindow(limit) {
    let held = 0;
    // A claim that is not a finite, non-negative number is 0: NaN in `held`
    // would make nothing fit again, and the scan would never finish.
    const sane = (n) => (Number.isFinite(n) && n > 0 ? n : 0);
    const waiting = [];
    const fits = (n) => held === 0 || held + n <= limit;
    const wake = () => {
        while (waiting.length && fits(waiting[0].n)) {
            const w = waiting.shift();
            held += w.n;
            w.done(true);
        }
    };
    return {
        acquire(claim, signal) {
            const n = sane(claim);
            if (signal?.aborted) return Promise.resolve(false);
            if (!waiting.length && fits(n)) {
                held += n;
                return Promise.resolve(true);
            }
            return new Promise((resolve) => {
                const onAbort = () => {
                    const i = waiting.indexOf(w);
                    if (i < 0) return;
                    waiting.splice(i, 1);
                    resolve(false);
                    wake();   // the head may have been what held the rest
                };
                const w = {
                    n,
                    done: (ok) => {
                        signal?.removeEventListener("abort", onAbort);
                        resolve(ok);
                    },
                };
                waiting.push(w);
                signal?.addEventListener("abort", onAbort, { once: true });
            });
        },
        release(claim) {
            held -= sane(claim);
            wake();
        },
    };
}

/**
 * The bytes a pass has read, by content key, up to `limit` bytes: the oldest
 * go first. What lets a pull of content the scan already read — two hundred
 * entries sharing one blob — write it without fetching it again.
 */
function blobCache(limit) {
    const kept = new Map();
    let total = 0;
    return {
        get(key) {
            return key ? kept.get(key) : undefined;
        },
        put(key, bytes) {
            if (!key || kept.has(key) || bytes.length > limit) return;
            kept.set(key, bytes);
            total += bytes.length;
            for (const [old, b] of kept) {
                if (total <= limit) break;
                kept.delete(old);
                total -= b.length;
            }
        },
    };
}

/**
 * A name as THIS volume compares names — for spotting two remote spellings
 * that would land on one file here.
 *
 * Not `foldName`, which folds further than any one filesystem does because
 * over-folding only refuses more there. Here over-folding costs files: APFS
 * holds `run-10:30.txt` beside `run-10:45.txt`, `report` beside `report.`, and
 * `v2.md` beside `v².md`, and the old fold refused all six on every Mac — a
 * directory of timestamped logs stopped syncing. So: canonical normalization
 * (NFC; APFS ignores the difference, but not compatibility forms), full case
 * folding only when the volume folds case, and Win32's stream and trailing
 * dot rules only on Windows. `writeTarget`'s exact-spelling check is what
 * keeps a write off the wrong file; this only keeps two spellings from taking
 * turns at one name.
 */
function volumeFold(name, { ignoreCase = true, platform = process.platform } = {}) {
    let s = String(name);
    if (platform === "win32") s = s.split(":")[0].replace(/[. ]+$/, "");
    s = s.normalize("NFC");
    return ignoreCase ? s.toLowerCase().toUpperCase().toLowerCase().normalize("NFC") : s;
}

/**
 * On a volume that folds names, two remote paths that fold alike cannot both
 * exist here, and whichever landed second would overwrite the first. Refuse
 * the aliases: where exactly one spelling matches what is already on disk,
 * that one is the real file and syncs; where every spelling is on disk, the
 * disk evidently holds them all and they all sync; otherwise nothing in the
 * group does. Checked on every directory prefix too, since `Src/a.ts` and
 * `src/b.ts` collide on the directory.
 *
 * Prefixes are numbered in two tries — by exact spelling and by fold — so a
 * path costs one step per segment, and each distinct segment is folded once.
 * Refolding every prefix of every path from scratch was quadratic in depth:
 * 20,000 remote paths 60 deep held the event loop for 11.8 seconds.
 */
export async function refuseFoldCollisions(wanted, localKeys = new Set(), unknown, sess, signal, fold = {}) {
    const pace = pacer();
    const folds = new Map();
    const foldOf = (seg) => {
        let f = folds.get(seg);
        if (f === undefined) folds.set(seg, (f = volumeFold(seg, fold)));
        return f;
    };
    const exact = new Map();   // "parent id/segment" → id, by spelling
    const folded = new Map();  // the same, by fold
    const parentOf = [0];
    const segOf = [""];
    const step = (trie, parent, seg) => {
        const k = `${parent}/${seg}`;
        let id = trie.get(k);
        if (id === undefined) {
            trie.set(k, (id = trie.size + 1));
            if (trie === exact) {
                parentOf[id] = parent;
                segOf[id] = seg;
            }
        }
        return id;
    };
    const spelled = (id) => {
        const parts = [];
        for (; id; id = parentOf[id]) parts.push(segOf[id]);
        return parts.reverse().join("/");
    };

    const onDisk = new Set();
    for (const key of localKeys) {
        const breather = pace();
        if (breather) await breather;
        if (signal?.aborted) return [];
        let e = 0;
        for (const seg of key.slice(1).split("/")) onDisk.add((e = step(exact, e, seg)));
    }
    const spellings = new Map();   // fold id → Set of exact ids
    const chains = [];
    for (const [key] of wanted) {
        const breather = pace();
        if (breather) await breather;
        if (signal?.aborted) return [];
        const chain = [];
        let e = 0;
        let f = 0;
        for (const seg of key.slice(1).split("/")) {
            e = step(exact, e, seg);
            f = step(folded, f, foldOf(seg));
            chain.push(e, f);
            if (!spellings.has(f)) spellings.set(f, new Set());
            spellings.get(f).add(e);
        }
        chains.push(chain);
    }
    // Per group, once: every spelling on disk, or the one that is.
    const verdicts = new Map();
    const verdictOf = (f) => {
        let v = verdicts.get(f);
        if (!v) {
            const here = [...spellings.get(f)].filter((e) => onDisk.has(e));
            verdicts.set(f, (v = { all: here.length === spellings.get(f).size, only: here.length === 1 ? here[0] : 0 }));
        }
        return v;
    };
    const kept = [];
    for (let i = 0; i < wanted.length; i++) {
        const breather = pace();
        if (breather) await breather;
        if (signal?.aborted) return [];
        const key = wanted[i][0];
        const chain = chains[i];
        let refused = false;
        for (let k = 0; k < chain.length && !refused; k += 2) {
            const [e, f] = [chain[k], chain[k + 1]];
            const group = spellings.get(f);
            if (group.size < 2) continue;
            const v = verdictOf(f);
            if (v.all || v.only === e) continue;
            const other = [...group].find((s) => s !== e);
            warnOnce(sess, `fold:${key}`, `refusing ${key} — it folds to the same name as /${spelled(other)} on this disk, which cannot hold both`);
            unknown.add(key);
            refused = true;
        }
        if (!refused) kept.push(wanted[i]);
    }
    return kept;
}

// ---- the write boundary ---------------------------------------------------------

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

/** Windows device names, with or without an extension: `nul.txt` opens NUL. */
const WIN32_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * Why Windows cannot hold `name` as itself, or null. Used only on win32: these
 * are ordinary names on macOS and Linux, and a VFS is shared across machines,
 * so refusing them everywhere would hide real files from their owners.
 */
export function win32NameProblem(name) {
    // A backslash is a separator on Windows: the name would be two path
    // components, and the one-at-a-time checks in writeTarget would miss the
    // inner one. connect refuses it today; nothing here depends on that.
    if (name.includes("\\")) return "contains a backslash, which Windows reads as a directory separator";
    if (name.includes(":")) return "contains ':', which Windows reads as a stream of another file";
    if (/[<>"|?*]/.test(name)) return "contains a character Windows does not allow in a name (<>\"|?*)";
    if (/[. ]$/.test(name)) return "ends in a dot or a space, which Windows strips";
    if (WIN32_RESERVED.test(name.split(".")[0].replace(/ +$/, ""))) return "is a Windows device name";
    return null;
}

/**
 * The one gate every write and delete on this disk passes.
 *
 * Walks the key from the mount directory, one component at a time. Every
 * component that already exists must be listed by `readdir` of its parent
 * under EXACTLY that spelling, and be a real directory — not a symlink. A
 * component that is not listed but that `lstat` still finds is an alias: the
 * volume folded case, normalization, an ignorable code point, a trailing dot
 * or an 8.3 short name onto something else. Refuse it. This one check covers
 * every folding rule a filesystem has, including ones nobody has listed yet,
 * because it asks the filesystem rather than predicting it.
 *
 * The final file may be created when absent, or replaced only when it exists
 * under exactly that spelling as a regular file AND the local scan reported it
 * — a synced file. Anything else on disk is local-only (ignored, hidden,
 * refused, over the limit), exists nowhere else, and is never overwritten.
 *
 * This replaces a check of the final component alone. `lstat` follows every
 * other component, so a symlinked directory one level up redirected the write
 * outside the mount; a hard-linked file was truncated in place, changing its
 * twin; and a remote `src/App.ts` overwrote the unsynced `src/app.ts`.
 *
 * Returns `{ ok: true, abs, parent, missing, existing }` — `missing` being the
 * directories to create, in order, and `existing` the stats of the file being
 * replaced — or `{ ok: false, reason }`. `listing` caches `readdir` for a pass.
 */
export async function writeTarget(dir, key, { localKeys = new Set(), listing = new Map(), platform = process.platform, kind = "file" } = {}) {
    const refuse = (reason) => ({ ok: false, reason });
    const names = key.split("/").filter(Boolean);
    if (!names.length) return refuse("it names the mount directory itself");
    if (platform === "win32") {
        for (const name of names) {
            const problem = win32NameProblem(name);
            if (problem) return refuse(`${JSON.stringify(name)} ${problem}`);
        }
    }
    const list = async (d) => {
        if (!listing.has(d)) listing.set(d, await readdir(d).then((n) => new Set(n), () => null));
        return listing.get(d);
    };
    const present = (p) => lstat(p).then(() => true, () => false);
    const alias = (name) => refuse(`${JSON.stringify(name)} is spelled differently from an entry already here that this volume treats as the same name`);

    let parent = dir;
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const abs = join(parent, name);
        const last = i === names.length - 1;
        const entries = await list(parent);
        if (!entries) return refuse(`${parent} could not be listed`);
        if (!entries.has(name)) {
            if (await present(abs)) return alias(name);
            // A folder is made whole, its own name included; a file's last name is the file.
            return { ok: true, abs: join(parent, ...names.slice(i)), parent, missing: kind === "dir" ? names.slice(i) : names.slice(i, -1), existing: null };
        }
        const info = await lstat(abs).catch(() => null);
        if (!last) {
            if (!info?.isDirectory()) return refuse(`${relative(dir, abs)} is ${info?.isSymbolicLink() ? "a symlink" : "not a directory"}`);
            parent = abs;
            continue;
        }
        if (kind === "dir") {
            if (!info?.isDirectory()) return refuse(`${relative(dir, abs)} is ${info?.isSymbolicLink() ? "a symlink" : "not a directory"}`);
            return { ok: true, abs, parent, missing: [], existing: info };
        }
        if (!info?.isFile()) return refuse(`${relative(dir, abs)} is a symlink or not a regular file`);
        if (!localKeys.has(key)) return refuse(`${relative(dir, abs)} exists here but is not synced (ignored, hidden or refused), so it may exist nowhere else`);
        return { ok: true, abs, parent, missing: [], existing: info };
    }
    return refuse("unreachable");
}

/**
 * Write `bytes` where `writeTarget` said: missing directories one component at
 * a time, then a temp file in the verified parent renamed over the target.
 *
 * Rename replaces the directory ENTRY, so a hard-linked twin keeps its bytes;
 * `wx` means the temp name can never be an existing link. The replaced file's
 * permission bits are copied across, so an edit to `scripts/deploy.sh` or
 * `gradlew` made on another machine still runs here — stripping the execute
 * bit would break every such edit, and a freshly created file gets the
 * default mode, never an execute bit.
 */
async function writeAt(target, bytes, listing) {
    const parent = await makeMissing(target, listing);
    const tmp = join(parent, TMP_PREFIX + randomBytes(6).toString("hex"));
    try {
        await writeFile(tmp, bytes, { flag: "wx" });
        if (target.existing) await chmod(tmp, target.existing.mode & 0o777);
        await rename(tmp, target.abs);
    } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
    }
    listing.get(parent)?.add(target.abs.slice(parent.length + 1));
}

/**
 * Apply the folder plan (`planDirs`), after the files: folders are made
 * shallowest first and removed deepest first, so a folder emptied by this
 * pass's file deletes is gone by its end.
 *
 * A folder is only ever removed EMPTY — `rmdir` here, a delete that is not
 * recursive there — so removing one can never take a file with it, synced or
 * not. One that still holds something (an ignored or refused file, or one that
 * arrived since the scan) is kept, said once, and left out of the state: the
 * next pass sees it on one side only and makes it on the other again, which is
 * the truth, since it is not empty. Removals are gated by `--allow-delete` as
 * file deletes are; a removal not made is forgotten, as theirs is.
 */
async function applyDirPlan({ vfs, dir, root, state, plan, opts, sess, signal }) {
    const next = { ...state };
    const listing = new Map();
    const remoteAbs = (path) => (root === "/" ? path : root + path);
    const depth = (path) => path.split("/").length;
    const makes = plan.filter(({ action }) => !action.startsWith("rmdir")).sort((a, b) => depth(a.path) - depth(b.path));
    const removes = plan.filter(({ action }) => action.startsWith("rmdir")).sort((a, b) => depth(b.path) - depth(a.path));
    const kept = (path, where) => warnOnce(sess, `dir-kept:${where}:${path}`, `kept the folder ${path}/ ${where} — it still holds files that are not synced`);
    for (const { path, action } of [...makes, ...removes]) {
        if (signal?.aborted) break;
        const key = dirKey(path);
        try {
            switch (action) {
                case "record":
                    next[key] = DIR;
                    break;
                case "forget":
                    delete next[key];
                    break;
                case "mkdir-remote":
                    await vfs.mkdir(remoteAbs(path), { recursive: true });
                    next[key] = DIR;
                    info(`${SIGN.push} ${path}/`);
                    break;
                case "mkdir-local": {
                    const target = await writeTarget(dir, path, { listing, kind: "dir" });
                    if (!target.ok) {
                        warnOnce(sess, `declined:${action}:${path}`, `skipping ${path}/ — ${target.reason}`);
                        break;
                    }
                    if (!target.existing) await makeMissing(target, listing);
                    next[key] = DIR;
                    info(`${SIGN.pull} ${path}/`);
                    break;
                }
                case "rmdir-remote": {
                    delete next[key];
                    if (!opts.allowDelete) {
                        warn(
                            `${path}/ is gone locally but still in your filesystem — not deleting it.`,
                            `  Pass --allow-delete to propagate deletions, or remove it with: muhkoo vfs rm -r ${remoteAbs(path)}`,
                        );
                        break;
                    }
                    const found = await vfs.stat(remoteAbs(path)).catch(() => null);
                    if (found?.kind !== "dir") break;
                    try {
                        await vfs.delete(remoteAbs(path));   // not recursive: refused unless empty
                        info(`${SIGN["delete-remote"]} ${path}/ (deleted from your filesystem)`);
                    } catch {
                        kept(path, "in your filesystem");
                    }
                    break;
                }
                case "rmdir-local": {
                    delete next[key];
                    if (!opts.allowDelete) {
                        warn(`${path}/ is gone from your filesystem but still here — not deleting it locally.`, `  Pass --allow-delete to propagate deletions.`);
                        break;
                    }
                    const target = await writeTarget(dir, path, { listing, kind: "dir" });
                    if (!target.ok || !target.existing) break;
                    try {
                        await rmdir(target.abs);
                        listing.get(target.parent)?.delete(target.abs.slice(target.parent.length + 1));
                        listing.delete(target.abs);
                        info(`${SIGN["delete-local"]} ${path}/ (deleted from this disk)`);
                    } catch (err) {
                        if (err.code !== "ENOTEMPTY" && err.code !== "EEXIST") throw err;
                        kept(path, "on this disk");
                    }
                    break;
                }
            }
        } catch (err) {
            const message = err?.message ?? String(err);
            warnOnce(sess, `error:${path}/:${message}`, `${path}/: ${message}`);
        }
    }
    return next;
}

/** Make the directories `writeTarget` found missing, in order; returns the deepest. */
async function makeMissing(target, listing) {
    let parent = target.parent;
    for (const name of target.missing) {
        const next = join(parent, name);
        await mkdir(next);   // not recursive: each component is created here, never followed
        listing.get(parent)?.add(name);
        listing.set(next, new Set());
        parent = next;
    }
    return parent;
}

// ---- planning and applying ------------------------------------------------------

/**
 * Scan both sides and plan, without changing anything.
 *
 * Shared by `mount` (via `reconcile`) and `import`, so the rules about what is
 * skipped and what a delete means are defined in exactly one place. Returns
 * null when `signal` stopped it: a half-finished scan must never be planned
 * from, since what it did not reach would read as deleted.
 *
 * `rulesDir` is the directory whose stored ignore rules apply, when that is not
 * the one scanned: a dry run of a mount on a directory that is not there yet
 * scans an empty stand-in, but the rules are the ones recorded for the real
 * directory, which the mount will find once it has created it.
 */
async function preparePass({ vfs, dir, rulesDir = dir, root, state, opts, sess, save = true, signal, blobs, read }) {
    if (sess.ignoreCase === undefined) sess.ignoreCase = await foldsCase(dir);
    const ignores = ignoreContext(sess, await loadSnapshots(rulesDir, root), { hidden: Boolean(opts.hidden) });
    await seeRootFiles(dir, ignores);
    // The remote walk is the slow part; start it while the local scan runs.
    // The remote FILTER has to wait for the local scan, which is what finds
    // the nested ignore files.
    const [local, listed] = await Promise.all([
        scanLocal(dir, { hidden: opts.hidden, ignores, sess, signal }),
        walkRemote(vfs, root),
    ]);
    if (signal?.aborted) return null;
    // The ignore files as they now stand are known; nothing has been pulled.
    await ignores.record(rulesDir, root, save);
    const remote = await scanRemote(vfs, root, opts.hidden, ignores.now, {
        paths: listed.paths, held: ignores.held, session: sess, ignoreCase: sess.ignoreCase,
        localKeys: new Set(Object.keys(local.files)), signal, blobs, spent: read,
    });
    if (signal?.aborted) return null;
    sess.admit = (rel, isDir) => admission(rel, isDir, opts.hidden, ignores.now, ignores.held);
    // One warning for them all: a hostile ignore file can make thousands.
    const costlyPaths = [...(sess.costly ?? [])].sort();
    sess.costly = null;
    if (costlyPaths.length) {
        warnOnce(
            sess,
            `costly:${costlyPaths.join("\0")}`,
            `leaving ${costlyPaths.length} path${costlyPaths.length === 1 ? "" : "s"} alone — matching ${costlyPaths.length === 1 ? "it" : "them"} ` +
            `against the ignore rules would take too long: ${costlyPaths.slice(0, 5).join(", ")}${costlyPaths.length > 5 ? ", …" : ""}. ` +
            `Nothing is synced or deleted for ${costlyPaths.length === 1 ? "it" : "them"}; simpler ignore rules, or shorter names, let them sync.`,
        );
    }
    const keptBack = [...new Set([...local.held, ...remote.held])].sort();
    if (keptBack.length) warnOnce(sess, `kept-back:${keptBack.join("\0")}`, ...heldNotice(keptBack, rulesDir));

    const unknown = new Set([...local.unknown, ...remote.unknown]);
    const files = filesOf(state);
    const planned = planSync({ last: files, local: local.files, remote: remote.files, unknown });
    const views = { local: Object.keys(local.files).length, remote: Object.keys(remote.files).length };
    sess.peak = Math.max(sess.peak ?? 0, Object.keys(files).length);
    const { plan, held } = holdMassDeletes(planned, files, views, sess.peak);
    for (const h of held) warnOnce(sess, `held:${h.action}:${h.count}`, ...breakerMessage(h, dir, root));
    // Folders after files, by the same rule. When the breaker held file
    // deletes, no folder is removed either: the same pass would empty them.
    let dirPlan = planDirs({
        last: state,
        local: local.dirs,
        remote: remoteDirs(listed.dirs, root, { hidden: opts.hidden, ignores, ignoreCase: sess.ignoreCase }),
        unknown,
        fold: sess.ignoreCase ? caseFold : null,
    });
    if (held.length) dirPlan = dirPlan.filter(({ action }) => !action.startsWith("rmdir"));
    return {
        plan, dirPlan, local: local.files, remote: remote.files, sizes: remote.sizes, blobs: remote.blobs, ignores,
        unreadable: remote.unreadable, deferred: remote.deferred,
        landed: new Set(),     // ignore files pulled in this pass
        notLanded: new Map(),  // and why the others were not
    };
}

/** The breaker's warning, as lines. */
function breakerMessage({ action, count, tracked, empty }, dir, root) {
    if (action === "delete-local") {
        return [
            `refusing to delete ${count} of ${tracked} files from ${dir} in one pass — they are gone from ${root}, ` +
            `which ${empty ? "now holds nothing at all" : "looks like a missing or renamed root, not an edit"}. Nothing was deleted.`,
            `  If you meant it, delete them here yourself; to upload them all again instead, remove ${statePath(dir)}.`,
        ];
    }
    return [
        `refusing to delete ${count} of ${tracked} files from your filesystem (${root}) in one pass — they are gone from ${dir}, ` +
        `which ${empty ? "now holds nothing at all" : "looks like a wiped or switched directory, not an edit"}. Nothing was deleted.`,
        `  If you meant it, use: muhkoo vfs rm -r <path>; to download them all again instead, remove ${statePath(dir)}.`,
    ];
}

/**
 * Apply a plan, and return the new last-synced view.
 *
 * Every step that changes something — a write to the filesystem, a delete, a
 * file landing on this disk — is made one at a time, in plan order: writes
 * touch one directory record each, and two concurrent writes to the same
 * record would have one silently lose ([[VfsNamespace]] consistency note).
 * Pushes, deletes and conflicts are applied exactly as before, in sequence.
 *
 * Only the FETCH of a pull overlaps: up to PULL_CONCURRENCY pulls, in plan
 * order, are fetched while the oldest lands. A pull reads nothing but the
 * network and the pass's blob cache, so overlapping them changes no state;
 * landing stays in plan order, on the same checks, so what lands — and which
 * of two spellings a folding volume refuses — is what a sequential pass would
 * land. A step that is not a pull first lands every pull before it.
 *
 * `signal` stops it between steps — never inside one — and what was done by
 * then is what it returns. Pulls fetched but not yet landed when it fires are
 * dropped, unrecorded, and the next pass plans them again.
 *
 * A step this disk declines (a pull onto a symlink, a remote file where a
 * directory stands) is warned about once and left out of the result, so the
 * state does not change and nothing is written — which is what keeps a plan
 * that cannot converge from waking the watcher into another pass.
 *
 * What it held back is left in `pass.outstanding`: pulls waiting for disk
 * space, and pulls past the pass's budget.
 */
async function applyPlan({ vfs, dir, root, state, plan, pass, opts, sess, signal, budget = { bytes: 0, files: 0 } }) {
    const next = { ...state };
    const listing = new Map();
    const localKeys = new Set(Object.keys(pass.local));
    const decline = (action, path, reason) => warnOnce(sess, `declined:${action}:${path}`, `skipping ${path} — ${reason}`);
    const failed = (action, path, err) => {
        const message = err?.message ?? String(err);
        warnOnce(sess, `error:${path}:${message}`, `${path}: ${message}`);
        if (action === "pull" && isIgnoreFile(path.slice(1))) pass.notLanded?.set(path, message);
    };
    let short = 0;   // pulls held for want of disk space
    let over = 0;    // and past the pass's budget

    // ---- pulls: admitted and fetched ahead, landed in order ----
    //
    // Held pulls change nothing, so the next pass plans them again. Each limit
    // is checked twice: on the size the scan read, so a pull that cannot fit is
    // not fetched at all, and then on the bytes actually fetched — the file may
    // have changed since, and they are what land on this disk.
    //
    // A pull is RESERVED against both limits when it is admitted, before it is
    // fetched: `inFlight` is what has been admitted and not yet landed. Without
    // it, pulls checked together, before any had landed, would each see the
    // same free space and the same budget, and together overshoot both.
    //
    // Ignore files are held to the same limits. They were exempt as "small",
    // and a 256 KB file of comments, copied to thousands of directories, put
    // 7 GiB on a disk already under its reserve in one pass. One held here
    // holds this pass's uploads instead (see `reconcile`).
    const limit = sess.pullBudget;
    const inFlight = { files: 0, bytes: 0 };
    const window = [];               // pulls being fetched, in plan order
    const fetching = new Map();      // content key → its fetch, so two entries sharing it fetch it once
    /**
     * Why a pull of `size` more bytes must wait, or null. `admitted`: the pull
     * was let in already, so a budget that has filled behind it — with pulls
     * admitted after it, which it lands ahead of — does not stop it; only its
     * own bytes, with what is still in flight, going over does.
     */
    const holdFor = async (size, admitted = false) => {
        const files = budget.files + inFlight.files;
        if ((budget.full && !admitted) || (files && (files + 1 > limit.files || budget.bytes + inFlight.bytes + size > limit.bytes))) {
            budget.full = true;
            over++;
            return "this pass has pulled all it may; the next pass carries on";
        }
        if (await roomFor(dir, inFlight.bytes + size, sess)) return null;
        short++;
        return "the disk would be left with less than its reserve free";
    };
    /** The bytes of `remoteAbs`. Content the scan read — or an earlier pull, of an entry sharing it — is not fetched again. */
    const fetchBytes = async (remoteAbs) => {
        const content = await remoteContent(vfs, remoteAbs);
        const kept = pass.blobs?.get(content.key);
        if (kept) return kept;
        let read = content.key ? fetching.get(content.key) : undefined;
        if (!read) {
            read = content.read();
            if (content.key) {
                fetching.set(content.key, read);
                read.then(() => fetching.delete(content.key), () => fetching.delete(content.key));
            }
        }
        const bytes = await read;
        pass.blobs?.put(content.key, bytes);
        return bytes;
    };
    /** Admit a pull and start fetching it; null when it is held or declined here. */
    const startPull = async (path, remoteAbs) => {
        const claim = pass.sizes?.[path] ?? 0;
        const hold = await holdFor(claim);
        if (hold) {
            pass.notLanded?.set(path, hold);
            return null;
        }
        // A target this disk refuses is not fetched at all. Checked again when
        // it lands: the pulls landing ahead of it may have changed the answer.
        const target = await writeTarget(dir, path, { localKeys, listing });
        if (!target.ok) {
            decline("pull", path, target.reason);
            pass.notLanded?.set(path, target.reason);
            return null;
        }
        inFlight.files++;
        inFlight.bytes += claim;
        const bytes = fetchBytes(remoteAbs);
        bytes.catch(() => {});   // its failure is reported when it lands
        return { path, remoteAbs, claim, bytes };
    };
    /** Land a fetched pull: the same checks a sequential pass made, then the write. */
    const land = async ({ path, remoteAbs, claim, bytes: fetched }) => {
        inFlight.files--;
        inFlight.bytes -= claim;
        const bytes = await fetched;
        if (bytes.length > MAX_BYTES) {
            tooBig(sess, path, bytes.length);
            pass.notLanded?.set(path, "it is over the mount's size limit");
            return;
        }
        const hold = await holdFor(bytes.length, true);
        if (hold) {
            pass.notLanded?.set(path, hold);
            return;
        }
        // An ignore file that cannot be read as rules is not pulled: landed, it
        // would stop every pass (see `see`), and uploads wait for it instead
        // (see `reconcile`).
        const rules = isIgnoreFile(path.slice(1));
        const problem = rules && ignoreFileProblem(bytes);
        if (problem) {
            decline("pull", path, `it cannot be read as ignore rules: ${problem}. If it is not yours, remove it: muhkoo vfs rm ${remoteAbs}`);
            pass.notLanded?.set(path, `it cannot be read as ignore rules: ${problem}`);
            return;
        }
        const target = await writeTarget(dir, path, { localKeys, listing });
        if (!target.ok) {
            decline("pull", path, target.reason);
            pass.notLanded?.set(path, target.reason);
            return;
        }
        await writeAt(target, bytes, listing);
        next[path] = sha(bytes);
        if (rules) pass.landed?.add(path);
        budget.files++;
        budget.bytes += bytes.length;
        info(`${SIGN.pull} ${path}`);
    };
    const landOldest = async () => {
        const pull = window.shift();
        try {
            await land(pull);
        } catch (err) {
            failed("pull", pull.path, err);
        }
    };
    /** Room for another pull in the window? Bounded in files, and — by what the records claim — in bytes held. */
    const windowFull = () => window.length >= PULL_CONCURRENCY || (window.length > 0 && inFlight.bytes >= PULL_WINDOW_BYTES);

    for (const { path, action } of plan) {
        if (signal?.aborted) break;
        const localAbs = localPathFor(dir, path);
        if (!localAbs) {
            // Warn and skip rather than throw: one bad path must not abandon
            // the rest of the sync.
            warn(`refusing ${path} — it resolves outside ${dir}`);
            delete next[path];
            continue;
        }
        const remoteAbs = root === "/" ? path : root + path;
        if (action === "pull") {
            while (windowFull() && !signal?.aborted) await landOldest();
            if (signal?.aborted) break;
            try {
                const pull = await startPull(path, remoteAbs);
                if (pull) window.push(pull);
            } catch (err) {
                failed(action, path, err);
            }
            continue;
        }
        // Anything else waits for the pulls before it, so steps still take
        // effect in plan order.
        while (window.length && !signal?.aborted) await landOldest();
        if (signal?.aborted) break;
        try {
            switch (action) {
                case "push": {
                    const bytes = await readFile(localAbs);
                    await vfs.writeFile(remoteAbs, new Uint8Array(bytes));
                    next[path] = sha(bytes);
                    info(`${SIGN.push} ${path}`);
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
                            `${path} is gone locally but still in your filesystem — not deleting it.`,
                            `  Pass --allow-delete to propagate deletions, or remove it with: muhkoo vfs rm ${remoteAbs}`,
                        );
                        delete next[path];   // stop re-reporting it every pass
                        break;
                    }
                    await vfs.delete(remoteAbs).catch(() => {});
                    delete next[path];
                    info(`${SIGN["delete-remote"]} ${path} (deleted from your filesystem)`);
                    break;
                case "delete-local": {
                    // Gated like the remote direction. `--allow-delete` used to
                    // cover only deletions going UP, so anything able to remove
                    // a file from the filesystem removed it from the
                    // developer's disk with no flag and no prompt — the exact
                    // unrecoverable case the remote branch takes care over.
                    if (!opts.allowDelete) {
                        warn(
                            `${path} is gone from your filesystem but still here — not deleting it locally.`,
                            `  Pass --allow-delete to propagate deletions.`,
                        );
                        delete next[path];
                        break;
                    }
                    const target = await writeTarget(dir, path, { localKeys, listing });
                    if (!target.ok || !target.existing) {
                        decline(action, path, target.reason ?? "it is not on disk as a synced file");
                        break;
                    }
                    await unlink(target.abs);
                    listing.get(target.parent)?.delete(target.abs.slice(target.parent.length + 1));
                    delete next[path];
                    info(`${SIGN["delete-local"]} ${path} (deleted from this disk)`);
                    break;
                }
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
                        `conflict on ${path} — kept your local copy.`,
                        `  The other version is still there: muhkoo vfs history ${remoteAbs}`,
                    );
                    break;
                }
            }
        } catch (err) {
            failed(action, path, err);
        }
    }
    // Land what is still fetching — or, stopped, drop it: a fetch is not a
    // step, and nothing is recorded for a pull that did not land. Its fetch is
    // still waited for, so none runs on after the pass has returned.
    while (window.length && !signal?.aborted) await landOldest();
    if (window.length) {
        await Promise.allSettled(window.map((p) => p.bytes));
        window.length = 0;
    }
    if (budget.full) {
        sess.more = true;
        warnOnce(
            sess,
            "pull-budget",
            `pulled ${budget.files} files (${human(budget.bytes)}) in one pass, the most one pass takes; ` +
            `the rest follow in the next pass.`,
        );
    }
    pass.outstanding = { space: short, budget: over };
    return next;
}

/** What a pass left undone (`session.outstanding`), as a phrase: "" when nothing. */
function undone({ space = 0, budget = 0, uploads = 0 } = {}) {
    const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    return [
        space && `${n(space, "file waits", "files wait")} for disk space`,
        budget && `${n(budget, "file follows", "files follow")} in the next pass`,
        uploads && `${n(uploads, "change waits", "changes wait")} to upload until ignore rules come down`,
    ].filter(Boolean).join("; ");
}

/** Note a path too costly to match against the ignore rules; `preparePass` names them all at once. */
function costly(sess, key) {
    (sess.costly ??= new Set()).add(key);
}

/** The warning for a file over MAX_BYTES, once. */
function tooBig(sess, key, size) {
    warnOnce(sess, `big:${key}`, `skipping ${key} — ${Math.round(size / 1e6)} MB is over the mount limit`);
}

/** Would pulling `size` bytes leave the mount's volume its reserve? Unknown: yes. */
async function roomFor(dir, size, sess) {
    let fsinfo;
    try {
        fsinfo = await sess.statfs(dir);
    } catch {
        return true;   // no answer from this platform; the pass budget still bounds a pass
    }
    const total = Number(fsinfo.blocks) * Number(fsinfo.bsize);
    const free = Number(fsinfo.bavail) * Number(fsinfo.bsize);
    return free - size >= Math.min(RESERVE_MAX, Math.max(RESERVE_MIN, total * RESERVE_SHARE));
}

/**
 * `state` with every path the two sides already agree on recorded as synced.
 *
 * The planner has nothing to do for such a path, so nothing else recorded it,
 * and a checkout mounted onto the project it came from — a git clone, or a
 * directory whose `.muhkoo/` was cleaned — stayed out of the state for good.
 * A teammate's next edit then read as a change on BOTH sides: a conflict,
 * which this machine's stale copy won, overwriting the edit.
 */
function withAgreed(state, pass) {
    let next = state;
    for (const [path, hash] of Object.entries(pass.local)) {
        if (pass.remote[path] !== hash || state[path] === hash) continue;
        if (next === state) next = { ...state };
        next[path] = hash;
    }
    return next;
}

/**
 * Persist what a pass changed, and nothing it did not.
 *
 * Writing the state file on a pass that changed nothing is what kept an
 * unconvergeable plan alive: the write woke the watcher, the watcher ran
 * another pass, and that pass planned the same refused action again.
 */
async function persist(dir, root, state, next) {
    if (!sameState(state, next)) await saveState(dir, root, next);
}

/**
 * Ignore files from elsewhere that `pass` could not read, or has not read yet —
 * path to why — leaving out any whose copy on this disk is the one last synced.
 * Their rules are missing from the plan, and may keep some of its uploads home.
 */
function unreadRules(pass, state) {
    const out = new Map();
    for (const path of [...pass.unreadable, ...pass.deferred]) {
        if (!isIgnoreFile(path.slice(1)) || (path in pass.local && pass.local[path] === state[path])) continue;
        out.set(path, pass.unreadable.has(path) ? "it could not be read" : "this pass has read all it may; the next pass reads it");
    }
    return out;
}

/**
 * Reconcile once, and return the new last-synced view.
 *
 * Ignore files that are coming down come down FIRST, and the pass is planned
 * again under them. Otherwise the pushes were decided before the project's own
 * rules arrived: a fresh directory with a local `config/master.key`, mounted
 * onto a project whose `.gitignore` lists it, uploaded the key in the very
 * pass that brought the `.gitignore`. Rules from elsewhere can only add
 * exclusions, so applying them early can only keep more at home.
 *
 * One that did not come down — held for disk space or by the pass's budget,
 * unreadable, not yet read, or too large to be read as rules — means this plan
 * was made without rules that may keep some of its uploads home, so nothing
 * uploads until it is here; pulls go ahead. Both rounds share the pass's pull
 * and read budgets.
 *
 * What the pass left undone is left in `session.outstanding`, for `mount` to
 * say. `session` is what a running mount keeps between passes (see
 * `session`); omitted, each call starts fresh. `signal` stops the pass: before
 * planning, or between steps, and what was done by then is saved.
 */
export async function reconcile({ vfs, dir, root, state, opts = {}, session: s, signal }) {
    const sess = session(s);
    if (signal?.aborted) return state;
    // A restart begins with what earlier runs hashed (see `loadHashCache`).
    if (!sess.hashCacheLoaded) {
        sess.hashCacheLoaded = true;
        if (sess.hashes.size === 0) sess.hashes = await loadHashCache(dir);
        sess.hashCacheSaved = new Map(sess.hashes);
    }
    try {
        return await reconcilePass({ vfs, dir, root, state, opts, sess, signal });
    } finally {
        // Written only when it changed: most passes hash nothing new.
        if (!sameHashes(sess.hashes, sess.hashCacheSaved)) {
            await saveHashCache(dir, sess.hashes).catch((err) => warn(`could not save the content hash cache: ${err?.message ?? err}`));
            sess.hashCacheSaved = new Map(sess.hashes);
        }
    }
}

async function reconcilePass({ vfs, dir, root, state, opts, sess, signal }) {
    const budget = { bytes: 0, files: 0 };   // what the whole pass may pull, both rounds
    const read = { bytes: 0, files: 0 };     // and read to compare
    let pass = await preparePass({ vfs, dir, root, state, opts, sess, signal, read });
    if (!pass) return state;
    const rulesDue = (plan) => plan.filter(({ path, action }) => action === "pull" && isIgnoreFile(path.slice(1)));
    const rules = rulesDue(pass.plan);
    const waiting = new Map();   // ignore files from elsewhere that have not come down → why
    if (rules.length && rules.length < pass.plan.length) {
        const next = await applyPlan({ vfs, dir, root, state, plan: rules, pass, opts, sess, signal, budget });
        await persist(dir, root, state, next);
        for (const { path } of rules) {
            if (!pass.landed.has(path)) waiting.set(path, pass.notLanded.get(path) ?? "it could not be pulled");
        }
        state = next;
        if (signal?.aborted) return state;
        pass = await preparePass({ vfs, dir, root, state, opts, sess, signal, blobs: pass.blobs, read });
        if (!pass) return state;
    }
    // Still due in the plan just made; or one the scan could not read, or has
    // not read yet, unless this disk holds the copy last synced.
    for (const { path } of rulesDue(pass.plan)) {
        if (!waiting.has(path)) waiting.set(path, "it has not come down yet");
    }
    for (const [path, why] of unreadRules(pass, state)) waiting.set(path, why);
    let plan = pass.plan;
    const uploads = plan.filter(({ action }) => UPLOADS.has(action));
    if (waiting.size && uploads.length) {
        plan = plan.filter(({ action }) => !UPLOADS.has(action));
        // Said again whenever what is held changes: once per session let a
        // user go on editing, and nothing uploading, with no word after the
        // first pass.
        const names = [...waiting.keys()].sort();
        const held = uploads.map(({ path }) => path);
        warnOnce(
            sess,
            `rules-missing:${names.join("\0")}:${held.join("\0")}`,
            `not uploading ${held.length} change${held.length === 1 ? "" : "s"} this pass (${held.slice(0, 5).join(", ")}${held.length > 5 ? ", …" : ""}): ` +
            `ignore rules from your filesystem have not come down here, and they may keep some of these files home.`,
            ...names.slice(0, 5).map((path) => `  ${path}: ${waiting.get(path)}`),
            ...(names.length > 5 ? [`  …and ${names.length - 5} more ignore files`] : []),
            "  Pulls go on, and the next pass tries again. An ignore file that is not yours can be removed there: muhkoo vfs rm <path>",
        );
    }
    const agreed = withAgreed(state, pass);
    let next = plan.length ? await applyPlan({ vfs, dir, root, state: agreed, plan, pass, opts, sess, signal, budget }) : agreed;
    // While uploads wait on ignore rules, so do the folders going up.
    const dirPlan = waiting.size ? pass.dirPlan.filter(({ action }) => !action.endsWith("-remote")) : pass.dirPlan;
    if (dirPlan.length && !signal?.aborted) next = await applyDirPlan({ vfs, dir, root, state: next, plan: dirPlan, opts, sess, signal });
    await persist(dir, root, state, next);
    const short = pass.outstanding?.space ?? 0;
    if (short) {
        warnOnce(
            sess,
            "disk-reserve",
            `not pulling ${short} file${short === 1 ? "" : "s"}: the disk holding ${dir} would be left with less than ` +
            `its reserve free (5% of the volume, at least 1 GiB and at most 10 GiB).`,
            "  Free some space, and they come down in the next pass — a change here or in your filesystem starts one, and so does restarting the mount.",
        );
    }
    sess.outstanding = {
        space: short,
        budget: (pass.outstanding?.budget ?? 0) + pass.deferred.size,
        uploads: plan === pass.plan ? 0 : uploads.length,
    };
    return next;
}

// ---- import -----------------------------------------------------------------------

/**
 * `import` only uploads.
 *
 * It used to run the full two-way reconcile, so a command documented as
 * "upload whole projects, once" wrote remote files into the project — the
 * `.vcsignore` that then widened what uploads among them — and, with
 * `--allow-delete`, deleted local files a remote party had removed. Now:
 *
 *   push           applied
 *   conflict       applied as a push: local wins, as `mount` does, and the
 *                  other version stays in `vfs history`
 *   delete-remote  applied only with --allow-delete
 *   pull, delete-local, and delete-remote without the flag: skipped, reported,
 *                  and left out of state — so a later `mount` still sees them
 *                  for what they are.
 */
function importPlan(plan, allowDelete) {
    const apply = [];
    const skipped = [];
    for (const step of plan) {
        const allowed = step.action === "push" || step.action === "conflict" || step.action === "forget"
            || (step.action === "delete-remote" && allowDelete);
        (allowed ? apply : skipped).push(step);
    }
    return { apply, skipped };
}

const SKIP_REASON = {
    pull: "changed only in your filesystem — import only uploads; `muhkoo vfs mount` brings it down",
    "delete-local": "gone from your filesystem — import never deletes here",
    "delete-remote": "gone locally — pass --allow-delete to delete it from your filesystem",
};

/**
 * Push a directory up once and stop — no watcher.
 *
 * The same scan, admission rule and planner `mount` uses; see `importPlan` for
 * what it does with the plan. This is the command for "get this project into
 * my filesystem"; `mount` is for "and keep it that way".
 *
 * One process means ONE vault unlock, which is the practical reason this exists
 * rather than a shell loop over `vfs put`: unlocking per file trips the auth
 * rate limiter well before a real project finishes uploading.
 */
export async function importOnce({ client, dir, root, opts = {} }) {
    await assertMountable(dir);
    const vfs = client.vfs;
    const sess = session({ readBudget: null });   // one pass, which has to compare everything
    // A dry run writes nothing, not even the probe file `foldsCase` writes and removes.
    if (opts.dryRun) sess.ignoreCase = await foldsCaseReadOnly(dir);
    const state = await loadState(dir, root);
    const pass = await preparePass({ vfs, dir, root, state, opts, sess, save: !opts.dryRun });
    const { apply, skipped } = importPlan(pass.plan, opts.allowDelete);
    const shown = apply.filter((p) => p.action !== "forget");

    // Say what will happen before spending metered bytes. A project directory
    // is easy to point at the wrong place, and the bytes are billed either way.
    //
    // Sizes are stat'd here rather than carried out of `scanLocal`, which
    // returns hashes — the scan is shared with `mount`, and widening its return
    // shape to serve one caller's progress line is not worth the churn.
    const uploads = apply.filter((p) => p.action === "push" || p.action === "conflict");
    const bytes = (
        await Promise.all(
            uploads.map(async ({ path }) => {
                try {
                    return (await stat(join(dir, path.slice(1).split("/").join(sep)))).size;
                } catch {
                    return 0;
                }
            }),
        )
    ).reduce((n, size) => n + size, 0);
    const reportSkipped = () => {
        for (const { path, action } of skipped) info(`${SIGN.skip} ${path} (skipped: ${SKIP_REASON[action]})`);
    };

    if (opts.dryRun) {
        if (!shown.length && !skipped.length) return ok(`${root} already matches ${dir}.`);
        for (const { path, action } of shown) info(`${SIGN[action] ?? "?"} ${path}${DESCRIBE[action] ?? ""}`);
        reportSkipped();
        info("", `${shown.length} change(s); ${uploads.length} file(s) to upload, ${human(bytes)}.`);
        return info(`Ignoring per ${describeSource(pass.ignores.source())}.`);
    }

    const agreed = withAgreed(state, pass);
    if (!apply.length) {
        await persist(dir, root, state, agreed);
        reportSkipped();
        // Not "already matches" when differences were just listed: they are
        // ones import leaves alone, and the two sides still differ.
        if (skipped.length) return ok(`Nothing to upload from ${dir} — import leaves the ${skipped.length} difference(s) above alone.`);
        return ok(`${root} already matches ${dir} — nothing to upload.`);
    }
    info(`Importing ${dir} → ${root} (${uploads.length} file(s), ${human(bytes)}; ignoring per ${describeSource(pass.ignores.source())})`);
    const next = await applyPlan({ vfs, dir, root, state: agreed, plan: apply, pass, opts, sess });
    await persist(dir, root, state, next);
    reportSkipped();
    ok(`Imported into ${root}.`);
    await noteStateFile(dir);
}

/**
 * What `mount` would do, without doing any of it.
 *
 * `--dry-run` used to be read by import alone, so `vfs mount <dir> --dry-run`
 * dropped the flag and mounted for real: pulling, pushing and, with
 * --allow-delete, deleting — the opposite of what was asked. This is the same
 * scan and planner a pass runs, printed in both directions, and then it stops:
 * no watcher.
 *
 * It writes nothing, anywhere: no state, no rules (nor their copy under
 * ~/.muhkoo), and not even for a moment — the volume's case folding is asked
 * of the names already there, not probed with a file. It plans everything, with
 * none of a pass's budgets, so for a large project it shows what the passes a
 * mount runs until it is done would do, not what the first one alone would.
 * Uploads a pass would hold, because an ignore file from elsewhere cannot be
 * read, are marked held and left out of the count.
 *
 * A directory that does not exist yet is not created: the pass is planned
 * against an empty stand-in, which is what the mount would start from, under
 * the ignore rules recorded for the real directory. Its volume cannot be asked
 * about case folding, so it is taken to fold — which only ever refuses more. A
 * path the mount could not create, or use, is refused here as the mount would
 * refuse it.
 */
export async function previewMount({ client, dir, root, opts = {} }) {
    const vfs = client.vfs;
    const kind = await mountTarget(dir);
    if (kind === "dir") await assertMountable(dir);
    const sess = session({ readBudget: null });   // no budgets: everything the mount would do
    sess.ignoreCase = kind === "dir" ? await foldsCaseReadOnly(dir) : true;
    const state = kind === "dir" ? await loadState(dir, root) : {};
    // The scan fails loudly on a mount directory it cannot read, as a real
    // pass must; a directory that is not there yet reads as an empty one.
    const standIn = kind === "missing" ? await mkdtemp(join(tmpdir(), "muhkoo-preview-")) : null;
    let pass;
    try {
        pass = await preparePass({ vfs, dir: standIn ?? dir, rulesDir: dir, root, state, opts, sess, save: false });
    } finally {
        if (standIn) await rm(standIn, { recursive: true, force: true });
    }
    const shown = pass.plan.filter((p) => p.action !== "forget");

    if (!shown.length) return ok(`${root} already matches ${dir} — mounting would change nothing.`);
    // As a pass holds them: while an ignore file from elsewhere cannot be read,
    // its rules may keep some of these files home, so nothing uploads.
    const waiting = unreadRules(pass, state);
    const gated = (action) => (action === "delete-local" || action === "delete-remote") && !opts.allowDelete;
    const held = (action) => waiting.size > 0 && UPLOADS.has(action) && !gated(action);
    info(`Mounting ${root} → ${dir} would:`);
    for (const { path, action } of shown) {
        const note = gated(action) ? " — only with --allow-delete" : held(action) ? " — held until the ignore files below can be read" : "";
        info(`${SIGN[action] ?? "?"} ${path}${DESCRIBE[action] ?? ""}${note}`);
    }
    const goes = (p) => !gated(p.action) && !held(p.action);
    const count = (...actions) => shown.filter((p) => actions.includes(p.action) && goes(p)).length;
    const deletes = shown.filter((p) => p.action.startsWith("delete-") && goes(p)).length;
    const holding = shown.filter((p) => held(p.action)).length;
    info(
        "",
        `${shown.length} change(s): ${count("pull")} to download, ${count("push", "conflict")} to upload` +
            `${deletes ? `, ${deletes} to delete` : ""}${holding ? `, ${holding} held` : ""}. Nothing was changed.`,
    );
    if (holding) {
        const names = [...waiting.keys()].sort();
        info(
            "Nothing uploads until these ignore files from your filesystem can be read, since their rules may keep some of those files home:",
            ...names.slice(0, 5).map((path) => `  ${path}: ${waiting.get(path)}`),
            ...(names.length > 5 ? [`  …and ${names.length - 5} more ignore files`] : []),
        );
    }
    // A pass pulls ignore files first and plans the rest again with them.
    // Their rules can only exclude more, so it can only do less.
    if (shown.some(({ path, action }) => action === "pull" && isIgnoreFile(path.slice(1)))) {
        info("Ignore files come down first and the rest is planned again with them, so the mount may do less than this.");
    }
    return info(`Ignoring per ${describeSource(pass.ignores.source())}.`);
}

/**
 * What is at `dir`, for a mount or its preview: "dir", or "missing" when the
 * mount would create it. Anything the mount could not create or use is refused
 * here, before anything is written — a path under a file, a dangling symlink,
 * a parent that is not there or cannot be searched or written — rather than
 * given a plan ending "Nothing was changed." that the mount then cannot carry
 * out.
 *
 * The mount creates the folder named, never the folders above it. It used to
 * run `mkdir -p`, so a Muhkoo path given as the folder by mistake
 * (`vfs mount /apps/x --path ./`) set about creating /apps at the top of this
 * disk, and a typo deeper down made a tree of empty folders. A missing parent
 * is named instead.
 */
export async function mountTarget(dir) {
    let found;
    try {
        found = await stat(dir);
    } catch (err) {
        if (err.code !== "ENOENT") throw err;   // ENOTDIR, EACCES, ELOOP: the mount fails on these too
        const link = await lstat(dir).catch((e) => {
            if (e.code === "ENOENT") return null;
            throw e;
        });
        if (link) throw new Error(`${dir} is a symbolic link to something that does not exist, so a mount cannot create a directory there.`);
        const up = dirname(resolve(dir));
        let above;
        try {
            above = await stat(up);
        } catch (e) {
            if (e.code !== "ENOENT") throw e;
            throw new Error(
                `${dir} cannot be created: ${up} does not exist on this computer. ` +
                "The mount creates the folder you name, but not the folders above it.",
            );
        }
        if (!above.isDirectory()) throw new Error(`${dir} cannot be created: ${up} is not a directory.`);
        try {
            await access(up, fsConstants.W_OK | fsConstants.X_OK);
        } catch {
            throw new Error(`${dir} does not exist, and cannot be created: ${up} is not writable.`);
        }
        return "missing";
    }
    if (!found.isDirectory()) throw new Error(`${dir} is not a directory.`);
    return "dir";
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

/**
 * Dry-run symbols. The arrow says which side a change lands on — ↑ your
 * filesystem, ↓ this disk — including for deletes, which used to share one ✕
 * so a dry run could not tell "delete in the VFS" from "delete on my disk".
 */
export const SIGN = {
    push: "↑", pull: "↓", conflict: "!",
    "delete-remote": "✕↑", "delete-local": "✕↓", forget: "·", skip: "–",
};

const DESCRIBE = {
    conflict: " (changed on both sides — your copy replaces the other, which stays in `vfs history`)",
    "delete-remote": " (delete from your filesystem)",
    "delete-local": " (delete from this disk)",
};

function describeSource(source) {
    if (source === "defaults") return "the built-in Node defaults (write a .vcsignore to change them)";
    if (source === ".gitignore") {
        return "your .gitignore files and .git/info/exclude, as git reads them (`muhkoo vfs ignore --write` drafts a .vcsignore from them all, to diverge)";
    }
    return source;
}

function human(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---- mount ------------------------------------------------------------------------

/**
 * Refuse to sync the filesystem root, the home directory, or anything that
 * contains the home directory.
 *
 * A home directory is not a project. Every non-hidden file in it — Documents,
 * Desktop, Downloads — would upload, and a remote `Library/LaunchAgents/x.plist`
 * would land where launchd loads it at the next login, with no flag needed.
 * Mounting a project directory instead makes the same remote file inert. There
 * is no override: nothing a project needs is only reachable this way.
 */
export async function assertMountable(dir) {
    const real = await realpath(dir);
    const home = await realpath(homedir()).catch(() => resolve(homedir()));
    if (real === parse(real).root) {
        throw new Error(`refusing to sync ${dir}: it is the filesystem root, which contains your home directory. Point this at a project directory.`);
    }
    const rel = relative(real, home);
    if (rel === "" || !(rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) || (await isHomeOrAbove(real, home))) {
        throw new Error(
            `refusing to sync ${dir}: it is your home directory, or contains it. Everything in it would upload, ` +
            `and a remote file could land anywhere in it. Point this at a project directory.`,
        );
    }
}

/**
 * Does `real` hold the home directory — is it home, or above it — compared as
 * DIRECTORIES, by device and inode, rather than as spellings?
 *
 * realpath resolves symlinks but not macOS firmlinks: `/System/Volumes/Data`
 * holds `/Users/<you>` under a spelling no string comparison recognises, and
 * it is not above it by inode either, since `/` is a separate system volume.
 * So ask the directory itself: for each directory above home, does `real`
 * reach home by the same remaining path? Inodes are read as bigints, which is
 * exact everywhere; a filesystem that reports none is left to the string
 * check above.
 */
async function isHomeOrAbove(real, home) {
    const target = await lstat(home, { bigint: true }).catch(() => null);
    if (!target?.ino) return false;
    for (let above = home; ; above = dirname(above)) {
        const s = await lstat(join(real, relative(above, home)), { bigint: true }).catch(() => null);
        if (s && s.dev === target.dev && s.ino === target.ino) return true;
        if (dirname(above) === above) return false;
    }
}

/**
 * Mount `root` at `dir` and keep them in step until `signal` aborts.
 *
 * Stopping is prompt and clean. `signal` stops a pass between steps — the
 * first pass included, which used to ignore Ctrl-C altogether and left kill
 * as the only way out — and `mount` does not return while a pass is still
 * writing, since the CLI exits the moment it does.
 */
export async function mount({ client, dir, root, signal, opts = {}, session: s }) {
    const vfs = client.vfs;
    // The folder named, never the folders above it (see `mountTarget`).
    if ((await mountTarget(dir)) === "missing") {
        await mkdir(dir).catch((err) => {
            if (err.code !== "EEXIST") throw err;   // made meanwhile: assertMountable looks at what is there
        });
    }
    await assertMountable(dir);

    const sess = session(s);
    let state = await loadState(dir, root);
    info(`Mounting ${root} → ${dir}`);
    // Deliberately not caught: a mount that cannot complete its first pass —
    // the vault locked, the root unreadable — must fail the command, not sit
    // "watching" something broken.
    state = await reconcile({ vfs, dir, root, state, opts, session: sess, signal });
    if (signal.aborted) return;   // what the pass did is saved; nothing is watching yet
    // Not "in sync" when it is not: a fresh mount on a laptop short of its
    // disk reserve pulled nothing, and said it was.
    const behind = undone(sess.outstanding);
    if (behind) warn(`Not in sync yet: ${behind}.`, "  Watching for changes — press Ctrl-C to stop.");
    else ok("In sync. Watching for changes — press Ctrl-C to stop.");

    // One reconcile at a time, with a trailing pass if anything arrived while we
    // were busy. Without the trailing pass a change landing mid-sync would wait
    // for the NEXT unrelated event to be noticed.
    let running = null;
    let queued = false;
    let timer = null;
    const sync = () => {
        if (signal.aborted) return;
        if (running) {
            queued = true;
            return;
        }
        running = reconcile({ vfs, dir, root, state, opts, session: sess, signal })
            .then((next) => {
                state = next;
            }, (err) => warn(`sync failed: ${err?.message ?? err}`))
            .finally(() => {
                running = null;
                // A pass that stopped at its pull budget goes straight on.
                if (sess.more) {
                    sess.more = false;
                    queued = true;
                }
                if (queued) {
                    queued = false;
                    sync();
                }
            });
    };
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(sync, SETTLE_MS);
    };

    /**
     * Would a change at `filename` matter? The same admission rule the scans
     * use, from the last pass — not a separate hard-coded list, which dropped
     * edits under any directory named vendor/, target/ or build/ even where
     * the project syncs it. `.muhkoo` is dropped: a pass writes its state
     * there, and waking for that write is how one pass scheduled the next,
     * forever. Except the ignore rules, which `vfs ignore --accept` writes:
     * the files it lets through have not changed, so nothing else would wake
     * the mount to send them. A pass writes that file only when the ignore
     * files change, so the pass it wakes writes nothing and it settles.
     */
    const matters = (filename) => {
        const rel = filename.split(sep).join("/");
        if (rel === ".muhkoo/ignore-rules.json") return true;
        if (rel === ".muhkoo" || rel.startsWith(".muhkoo/")) return false;
        if (rel.split("/").pop().startsWith(TMP_PREFIX)) return false;
        if (rel === ".git/info/exclude") return true;   // refused, but its rules apply
        return !sess.admit || sess.admit(rel, false) === null;
    };

    const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        // `filename` can be null on some platforms; a bare reconcile is correct
        // either way, so this never has to trust it.
        if (filename && !matters(filename)) return;
        schedule();
    });

    const unwatchRemote = vfs.watch(() => schedule());
    if (sess.more) {
        sess.more = false;
        sync();
    }

    await new Promise((resolve) => {
        // An already-aborted signal never fires "abort" again.
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
    });

    clearTimeout(timer);
    watcher.close();
    unwatchRemote();
    // A pass under way stops at its next step and saves what it did. Wait for
    // it: returning now let the CLI exit in the middle of a write.
    while (running) await running;
    await saveState(dir, root, state);
}
