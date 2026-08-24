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
 * project that has not opted in gets sensible behaviour on day one.
 */

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
 * Compile ignore rules into a matcher.
 *
 * Returns `(path, isDir) => boolean`, where `path` is slash-separated and
 * relative to the directory the ignore file sits in, with no leading slash.
 *
 * Last match wins, which is what makes `!` negation work: `*.log` followed by
 * `!keep.log` keeps that one file.
 */
export function compileIgnores(text) {
    const rules = [];
    for (const raw of String(text ?? "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;

        let pattern = line;
        let negated = false;
        if (pattern.startsWith("!")) {
            negated = true;
            pattern = pattern.slice(1);
        }
        // An escaped leading '#' or '!' is a literal.
        if (pattern.startsWith("\\")) pattern = pattern.slice(1);

        let dirOnly = false;
        if (pattern.endsWith("/")) {
            dirOnly = true;
            pattern = pattern.slice(0, -1);
        }
        if (!pattern) continue;

        // A pattern with a slash anywhere but the end is anchored to the root;
        // a bare name matches at any depth. This is the rule that makes
        // `node_modules/` catch nested copies while `/dist` catches only the
        // top-level one.
        const anchored = pattern.includes("/");
        if (anchored && pattern.startsWith("/")) pattern = pattern.slice(1);

        rules.push({ ...toRegExp(pattern, anchored), negated, dirOnly });
    }

    return (path, isDir = false) => {
        let ignored = false;
        for (const rule of rules) {
            // A directory rule matches the directory itself only when the thing
            // being tested IS one — but it always matches what lives beneath it.
            // `node_modules/` has to catch `node_modules/react/index.js`, which
            // is a file, or pruning would ignore the directory and sync its
            // entire contents anyway.
            const hit = rule.under.test(path) || ((isDir || !rule.dirOnly) && rule.self.test(path));
            if (hit) ignored = !rule.negated;
        }
        return ignored;
    };
}

/**
 * Glob → RegExp, with gitignore's wildcard rules.
 *
 * `*` stops at a path separator, `**` crosses them, `?` is a single character
 * that is not a separator. An unanchored pattern may start at any segment
 * boundary, which is how `*.log` matches `src/deep/thing.log`.
 */
function toRegExp(pattern, anchored) {
    let out = "";
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === "*") {
            if (pattern[i + 1] === "*") {
                // `**/` may match nothing at all, so `**/foo` also matches `foo`.
                if (pattern[i + 2] === "/") { out += "(?:.*/)?"; i += 2; }
                else { out += ".*"; i += 1; }
            } else out += "[^/]*";
        } else if (ch === "?") out += "[^/]";
        else if (ch === "[") {
            const close = pattern.indexOf("]", i + 1);
            if (close === -1) out += "\\[";
            else { out += pattern.slice(i, close + 1); i = close; }
        } else out += ch.replace(/[.+^${}()|\\]/g, "\\$&");
    }
    // Two regexes, because "is this the thing" and "is this inside the thing"
    // are answered differently for a directory-only rule.
    const head = anchored ? "^" : "^(?:.*/)?";
    return {
        self: new RegExp(`${head}${out}$`),
        under: new RegExp(`${head}${out}/.*$`),
    };
}

/**
 * The ignore matcher for a directory.
 *
 * `.vcsignore` wins outright when present — a project that wrote one meant it.
 * Otherwise `.gitignore` stands in, and the Node defaults apply when there is
 * neither.
 */
export async function loadIgnores(dir, readFile) {
    for (const name of [".vcsignore", ".gitignore"]) {
        try {
            const text = await readFile(`${dir}/${name}`, "utf8");
            // Defaults come first so a project file can negate them with `!`.
            return { match: compileIgnores(NODE_DEFAULTS + "\n" + text), source: name };
        } catch {
            // not there; try the next
        }
    }
    return { match: compileIgnores(NODE_DEFAULTS), source: "defaults" };
}

/**
 * Starter `.vcsignore` for a project.
 *
 * Seeded from the Node defaults, then from the project's own `.gitignore` when
 * it has one — the patterns a project already maintains are the best statement
 * of what is derivable in it, and re-typing them is how the two files drift.
 */
export function draftIgnores(gitignore) {
    const theirs = String(gitignore ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        // Drop what the defaults already cover, so the file reads as "and also
        // these" rather than a wall of duplicates.
        .filter((line) => line && !line.startsWith("#") && !DEFAULT_LINES.has(line));

    if (!theirs.length) return NODE_DEFAULTS;
    return `${NODE_DEFAULTS}\n# Carried over from .gitignore.\n${[...new Set(theirs)].join("\n")}\n`;
}

const DEFAULT_LINES = new Set(
    NODE_DEFAULTS.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")),
);
