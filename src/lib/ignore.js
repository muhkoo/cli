/**
 * `.vcsignore` — what not to sync.
 *
 * Same syntax as `.gitignore`, because that is the file everyone already knows
 * how to write and every project already has one to crib from. A separate file
 * rather than reading `.gitignore` directly: the two answer different questions.
 * Git ignores build output because it is derivable; the filesystem also wants to
 * skip things that ARE committed but are pointless to sync — lockfiles you never
 * open, fixtures measured in megabytes.
 *
 * `.gitignore` is still used as a fallback when no `.vcsignore` exists, so a
 * project that has not opted in gets sensible behaviour on day one — and then
 * the way git reads it: nested `.gitignore` files scoped to their directories,
 * and `.git/info/exclude`. Stopping at the root file uploaded what a monorepo
 * package's own `.gitignore` kept out.
 *
 * The matcher is hand-written rather than generated RegExps. These files travel
 * with the project, so anyone able to write the filesystem can write a pattern
 * here, and a generated `.*a.*a.*a…` backtracked for longer than anyone would
 * wait — synchronously, so not even Ctrl-C got through.
 */

import { warn } from "./ui.js";

/** What a Node project almost always wants ignored. */
export const NODE_DEFAULTS = `# Dependencies and build output — reinstallable, and large.
node_modules/
dist/
build/
out/
coverage/
.next/
.nuxt/
.svelte-kit/
.turbo/
.parcel-cache/
.vite/
*.tsbuildinfo

# Logs and local state
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.DS_Store
.muhkoo/

# Secrets. These should never leave the machine by accident.
.env
.env.*
!.env.example
`;

/**
 * Code points a filesystem may drop when it compares names.
 *
 * HFS+ ignores the zero-width joiners and direction marks outright, so
 * `node\u200c_modules` opens `node_modules`. Only used when matching on a volume
 * that folds names; a written name is never altered.
 */
export const IGNORABLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/**
 * A string as a volume that folds names would compare it.
 *
 * APFS folds case the FULL Unicode way, not one character at a time: `ſ` is
 * `s`, `ß` is `ss`, the `ﬁ` and `ﬆ` ligatures are `fi` and `st`. A per-character
 * `toLowerCase` missed all of them, so a remote `config/maſter.key` passed a
 * `config/master.key` rule, was pulled, and the developer's later write of the
 * real key opened the planted entry and uploaded. `toUpperCase` is what expands
 * `ß` to `SS` (lower case first, so capital `ẞ` gets there too); NFKC takes
 * the compatibility forms. This folds further than any
 * one filesystem does, which is safe here: over-folding only ever excludes and
 * refuses more. For comparing only — a written name is never altered.
 */
export function caseFold(s) {
    return String(s)
        .replace(IGNORABLE, "")
        .normalize("NFKC")
        .toLowerCase()
        .toUpperCase()
        .toLowerCase()
        .normalize("NFKC")
        .replace(IGNORABLE, "");
}

/**
 * Text as this volume compares names: fully folded when it folds case, and
 * NFC regardless — a case-SENSITIVE APFS volume is still insensitive to
 * normalization, so `café` and `cafe\u0301` are one entry there too.
 */
function fold(s, ignoreCase) {
    return ignoreCase ? caseFold(s) : String(s).normalize("NFC");
}

const GLOBSTAR = "**";
/** Exactly one segment, whatever it is: a trailing `**` has to consume one. */
const ANYSEG = "*/";
const STAR = 1, ANY = 2, LIT = 3, CLASS = 4;

/**
 * Compile ignore rules into a matcher.
 *
 * Returns `(path, isDir) => boolean`, where `path` is slash-separated and
 * relative to the directory the ignore file sits in, with no leading slash.
 *
 * Last match wins, which is what makes `!` negation work: `*.log` followed by
 * `!keep.log` keeps that one file. And, as in git, a path under an excluded
 * directory is excluded whatever a later rule says (see `underExcluded`).
 *
 * Options: `ignoreCase` folds case and Unicode normalization, for a volume
 * that does (git's `core.ignorecase`); `onBadLine(line, reason)` hears about a
 * line that could not be read, which is skipped rather than fatal.
 */
export function compileIgnores(text, opts = {}) {
    const rules = parseRules(text, opts);
    return (path, isDir = false) => {
        const subj = subject(String(path).split("/").filter(Boolean), opts.ignoreCase, opts.budget ?? Infinity);
        const at = (k, dir) => lastMatch(rules, subj, 0, k, dir) === IGNORED;
        return underExcluded(subj.raw.length, at) || at(subj.raw.length, isDir);
    };
}

/**
 * Is any directory above a path of `n` segments excluded? `at(k, true)` is
 * the verdict for the directory made of the first k segments, on its own.
 *
 * Git never looks inside an excluded directory, so nothing beneath one can be
 * re-included — and, just as much, a negation that matches a directory keeps
 * the DIRECTORY, not everything in it. Testing every rule against every
 * prefix of the path, as the first rewrite did, let `!keys/` override
 * `*.pem` for `keys/server.pem`, and the whitelist idiom (`*`, then `!` for
 * every directory, then `!*.js`) upload every file under a re-included one. Each directory is decided
 * by the rules that match IT; the path by the rules that match it.
 */
function underExcluded(n, at) {
    for (let k = 1; k < n; k++) if (at(k, true)) return true;
    return false;
}

/**
 * Parse every line on its own.
 *
 * One line that cannot be read is skipped with a warning. Compiling the whole
 * file in one go meant a single `[z-a]` threw, and the caller read the throw as
 * "no file here" — every rule in it silently gone, and files it was written to
 * keep home uploaded. Git's own matcher treats a bad range as matching nothing,
 * which is what skipping the line amounts to.
 */
function parseRules(text, { ignoreCase = false, onBadLine, file } = {}) {
    const rules = [];
    for (const line of ruleLines(text)) {
        try {
            const rule = parseRule(line, ignoreCase);
            if (rule) rules.push(rule);
        } catch (err) {
            if (onBadLine) onBadLine(line, err.message, file);
            else warn(`ignoring "${line}" in ${file ?? "an ignore file"}: ${err.message}`);
        }
    }
    return rules;
}

/**
 * The lines of an ignore file that are rules, read as git reads them: a
 * leading space is part of the pattern, and trailing spaces are dropped
 * unless a backslash escapes them (`foo\ ` is "foo "). Trimming both ends
 * made ` !server.pem` — a literal pattern to git — a negation here.
 *
 * A byte-order mark at the very start is skipped, as git skips it: Windows
 * editors save one, and it became part of the first pattern — which, on a
 * volume that does not fold case, then matched nothing.
 */
function ruleLines(text) {
    const out = [];
    for (const raw of String(text ?? "").replace(/^\ufeff/, "").split(/\r?\n/)) {
        const line = trimTrailingSpaces(raw);
        if (line && !line.startsWith("#")) out.push(line);
    }
    return out;
}

/**
 * An ignore file's rules and nothing else, one per line — what it MEANS, so
 * two files that differ only in comments, blank lines or line endings come
 * out the same. Read back, it gives exactly the rules the file did.
 */
export function ruleText(text) {
    return ruleLines(text).join("\n");
}

/** git's trim_trailing_spaces: a backslash protects the character after it. */
function trimTrailingSpaces(line) {
    let cut = -1;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === " ") {
            if (cut === -1) cut = i;
        } else {
            if (line[i] === "\\") {
                i++;
                if (i >= line.length) return line;
            }
            cut = -1;
        }
    }
    return cut === -1 ? line : line.slice(0, cut);
}

/**
 * The most wildcards one rule may hold — `*`, `?`, `[...]` and `**` segments,
 * a run of stars counting once. Real rules have a handful: the densest lines
 * in GitHub's templates spell a name case-insensitively a character at a time
 * (`[Tt][Hh][Uu][Mm][Bb][Ss].[Dd][Bb]`, eight), and 32 is four times that.
 * Each one is a place the matcher may have to try more than one way, so a
 * line past it is skipped with a warning, wherever the file came from.
 */
export const MAX_WILDCARDS = 32;

function parseRule(line, ignoreCase) {
    let pattern = line;
    let negated = false;
    if (pattern.startsWith("!")) {
        negated = true;
        pattern = pattern.slice(1);
    }

    let dirOnly = false;
    if (pattern.endsWith("/")) {
        dirOnly = true;
        pattern = pattern.slice(0, -1);
    }
    if (!pattern) return null;

    // A pattern with a slash anywhere but the end is anchored to the root;
    // a bare name matches at any depth. This is the rule that makes
    // `node_modules/` catch nested copies while `/dist` catches only the
    // top-level one.
    const anchored = pattern.includes("/");

    // `**` is special only as a WHOLE segment (`**/x`, `x/**/y`, `x/**`).
    // Anywhere else consecutive stars are an ordinary `*`, which is what git
    // does — and what keeps `**a**a**a` from meaning "cross every separator".
    // A run of `**` segments is one: the same pattern, and it keeps the work
    // bounded by the PATH however many a planted line repeats.
    //
    // git reads any whole segment of two or more stars as `**`, so `***/x`
    // matches x at every depth, as it does there.
    const segs = [];
    let wildcards = 0;
    for (const part of pattern.split("/").filter(Boolean)) {
        if (!/^\*{2,}$/.test(part)) {
            const tokens = tokenize(part, ignoreCase);
            wildcards += tokens.wildcards;
            segs.push(tokens);
        } else if (segs.at(-1) !== GLOBSTAR) {
            segs.push(GLOBSTAR);
            wildcards++;
        }
    }
    if (wildcards > MAX_WILDCARDS) throw new Error(`it has ${wildcards} wildcards, and a rule may have at most ${MAX_WILDCARDS}`);
    if (!segs.length) return null;
    // An unanchored pattern may start at any segment boundary, which is how
    // `*.log` matches `src/deep/thing.log`.
    if (!anchored && segs[0] !== GLOBSTAR) segs.unshift(GLOBSTAR);
    // `x/**` is everything INSIDE x, not x: a trailing `**` takes at least one.
    if (segs.at(-1) === GLOBSTAR) segs.splice(-1, 1, ANYSEG, GLOBSTAR);
    // The common case — `*.log`, `node_modules/`, `.env` — is "the last
    // segment matches", and needs no walk over the path at all.
    const base = segs.length === 2 && segs[0] === GLOBSTAR && Array.isArray(segs[1]) ? segs[1] : null;
    return { segs, base, negated, dirOnly };
}

/**
 * One segment of a pattern → tokens. `*`, `?`, `[...]` and `\x` escapes.
 *
 * Syntax is read from the pattern as written; only the LITERAL runs between
 * it are folded, so a fullwidth `＊` folds to a literal asterisk rather than
 * becoming a wildcard, and `ß` folds to two literal characters.
 */
function tokenize(part, ignoreCase) {
    const chars = Array.from(part);
    const out = [];
    let run = "";
    const flush = () => {
        for (const c of Array.from(fold(run, ignoreCase))) out.push({ t: LIT, c });
        run = "";
    };
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === "\\" && i + 1 < chars.length) {
            run += chars[++i];
        } else if (ch === "[") {
            const cls = parseClass(chars, i, ignoreCase);
            if (!cls) {
                run += ch;   // unterminated: a literal bracket
                continue;
            }
            flush();
            out.push(cls.token);
            i = cls.end;
        } else if (ch === "*") {
            flush();
            if (out.at(-1)?.t !== STAR) out.push({ t: STAR });   // a run of stars is one star
        } else if (ch === "?") {
            flush();
            out.push({ t: ANY });
        } else run += ch;
    }
    flush();
    // Shortcuts for the shapes nearly every rule has: all literal (`.env`),
    // or one star and a literal suffix or prefix (`*.log`, `npm-debug.log*`).
    const lits = (a) => (a.every((t) => t.t === LIT) ? a.map((t) => t.c).join("") : undefined);
    out.lit = lits(out);
    if (out.length > 1 && out[0].t === STAR) out.suffix = lits(out.slice(1));
    if (out.length > 1 && out.at(-1).t === STAR) out.prefix = lits(out.slice(0, -1));
    // Everything else, as the runs between stars: the one before the first
    // star must start the name and the one after the last must end it, so
    // only the runs in between are ever searched for.
    const runs = [[]];
    for (const tok of out) {
        if (tok.t === STAR) runs.push([]);
        else runs.at(-1).push(tok);
    }
    out.star = runs.length > 1;
    out.head = runs[0];
    out.tail = out.star ? runs.at(-1) : [];
    out.mids = out.star ? runs.slice(1, -1).filter((run) => run.length) : [];
    out.min = runs.reduce((n, run) => n + run.length, 0);
    out.wildcards = out.filter((tok) => tok.t !== LIT).length;
    // What matching it against one name costs (see `matchSegment`): the
    // shortcuts their length; otherwise the runs compared in place, and the
    // searched runs tried at each place in the name. Each search starts where
    // the last one ended, so between them they try each place about once:
    // (name + runs) tries, none dearer than the dearest run.
    const shortcut = out.lit ?? out.suffix ?? out.prefix;
    out.fixed = shortcut !== undefined ? Math.max(1, shortcut.length) : Math.max(1, runWork(out.head) + runWork(out.tail));
    out.searched = shortcut !== undefined ? 0 : out.mids.reduce((most, run) => Math.max(most, runWork(run)), 0);
    // Worth remembering, within one path, where a `**` makes it be tried
    // more than once at the same place.
    out.heavy = out.searched > 0 || out.fixed > 16;
    out.uid = ++segmentIds;
    return out;
}
let segmentIds = 0;

/**
 * What one token costs to test against one character: one comparison, or for
 * a class each of its members (a `[:name:]` is a RegExp test, weighed as
 * POSIX_COST) — twice over on a volume that folds case, after upper-casing
 * the character, which is dearer than the tests (FOLD_COST).
 */
const POSIX_COST = 8;
const FOLD_COST = 8;
function tokenWork(tok) {
    if (tok.t !== CLASS) return 1;
    const members = tok.items.reduce((n, item) => n + (item.cls ? POSIX_COST : 1), 0);
    return tok.fold ? 2 * members + FOLD_COST : members + 1;
}
const runWork = (run) => run.reduce((n, tok) => n + tokenWork(tok), 0);

/**
 * The POSIX classes, in a Map: as an object literal, `[[:constructor:]]` and
 * every other inherited name passed the "is this a class" check, compiled,
 * and then threw on every match — outside the per-line skip, so one planted
 * line failed every later pass.
 */
const POSIX_CLASSES = new Map(Object.entries({
    alnum: /[\p{L}\p{N}]/u, alpha: /\p{L}/u, blank: /[ \t]/, cntrl: /\p{Cc}/u, digit: /[0-9]/,
    graph: /[^\s\p{Cc}]/u, lower: /\p{Ll}/u, print: /[^\p{Cc}]/u, punct: /[\p{P}\p{S}]/u,
    space: /\s/, upper: /\p{Lu}/u, xdigit: /[0-9a-fA-F]/,
}));

/**
 * The most members one `[...]` may list — a range or a `[:name:]` counting
 * once. Every character a class meets is tested against each of them, so a
 * planted class of 250,000 cost half a second a name while the rule counted
 * as three wildcards. Real classes list a case pair, a digit range or a few
 * separators (`[Tt]`, `[0-9]`, `[._-]`); 64 is far past any of them, and a
 * line over it is skipped with a warning.
 */
export const MAX_CLASS_ITEMS = 64;

/**
 * `[...]` starting at `start`, or null when it never closes. Throws on a bad
 * range. `fold` is whether the subject it meets is case-folded: only then may
 * `[A-Z]` match the folded `a` — on a case-sensitive volume it must not.
 */
function parseClass(chars, start, fold) {
    let i = start + 1;
    let neg = false;
    if (chars[i] === "!" || chars[i] === "^") {
        neg = true;
        i++;
    }
    const items = [];
    for (let first = true; i < chars.length; i++, first = false) {
        let c = chars[i];
        // `]` straight after the opening is a member, not the close.
        if (c === "]" && !first) return { token: { t: CLASS, neg, items, fold: Boolean(fold) }, end: i };
        if (items.length === MAX_CLASS_ITEMS) throw new Error(`a character class may list at most ${MAX_CLASS_ITEMS} members`);
        if (c === "[" && chars[i + 1] === ":") {
            const close = chars.indexOf(":", i + 2);
            if (close !== -1 && chars[close + 1] === "]") {
                const name = chars.slice(i + 2, close).join("");
                const cls = POSIX_CLASSES.get(name);
                if (!cls) throw new Error(`[:${name}:] is not a character class`);
                items.push({ cls });
                i = close + 1;
                continue;
            }
        }
        if (c === "\\" && i + 1 < chars.length) c = chars[++i];
        if (chars[i + 1] === "-" && i + 2 < chars.length && chars[i + 2] !== "]") {
            let hi = chars[i + 2];
            i += 2;
            if (hi === "\\" && i + 1 < chars.length) hi = chars[++i];
            if (c.codePointAt(0) > hi.codePointAt(0)) throw new Error(`the range ${c}-${hi} is backwards`);
            items.push({ lo: c.codePointAt(0), hi: hi.codePointAt(0) });
        } else {
            items.push({ lo: c.codePointAt(0), hi: c.codePointAt(0) });
        }
    }
    return null;
}

function matchOne(tok, c) {
    if (tok.t === ANY) return true;
    if (tok.t === LIT) return tok.c === c;
    // A folded subject is already lower case, and the class may name either
    // case. Unfolded, a character is exactly itself.
    let hit = inClass(tok.items, c);
    if (!hit && tok.fold) {
        const upper = c.toUpperCase();
        if (upper !== c) hit = inClass(tok.items, upper);
    }
    return tok.neg ? !hit : hit;
}

/** Is `x` a member? A plain loop: this runs for every character a class meets. */
function inClass(items, x) {
    const cp = x.codePointAt(0);
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.cls ? item.cls.test(x) : cp >= item.lo && cp <= item.hi) return true;
    }
    return false;
}

/**
 * One pattern segment against path segment `i` of a prepared subject.
 *
 * The run before the first star has to start the name and the run after the
 * last star has to end it, so both are compared in place; only the runs
 * between two stars are searched for, each at its leftmost place after the
 * one before (which is enough, since a star takes anything). A segment with
 * no star, or one, is therefore compared, never searched: the old greedy walk
 * searched for the tail too, and `*?aaaa…ab3` cost the length of the name
 * times the length of the rule, 10,000 times over, for every path.
 */
function matchSegment(tokens, subj, i) {
    const str = (subj.strs[i] ??= fold(subj.raw[i], subj.ignoreCase));
    if (tokens.searched === 0) charge(subj, tokens.fixed);
    if (tokens.lit !== undefined) return tokens.lit === str;
    if (tokens.suffix !== undefined) return str.endsWith(tokens.suffix);
    if (tokens.prefix !== undefined) return str.startsWith(tokens.prefix);
    const chars = (subj.chars[i] ??= Array.from(str));
    const n = chars.length;
    if (tokens.searched) charge(subj, tokens.fixed + (n + tokens.mids.length) * tokens.searched);
    if (!tokens.star) return n === tokens.min && matchAt(tokens.head, chars, 0);
    if (n < tokens.min) return false;
    const end = n - tokens.tail.length;
    if (!matchEnd(tokens.tail, chars, end) || !matchAt(tokens.head, chars, 0)) return false;
    let at = tokens.head.length;
    for (const run of tokens.mids) {
        at = find(run, chars, at, end);
        if (at === -1) return false;
    }
    return true;
}

/** `run` at `at`, front to back. */
function matchAt(run, chars, at) {
    for (let k = 0; k < run.length; k++) if (!matchOne(run[k], chars[at + k])) return false;
    return true;
}

/** `run` at `at`, back to front: names mostly differ at the end. */
function matchEnd(run, chars, at) {
    for (let k = run.length - 1; k >= 0; k--) if (!matchOne(run[k], chars[at + k])) return false;
    return true;
}

/** The leftmost place for `run` in chars[from, to): the index just past it, or -1. */
function find(run, chars, from, to) {
    for (let at = from; at + run.length <= to; at++) if (matchAt(run, chars, at)) return at + run.length;
    return -1;
}

/**
 * The most matching one path may cost, in the units `tokenWork` counts —
 * roughly one character comparison each.
 *
 * Counted as the matching happens: every rule considered, every segment
 * compared (the shortcuts by their length, a searched run by the length of
 * the name it is searched in), every step of a `**` walk. A path that would
 * take more is not decided at all — `IgnoreBudgetError` — and the mount
 * leaves it alone, as it does one it cannot read: neither synced nor deleted.
 *
 * This replaces working out the worst case from the rules in advance and
 * refusing files and sets of rules over a limit. That bound was only as good
 * as its model, and each round found a shape it priced wrong — a class of
 * 250,000 members, a path 61 deep, a draft's `web/**` rule at 17 million —
 * while its caps were something the remote party could fill. A count kept
 * while matching needs no worst case worked out in advance, and nothing but
 * the path in hand spends it. Ordinary paths against GitHub's Node,
 * VisualStudio and TeX templates cost 3,000 to 25,000; the budget is what a
 * path 64 deep of 255-character names against a full file of hostile rules
 * spends in about ten milliseconds (M4 Max), so a scan still yields within
 * its slice.
 */
export const PATH_BUDGET = 4_000_000;

export class IgnoreBudgetError extends Error {
    constructor() {
        super("matching this path against the ignore rules would take too long");
        this.name = "IgnoreBudgetError";
    }
}
const OVER = new IgnoreBudgetError();

/** Spend `n` of the subject's budget, or stop. */
function charge(subj, n) {
    if ((subj.spent += n) > subj.budget) throw OVER;
}

/**
 * The deepest path, and the longest name, that paths from elsewhere may have
 * before they are matched at all (see `withinMatchBounds`).
 */
export const NAME_MAX = 255;
export const DEPTH_MAX = 64;

/**
 * Is `rel` inside the bounds a path from elsewhere is held to before it is
 * matched — at most DEPTH_MAX segments, none longer than NAME_MAX characters
 * once folded as this volume compares names? Setting a path up to be matched
 * costs its depth squared before any rule runs, so that part is bounded
 * here rather than by the budget. The filesystem refuses deeper paths and
 * longer names today; this keeps it from depending on that. Folding can
 * lengthen a name (`ß` is two characters, U+FDFA eighteen), so the folded
 * length is what counts.
 */
export function withinMatchBounds(rel, ignoreCase = false) {
    const segs = String(rel).split("/").filter(Boolean);
    return segs.length <= DEPTH_MAX && segs.every((seg) => Array.from(fold(seg, ignoreCase)).length <= NAME_MAX);
}

/**
 * Pattern segments against path segments [from, to), all of them.
 *
 * The same greedy walk as `matchSegment`, one level up: `**` is the star, and
 * every other pattern segment consumes exactly one path segment. Iterative:
 * the first rewrite recursed once per `**`, and one planted line of 20,000 of
 * them overflowed the stack on every pass after. O(path × pattern) steps in
 * the worst case.
 *
 * After a `**`, a segment may be tried at one place many times — once for
 * every directory above the path that is asked about — so a costly one is
 * remembered for the path (`seenSegment`). Tried afresh, the `report.[0-9]*…`
 * line of GitHub's Node template, drafted under `web/**`, cost 17 million a
 * path 61 deep.
 */
function matchPath(pat, subj, from, to) {
    let si = 0;
    let pi = from;
    let starSi = -1;
    let starPi = 0;
    let steps = 0;
    while (pi < to) {
        steps++;
        const p = pat[si];
        if (p === GLOBSTAR) {
            starSi = si++;
            starPi = pi;
        } else if (p !== undefined && (p === ANYSEG || (starSi >= 0 && p.heavy ? seenSegment(p, subj, pi) : matchSegment(p, subj, pi)))) {
            si++;
            pi++;
        } else if (starSi >= 0) {
            si = starSi + 1;
            pi = ++starPi;
        } else break;
    }
    charge(subj, steps);
    if (pi < to) return false;
    while (pat[si] === GLOBSTAR) si++;
    return si === pat.length;
}

/** `matchSegment`, remembered for the path in hand. */
function seenSegment(tokens, subj, i) {
    const seen = (subj.segments ??= new Map());
    const key = tokens.uid * 65536 + i;
    let hit = seen.get(key);
    if (hit === undefined) seen.set(key, (hit = matchSegment(tokens, subj, i)));
    else charge(subj, 4);
    return hit;
}

/**
 * A path, prepared once for every rule and every set of rules asked about
 * it: its segments folded as this volume compares names, their characters
 * split lazily, `budget` for what matching it may cost (`PATH_BUDGET`), and
 * what has been worked out about it so far.
 */
function subject(raw, ignoreCase, budget) {
    return { raw, ignoreCase, strs: [], chars: [], spent: 0, budget, verdicts: null, segments: null, _prefixes: null };
}

/** The first k segments of the subject's path, as written, for each k. */
function prefixesOf(subj) {
    if (!subj._prefixes) {
        const p = [""];
        for (let i = 1; i <= subj.raw.length; i++) p[i] = i === 1 ? subj.raw[0] : `${p[i - 1]}/${subj.raw[i - 1]}`;
        subj._prefixes = p;
    }
    return subj._prefixes;
}

/** A file's verdict on a span of a path: no rule matched it, the last one to excluded it, or kept it. */
const NONE = 0, IGNORED = 1, KEPT = 2;

/**
 * The verdict of `rules` on segments [from, to) of a prepared path — that
 * span, as a whole, and nothing above or below it. Last match wins, so they
 * are read from the end, and the first to match decides.
 */
function lastMatch(rules, subj, from, to, isDir) {
    if (to <= from) return NONE;
    for (let i = rules.length - 1; i >= 0; i--) {
        const rule = rules[i];
        if (rule.dirOnly && !isDir) continue;
        charge(subj, 1);
        const hit = rule.base ? matchSegment(rule.base, subj, to - 1) : matchPath(rule.segs, subj, from, to);
        if (hit) return rule.negated ? KEPT : IGNORED;
    }
    return NONE;
}

const defaultRules = new Map();   // ignoreCase → parsed NODE_DEFAULTS
function defaultsFor(ignoreCase) {
    const key = Boolean(ignoreCase);
    if (!defaultRules.has(key)) defaultRules.set(key, parseRules(NODE_DEFAULTS, { ignoreCase: key }));
    return defaultRules.get(key);
}

/** The files that govern every path, whatever its directory. */
const EXCLUDE_FILE = ".git/info/exclude";

/**
 * Compiled ignore files, shared.
 *
 * A VERSION is one file as it stood — its path and its rules (`ruleText`) —
 * compiled once, however many sets of rules hold it. A VIEW is one set of
 * rules: which version of each file (`view`). What a version says about a
 * span of a path is worked out once per path, and every view holding that
 * version reads the same answer (`verdictOf`) — so the mount's ignore
 * ratchet, which asks every set of rules a directory has used, pays for a
 * file they share once, not once for each of them.
 *
 * Options: `ignoreCase`, `onBadLine` as for `compileIgnores`, and `budget`
 * (default PATH_BUDGET) for what one path may cost.
 */
export function ruleBank(opts = {}) {
    const ignoreCase = Boolean(opts.ignoreCase);
    const budget = opts.budget ?? PATH_BUDGET;
    const versions = new Map();   // path + NUL + rules → version
    let ids = 0;
    const make = (file, text, rules) => ({
        id: ++ids,
        file,
        text,
        from: file.endsWith("/.gitignore") ? file.split("/").length - 1 : 0,
        rules,
        // For telling two views apart at a glance (see `view`).
        sig: (Math.random() * 0x40000000) | 0,
    });
    const bank = {
        ignoreCase,
        defaults: make("", NODE_DEFAULTS, defaultsFor(ignoreCase)),
        /** The version of `file` whose rules are `text` (as `ruleText` gives them). */
        version(file, text) {
            const key = `${file}\0${text}`;
            let v = versions.get(key);
            if (!v) versions.set(key, (v = make(file, text, parseRules(text, { ...opts, file }))));
            return v;
        },
        /** `path` prepared for matching (see `subject`). */
        subject(path) {
            return subject(String(path).split("/").filter(Boolean), ignoreCase, budget);
        },
        /** A set of rules over these versions; `files` maps each file to its version. */
        view(files) {
            return view(bank, files);
        },
    };
    return bank;
}

/**
 * What `v` says about segments [0, k) of the subject's path: NONE, IGNORED
 * or KEPT. Worked out once per path, whichever view asks.
 */
function verdictOf(v, subj, k, isDir) {
    if (k <= v.from) return NONE;   // a nested file speaks only for what is inside its directory
    const key = v.id * 131072 + k * 2 + (isDir ? 1 : 0);
    const known = (subj.verdicts ??= new Map());
    let t = known.get(key);
    if (t === undefined) known.set(key, (t = lastMatch(v.rules, subj, v.from, k, isDir)));
    else charge(subj, 1);
    return t;
}

/**
 * One set of rules for a directory tree: a version of each ignore file there.
 *
 * `.vcsignore` wins outright when present — a project that wrote one meant it
 * — and is read alone on top of the Node defaults. Otherwise this follows git:
 * the defaults, then `.git/info/exclude`, then every `.gitignore` from the
 * root down to the path's own directory, each scoped to the directory it sits
 * in. Last match wins across the lot, which gives git's precedence: a deeper
 * file overrides a shallower one, and any `.gitignore` overrides the exclude
 * file.
 *
 * A view may change while it is in use — the scan finds nested files on the
 * way down, and registers a directory's before anything in it is matched —
 * and each change drops the directory verdicts it has cached, which every
 * path beneath a directory would otherwise ask for again. `sig` is the XOR
 * of its versions' — equal for equal views, and nearly never otherwise.
 */
function view(bank, init) {
    const files = new Map();    // file → version
    const nested = new Map();   // directory → the version of its .gitignore
    let vcs = null;
    let exclude = null;
    let root = null;
    let dirs = new Map();       // directory → verdict, while the files are unchanged
    let sig = 0;
    let changes = 0;

    // The first k segments of a path, on their own.
    const own = (subj, k, isDir) => {
        let v = verdictOf(bank.defaults, subj, k, isDir) === IGNORED;
        if (vcs) {
            const t = verdictOf(vcs, subj, k, isDir);
            return t ? t === IGNORED : v;
        }
        for (const version of [exclude, root]) {
            if (!version) continue;
            const t = verdictOf(version, subj, k, isDir);
            if (t) v = t === IGNORED;
        }
        // Nested files, shallowest first — and only files ABOVE this prefix:
        // `a/.gitignore` speaks for what is inside `a`, not for `a`.
        if (nested.size) {
            const prefixes = prefixesOf(subj);
            charge(subj, k);
            for (let i = 1; i < k; i++) {
                const version = nested.get(prefixes[i]);
                if (!version) continue;
                const t = verdictOf(version, subj, k, isDir);
                if (t) v = t === IGNORED;
            }
        }
        return v;
    };

    const self = {
        files,
        get sig() {
            return sig;
        },
        /** How many times the files have changed: for caching what depends on them. */
        get changes() {
            return changes;
        },
        get source() {
            return vcs ? ".vcsignore" : root ? ".gitignore" : "defaults";
        },
        /** Make `version` (null: none) the one `file` holds. */
        put(file, version) {
            const before = files.get(file) ?? null;
            if (before === version) return;
            if (before) sig ^= before.sig;
            if (version) {
                files.set(file, version);
                sig ^= version.sig;
            } else files.delete(file);
            if (file === ".vcsignore") vcs = version;
            else if (file === ".gitignore") root = version;
            else if (file === EXCLUDE_FILE) exclude = version;
            else if (version) nested.set(file.slice(0, -"/.gitignore".length), version);
            else nested.delete(file.slice(0, -"/.gitignore".length));
            dirs = new Map();
            changes++;
        },
        /** `file` as holding `text` (null: absent). */
        set(file, text) {
            self.put(file, text == null ? null : bank.version(file, ruleText(text)));
        },
        delete(file) {
            self.put(file, null);
        },
        /** Is the subject's path ignored? Throws IgnoreBudgetError past its budget. */
        excludes(subj, isDir = false) {
            const n = subj.raw.length;
            if (!n) return false;
            if (n > 1) {
                const prefixes = prefixesOf(subj);
                for (let k = 1; k < n; k++) {
                    let v = dirs.get(prefixes[k]);
                    if (v === undefined) dirs.set(prefixes[k], (v = own(subj, k, true)));
                    if (v) return true;
                }
            }
            return own(subj, n, isDir);
        },
        match(path, isDir = false) {
            return self.excludes(bank.subject(path), isDir);
        },
        /** Does `other` hold exactly these versions? */
        same(other) {
            if (other.sig !== sig || other.files.size !== files.size) return false;
            for (const [file, version] of files) if (other.files.get(file) !== version) return false;
            return true;
        },
        /**
         * Would these rules give `subj`'s path the same verdict as `other`'s,
         * going by the files that govern it alone? True when every one of them
         * is the same version in both.
         */
        alike(other, subj) {
            if (other.files.get(".vcsignore") !== vcs || other.files.get(".gitignore") !== root || other.files.get(EXCLUDE_FILE) !== exclude) return false;
            if (!nested.size && !other.nestedCount) return true;
            const prefixes = prefixesOf(subj);
            charge(subj, subj.raw.length);
            for (let i = 1; i < subj.raw.length; i++) {
                const file = `${prefixes[i]}/.gitignore`;
                if (other.files.get(file) !== files.get(file)) return false;
            }
            return true;
        },
        get nestedCount() {
            return nested.size;
        },
    };
    for (const [file, version] of init ?? []) self.put(file, version);
    return self;
}

/**
 * The rules for one directory tree, from the text of its ignore files (see
 * `view`): `texts` maps each file's path relative to the tree —
 * `.vcsignore`, `.gitignore`, `.git/info/exclude`, `packages/api/.gitignore`
 * — to its text. `set` and `delete` change a file while the rules are in use.
 * `match` throws IgnoreBudgetError for a path past `opts.budget`.
 */
export function ruleSystem(texts, opts = {}) {
    const rules = ruleBank(opts).view();
    for (const [file, text] of texts instanceof Map ? texts : Object.entries(texts ?? {})) rules.set(file, text);
    return {
        match: rules.match,
        set: rules.set,
        delete: rules.delete,
        get source() {
            return rules.source;
        },
    };
}

/**
 * How large an ignore file may be before it is not read as one — or null
 * when it is fine.
 *
 * These bound what reading and compiling the file costs, and what it takes up
 * in the mount's rules file; what MATCHING against it costs is held to each
 * path's budget instead (`PATH_BUDGET`). The largest real templates are a few
 * hundred lines (GitHub's Unity and VisualStudio files, ~400 lines and ~7KB),
 * so these sit two orders of magnitude above any real file. What happens to a
 * file over them depends on who wrote it (see mount.js).
 */
export const IGNORE_FILE_MAX_BYTES = 256 * 1024;
export const IGNORE_FILE_MAX_RULES = 10_000;

/** Why `bytes` (or a string) cannot be read as an ignore file, or null. */
export function ignoreFileProblem(bytes) {
    const text = typeof bytes === "string" ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
    const size = typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.length;
    if (size > IGNORE_FILE_MAX_BYTES) {
        return `it is ${Math.round(size / 1024)} KB, and an ignore file may be at most ${IGNORE_FILE_MAX_BYTES / 1024} KB`;
    }
    const rules = ruleLines(text).length;
    if (rules > IGNORE_FILE_MAX_RULES) {
        return `it has ${rules} rules, and an ignore file may have at most ${IGNORE_FILE_MAX_RULES}`;
    }
    return null;
}

/**
 * Starter `.vcsignore` for a project.
 *
 * Seeded from the Node defaults, then from every file git reads — the
 * patterns a project already maintains are the best statement of what is
 * derivable in it, and re-typing them is how the two files drift. `texts` maps
 * each file (`.gitignore`, `.git/info/exclude`, `packages/api/.gitignore`) to
 * its text; a string is the root `.gitignore` alone.
 *
 * All of them, because a `.vcsignore` wins outright: drafting from the root
 * `.gitignore` alone switched off every nested `.gitignore` and the exclude
 * file the moment it was written, and uploaded what they kept home. They are
 * carried over in git's order of precedence — exclude, root, then nested
 * files shallow to deep — and a nested file's patterns are re-anchored under
 * its directory, so the one flat file means what the several did.
 */
export function draftIgnores(texts) {
    const files = typeof texts === "string" || texts == null
        ? new Map([[".gitignore", texts ?? ""]])
        : texts instanceof Map ? texts : new Map(Object.entries(texts));
    const nested = [...files.keys()]
        .filter((file) => file.endsWith("/.gitignore"))
        .sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));

    const sections = [];
    // A line the defaults already have reads as noise — but dropping it is
    // only harmless while no negation has come before it: after `!dist/`, a
    // second `dist/` is what puts dist back out of the sync.
    let negated = false;
    const carry = (label, lines) => {
        const kept = lines.filter((line) => {
            const redundant = !negated && DEFAULT_LINES.has(line);
            if (line.startsWith("!")) negated = true;
            return !redundant;
        });
        if (kept.length) sections.push(`# Carried over from ${label}.\n${kept.join("\n")}`);
    };
    carry(".git/info/exclude", ruleLines(files.get(".git/info/exclude")));
    carry(".gitignore", ruleLines(files.get(".gitignore")));
    for (const file of nested) {
        const dir = file.slice(0, -"/.gitignore".length);
        carry(`${file}, re-anchored under ${dir}/`, ruleLines(files.get(file)).map((line) => reanchor(line, dir)).filter(Boolean));
    }

    if (!sections.length) return NODE_DEFAULTS;
    return `${NODE_DEFAULTS}\n${sections.join("\n\n")}\n`;
}

/**
 * One line of `dir/.gitignore` as a line of a root file: an anchored pattern
 * is prefixed with the directory, a bare one may match at any depth beneath
 * it. The directory is escaped, since its name is matched literally.
 */
function reanchor(line, dir) {
    let pattern = line;
    let neg = "";
    if (pattern.startsWith("!")) {
        neg = "!";
        pattern = pattern.slice(1);
    }
    let slash = "";
    if (pattern.endsWith("/")) {
        slash = "/";
        pattern = pattern.slice(0, -1);
    }
    const anchored = pattern.includes("/");
    pattern = pattern.replace(/^\/+/, "");
    if (!pattern) return null;
    const base = dir.replace(/[\\*?[]/g, "\\$&").replace(/^[#! ]/, "\\$&");
    return `${neg}${base}/${anchored ? "" : "**/"}${pattern}${slash}`;
}

const DEFAULT_LINES = new Set(ruleLines(NODE_DEFAULTS));
