# Changelog

All notable changes to `@muhkoo/cli` are documented here.

## Unreleased

## 0.15.0-alpha.8 — an emptied mount folder downloads again (2026-10-14)

Released with @muhkoo/connect 0.15.0-alpha.8 (no SDK changes), and published with `npm run release`: both `alpha` and `latest` point at it.

### Fixed

- **Emptying a mount folder no longer stalls the mount.** When the folder holds no files and no folders at all (only the mount's own `.muhkoo`, or files like `.DS_Store` that never sync), the mount now downloads everything again instead of refusing to delete it all from your filesystem and asking you to remove `.muhkoo/mount.json`. Folders come back too, and nothing is deleted remotely. To delete the files from your filesystem instead, use `muhkoo vfs rm -r <path>`. A folder that still holds folders, or some of its files, is still held by the mass-delete breaker, and so is a remote side that comes back empty.

## 0.15.0-alpha.7 — `vfs mount` restarts in seconds, and syncs folders (2026-10-14)

Released with @muhkoo/connect 0.15.0-alpha.7 (no SDK changes), and published with `npm run release`: both `alpha` and `latest` point at it.

### Changed

- **A restarted mount no longer downloads your whole tree.** To compare the two sides, the mount hashes each remote file's content. What it has hashed is now kept in `.muhkoo/content-hashes.json`, keyed by the file's manifest, so a restart reads only files that are new or changed. Mounting an unchanged 616-file drive went from about a minute to about 3 seconds. The first mount after upgrading still reads everything once. A cache file that is missing or not in the expected shape is ignored.

### Fixed

- **Folders sync, not just the files in them.** An empty folder made on either side now appears on the other. With `--allow-delete`, a folder removed on one side is removed on the other, deepest first, after the files in it. Only an empty folder is ever removed: one that still holds a file that is not synced (ignored, hidden or refused) is kept, and the mount says so. Folders follow the same refused-path and ignore rules as files, and no folder is removed in a pass where the mass-delete breaker holds the file deletes.
- **After upgrading, empty folders you removed on one side before this release may reappear.** Earlier versions did not record folders, so the mount cannot tell an old removal from a new folder. Remove them again and the removal now carries over.

## 0.15.0-alpha.6 — faster `vfs mount` (2026-10-14)

Released with @muhkoo/connect 0.15.0-alpha.6, and published with `npm run release`: both `alpha` and `latest` point at it.

### Changed

- **`vfs mount` downloads several files at once.** Pulls run 8 at a time and the scan reads 16 at a time, each within 64 MiB of reads in flight, so a tree with large files syncs about twice as fast.
- **Built on @muhkoo/connect 0.15.0-alpha.6**, which reads large files two chunks ahead (about 40% faster).

### Fixed

- **A file record without a valid size can no longer stall the scan.** It counts as 0, and a read too large for the window is released as soon as it is done.

## 0.15.0-alpha.5 — moves to @muhkoo/connect 0.15.0-alpha.5 (2026-10-10)

Released with @muhkoo/connect 0.15.0-alpha.5, and published with `npm run release`: both `alpha` and `latest` point at it. The CLI's own code is unchanged from 0.15.0-alpha.4.

### Changed

- **Built on @muhkoo/connect 0.15.0-alpha.5.** A write the platform refuses for payment now fails with the reason (`user_plan_required`, `user_payment_past_due` or `owner_payment_past_due`) and, where there is one, a link to fix it. `muhkoo vcs checkout` and `muhkoo vfs import` no longer create the content space just to reference a file, and an upload whose session has expired re-establishes it once instead of failing.

## 0.15.0-alpha.4 — `vfs mount` checks its arguments; no warning after `muhkoo login` (2026-10-06)

Released with @muhkoo/connect 0.15.0-alpha.4, and published with `npm run release`: both `alpha` and `latest` point at it.

### Fixed

- **`vfs mount` and `vfs import` check that `--path` is a Muhkoo path, and `mount` suggests the fix when the two are swapped.** `<dir>` is the folder on this computer and `--path` the path in your Muhkoo filesystem. Given the other way round, `muhkoo vfs mount /apps/quick-lighthouse --path ./` took `./` as the Muhkoo root `/.` and failed with `ENOENT: … mkdir '/apps'`. A `--path` with a `.` or `..` segment, one starting with `~`, or one with no value is now refused, before the session opens, with an error that says what `--path` is for. A missing leading slash is still accepted (`apps/x` is `/apps/x`). When `mount`'s folder looks like a Muhkoo path (absolute, starting at a folder this computer does not have, such as `/apps`, and `--path` missing or refused), the error ends with the command the other way round, such as `Did you mean: muhkoo vfs mount ./ --path /apps/quick-lighthouse`, keeping your other options. It is only suggested, never run.
- **`vfs mount` creates the folder you name, but no longer the folders above it.** It ran `mkdir -p`, so a mistyped or swapped path made a chain of empty folders, or tried to create one at the top of the disk. When the parent is missing, `mount` and `mount --dry-run` now stop before writing anything and name it. Create the parent first if you meant it.
- **`muhkoo login` no longer ends with `MaxListenersExceededWarning` printed twice.** The ZK prover leaves a worker thread per core, each piped into the CLI's stdout and stderr, and on a machine with many cores the exit flush added in 0.15.0-alpha.3 added one listener past Node's limit. It now raises the limit only while it adds its listener, as Node does for the workers, and removes the listener once its output is written.

## 0.15.0-alpha.3 — `muhkoo kv ls`; piped output is no longer cut short (2026-10-03)

Released with @muhkoo/connect 0.15.0-alpha.3, and published with `npm run release`: both `alpha` and `latest` point at it.

### Added

- **`muhkoo kv ls [prefix] [--json]`** lists the keys in your personal key/value store that start with `prefix`, or all of them. This is the store under `client.kv`, which your filesystem (`vfs/…`) and version control (`vcs/…`) share. It prints names only and never reads a value, so it needs a session but not an unlocked vault, with no password prompt and no pairing. `--app` picks the app the read is made as, as for `vfs`. Keys print with control characters escaped. Put `--json` after `ls`.

### Changed

- **`vfs sweep`, and abbreviated hashes in `vcs show`, `vcs diff` and `vcs checkout`, ask the server only for their own keys**, through the SDK's prefix listing. Against a server without it they work as before.

### Fixed

- **`--json` output (and piped output) no longer starts with the SDK's `initialized` line.** Every command that signs in (`kv`, `vfs`, `vcs`, `login`) printed `[@muhkoo/connect] initialized — v…` first, so `muhkoo kv ls --json | jq` failed to parse and `muhkoo kv ls | wc -l` counted the line as a key. The SDK now prints it only in a browser.
- **Output piped to another program is no longer cut short.** On macOS, the CLI exited before a pipe had taken all of its output, so everything past the first 64 KiB (or less) was lost and the command still exited 0: `muhkoo kv ls vfs/ | wc -l` undercounted, `muhkoo kv ls --json | jq` failed to parse, and `muhkoo vfs cat <large file> | …` got a truncated file. It now waits for its output to be written before it exits. Redirecting to a file was not affected.
- `muhkoo kv ls` prints its "no keys" hint to stderr, so piping its output never reads the hint as a key.

## 0.15.0-alpha.2 — released with @muhkoo/connect 0.15.0-alpha.2 (2026-10-03)

Published with `npm run release`: both `alpha` and `latest` point at it, as they do for the SDK.

No CLI command changed. The SDK underneath fixes folder writes that could undo each other, which matters most for `vfs mount` and `vfs import`, since they write many files into one folder:
- Two writes of one folder are sent one at a time, in order, so an earlier write can no longer land last and undo a later one.
- When a folder write fails while others are queued, the queued writes keep their entries.
- Reading several large files at once no longer fails with "chunk unrecoverable".

The CLI skips 0.15.0-alpha.1: it tracks the SDK's version, and its 0.15.0-alpha.0 release still pinned SDK 0.15.0-alpha.0.

## 0.15.0-alpha.0 — released with @muhkoo/connect 0.15.0-alpha.0 (2026-10-02)

Published under the npm `alpha` tag only, like the SDK it ships against. `latest` stays on 0.14.0-alpha.9 until the server side of the SDK's signed private channels is in production. Install it explicitly: `npx -y @muhkoo/cli@0.15.0-alpha.0`.

No CLI command changed. The SDK underneath now refuses to use a temporary chat key when a session has no account secret in memory. The CLI's commands are not affected, because they all sign in first or work with files.
- `vfs` and `vcs` keep files in a files-only Space, which needs no chat identity. In 0.15 it is built without a keyring.
- `login`, `provision`, `deploy` and the other management commands unlock the account (by password or this machine's `device` factor) before they do anything.

## 0.14.0-alpha.9 — `mount` and `import` after the second audit (2026-09-24)

A second, adversarial audit of `vfs mount` and `vfs import` against the same threat model as 0.13.0: anything able to write a user's VFS — every app they sign into holds the master seed — chooses the paths, names and bytes that arrive, but cannot touch the disk directly. Two further rounds of review then attacked the fixes themselves; what they found is folded in below. Each fix has a test that reproduces the scenario and failed before the fix.

### If you used `--hidden` before this release

**Copies of `.git/`, `.npmrc`, `.netrc`, `.envrc`, `.ssh/` and `.config/` that a previous version uploaded are NOT removed by this fix, nor are `.env` files, which it uploaded when an ignore file (possibly a pulled one) negated the default `.env` rules.** Only the remote side was refused before, so with `--hidden` the local side uploaded them — your git remote URL with any embedded token, npm auth tokens, `.netrc` passwords, API keys. Check with `muhkoo vfs tree /apps/<slug>` (or the root you mounted), remove them with `muhkoo vfs rm -r`, and **rotate any token they contained**: every app holding your seed could read them.

Likewise, if you mounted before this release, look over your `.vcsignore` and `.gitignore` files — nested ones too — for lines you did not write, and for spellings like `.VCSIGNORE` or `.GitIgnore`. The new ignore ratchet (below) starts from what is on disk the first time this version runs, so a file planted earlier would be taken as your own.

### Security

- **No edit to an ignore file can make an excluded path sync — only an explicit accept can.** A pulled `.vcsignore` replaced the project's `.gitignore` outright, and the next pass uploaded the files it had kept home (`config/master.key`, `*.pem`, `credentials.json`). Two attempts to tell a pulled ignore file from the user's own edit of it were each undone by one ordinary local edit — a blank line, one added rule, CRLF line endings — to a file that had arrived from elsewhere. So the sync no longer asks where a file came from. `.muhkoo/ignore-rules.json` (local only; never synced) keeps a list of **snapshots**: the rules in every ignore file the mount reads — root `.vcsignore` and `.gitignore`, every nested `.gitignore` in a directory it enters (dot-directories only with `--hidden`), `.git/info/exclude` — as they stood. The first pass records one before anything is pulled, and every pass after appends the rules as they now stand whenever the list does not already hold them. **The list changes only by append or by an accept** — nothing else ever drops or replaces a snapshot. A snapshot keeps rules, not text, so comments, blank lines and line endings add nothing, and neither does switching back to rules it already holds — a branch switch. Any other change adds one, a rule added included: an earlier version of this release let rules "only added" to a file replace the snapshot they extended, and a byte-order mark at the start of a later line hid a `!` from that check, so a planted `config/.gitignore` of `\n\ufeff!master.key` dropped the snapshot keeping `config/master.key` home, and it uploaded. Each version of a file is stored once, however many snapshots hold it. A path is ignored if **any** snapshot, or the files as they now stand, ignore it — each read the usual way, a `.vcsignore` winning within its own snapshot — and the same test decides both directions. So:
  - **tightening applies at once**, from anywhere: it is in the files as they now stand;
  - **loosening waits** — yours as much as anyone's. `muhkoo vfs ignore <dir>` says whether earlier rules still apply, which ignore files changed since the last accept, and which local files those rules hold back (files arriving from your filesystem may be held too). **`muhkoo vfs ignore <dir> --accept` previews**: it shows the same, and a digest of the ignore files as they now stand, with the command that accepts exactly them — `muhkoo vfs ignore <dir> --accept <digest>`. That refuses, and accepts nothing, if the ignore files have changed since: an accept adopts whatever ignore files are on disk, one that arrived from elsewhere included, and the `--accept --yes` of an earlier version of this release re-read the disk, so a file that landed after the preview — a `config/.gitignore` of `!master.key` — was adopted without ever being shown. On a terminal the preview asks y/N instead, and accepts the files it showed, checked the same way. `--yes` is gone. A running `mount` acts on an accept at once. `mount` and `import` name what they are holding back, once;
  - **it fails closed.** Your own edits or ignore files arriving from your filesystem past 64 sets of rules or 2 MB, or a rules file that cannot be read, stop the pass with a message naming the ignore files changed since the last accept, and how to review and accept them — it never starts afresh, which would adopt a pulled file as your own. So a remote party can force that review, **never a leak**: a denial of service accepted as the price of a list nothing but an accept can shrink. (An earlier version of this release reserved half the limits for your own edits and set aside what arrived past it; that machinery is gone.) An ignore file from your filesystem that cannot be read as rules at all (over 256 KB or 10,000 rules), or cannot be read, is not pulled, and uploads wait for it while pulls go on — named, with why, and said again whenever the uploads it holds change. An ignore file of your own over those limits stops the pass, naming it: reading part of it, or none, could only drop exclusions. The rules file is written by rename, so a crash leaves the old one or the new one;
  - **losing `.muhkoo/` does not reset it.** A copy is kept under `~/.muhkoo/mounts/`, keyed by the directory and the remote root mounted there, and read — and put back — when the project's own is gone: `git clean -fdX` removes `.muhkoo/` once it is git-ignored, and the next pass adopted whatever was on disk, a pulled `.vcsignore` included. A different project checked out at the same path, from another root, starts afresh;
  - an ignore file is read only under its exact name, and a remote `.VCSIGNORE`, `.GitIgnore` or `.gitignore.` is refused, since a volume that folds names would read it as the real one;
  - so a pulled `!.env` cannot make `.env` sync with `--hidden`, while a project that syncs `.env` on purpose, with its own `!.env`, still can.
  - an ignore file that begins with a byte-order mark, as Windows editors save one, is read as git reads it: the mark had become part of the first rule, which on a case-sensitive volume then matched nothing. Stored rules are read back exactly as stored, so a `.gitignore` whose first rule line starts with one no longer reads as new rules on every pass — which rewrote the rules file, and woke a running mount, four times a second.

  The cost, accepted: a loosening made on another machine, or a rule you delete here, lets nothing new through until you accept it; and every change to the rules, a rule added included, uses one of the 64 sets until the next accept.
- **Remote ignore rules apply in the pass that brings them.** They were read only on the pass after, so a fresh directory mounted onto a project uploaded a local `config/master.key` in the same pass that brought the `.gitignore` listing it. One that cannot come down — or has not yet, below — holds that pass's uploads, rather than let it upload what its rules would have kept home.
- **Refused paths are refused in both directions, and before the ignore rules.** Only downloads were refused, so `--hidden` uploaded `.git` and `.npmrc`, then read their absence remotely as a deletion — `--allow-delete` removed the local `.git`, and without it they re-uploaded forever. A pulled `!node_modules/` could also negate the refusal. No ignore file can now.
- **One write boundary for every write and delete on this disk.** Every existing component of the path must be listed under exactly that spelling and be a real directory, not a symlink; the final file is replaced only if the local scan reported it, and via a temp file renamed into place. This closes: case and Unicode aliases on APFS and NTFS (a remote `src/App.ts` or NFD `café.md` overwrote unsynced edits to the real file; `Config/Master.key` overwrote an ignored local-only key); a symlinked directory inside the mount redirecting writes outside it; and a hard-linked file being rewritten in place, changing its twin. Replaced files keep their permission bits, so an executable script edited on another machine still runs.
- **Names are compared the way a volume might compare them**, in the refusal and the ignore rules: full case folding (`ſ` is `s`, `ß` is `ss`, the `ﬁ` and `ﬆ` ligatures are `fi` and `st`), NFKC, zero-width and direction marks, trailing dots and spaces, and 8.3 short names — `Node_Modules`, `node_moduleſ`, `.GIT`, `.git.`, `.ßh` and `GIT~1` are all refused. A remote `config/maſter.key` is no longer pulled past a `config/master.key` rule, where the real key, written later, would have landed in it and uploaded. Two remote paths that would land on one file here are refused on a volume that folds names — judged the way THIS volume folds (case only when it folds case, canonical normalization but not compatibility forms, Windows' `:` and trailing-dot rules only on Windows), so `run-10:30.txt` and `run-10:45.txt`, `report` and `report.`, and `v2.md` and `v².md` all sync on a Mac, and a group whose spellings are all on disk already is never refused. On Windows, names with `:`, a backslash, `<>"|?*`, a trailing dot or space, or a device name (`CON`, `nul.txt`, `COM1`, `CONIN$`…) are refused at the write boundary.
- **More refused paths**: `.husky`, `.claude`, `.cursor`, `.zed`, `.fleet`, `.gitconfig`, and the shell-init files the first list missed — `.zshenv` (sourced by every zsh, scripts included), `.zprofile`, `.zlogin`, `.zlogout`, `.bash_login`, `.bash_logout`, `.kshrc`, `.pam_environment`, `.xprofile`. `--hidden` users who synced `.vscode/`, `.idea/` or `.config/` from this side will find they no longer upload.
- **`mount` and `import` refuse the filesystem root, your home directory, and any directory containing it** — compared as directories, so `/System/Volumes/Data/Users/<you>` and the data volume itself are refused too. A home mount uploaded everything in it, and a remote `Library/LaunchAgents/x.plist` landed where launchd loads it at login, no flag needed. There is no override.
- **The ignore matcher cannot be made to hang, or to crash.** Patterns compiled to RegExps with one unbounded `.*` per star; a planted `**a**a…**!` against a long name ran for longer than anyone would wait, synchronously, so Ctrl-C did nothing. The new matcher is iterative — a line of 20,000 `**/` segments no longer overflows the stack — and a POSIX class named after a JavaScript built-in (`[[:constructor:]]`) is a bad line, not an error on every pass. The text before a pattern's first `*` and after its last is compared in place, so only runs between two stars are ever searched for (10,000 planted `*?aaaa…ab3` rules cost 166ms a path), and a rule with more than 32 wildcards, or a character class listing more than 64 members, is skipped with a warning (a single planted class of 250,000 members held every pass for 15 seconds). **Each path's matching is held to a budget**, counted as it happens — every rule considered, every name compared, a searched run by the length of the name it is searched in, a class by its members. A path that would take more is **left alone**: neither synced nor deleted, in either direction, and named in one warning. This replaces working out each file's worst case in advance and capping the stored rules' total, which each review found a shape to misprice — and which a remote party could fill. A file every snapshot holds is matched once per path, not once for each, and a rule under a `**` is tried once per directory rather than once for every pair of them (a draft's `web/**/report.[0-9]*…` line had been priced at 17 million). A path from your filesystem more than 64 directories deep, or with a name longer than 255 characters once folded, is not matched at all. So one path's matching takes about 10ms at the very worst on a fast machine (an M4 Max; a few times that on a slow one), and ordinary paths a tiny fraction of the budget; scans hand the event loop back every 25ms and check for Ctrl-C between entries, so a stop lands within about that — a planted file and 200 long names took 33s a pass and 32s to answer Ctrl-C.
- **What a pass writes here is bounded.** Many VFS entries can share one stored blob, so one 100MB file and a million cheap entries had a pass write it a million times. A pass now pulls at most 2 GiB or 10,000 files — a running `mount` goes straight on to a follow-up pass for the rest — and a pull that would leave the disk with less than 5% of it free, at least 1 GiB and at most 10 GiB, waits, with one warning. Held pulls change nothing. These limits, and the 100 MB one, are checked again against the bytes that arrive. The size a directory record claims can only get a file skipped or held sooner, never let through: the remote party writes it, and a record saying 0 carried a 101 MB file past the size limit and a 1 MB one past the reserve. **Ignore files are held to them like any other file**: an earlier version of this release exempted them as small, and one 256 KB `.gitignore` of comments, copied to thousands of directories, landed 7.45 GiB in one pass on a disk already under its reserve. So on a disk short of its reserve a teammate's `.gitignore` edit waits for space, and this machine's uploads wait with it — said, with why. `mount` no longer says "In sync" after a first pass that held pulls: it says how many wait for disk space, how many follow in the next pass, and how many changes wait to upload.
- **What a pass reads is bounded too.** Every pass read and decrypted every remote file to hash it — 200 entries sharing one 4 MB blob were 868 MB a pass, steady passes included. Content is now keyed by its manifest, which fixes the bytes: what a running `mount` has read once is not read again, entries sharing content are fetched once in a pass, and a steady pass reads nothing. A pass of `mount` reads at most 2 GiB or 10,000 files to compare, ignore files included and both rounds of a pass together; the rest are left alone until a follow-up pass, which starts at once, and an ignore file among them holds that pass's uploads. A file whose manifest's own chunk sizes put it over 100 MB is skipped before anything is fetched, whatever its record claims — the reader holds a read to those sizes.
- **What reaches the terminal is escaped.** Commit messages, branch names, authors and file names are written by whatever holds your seed, and printing them raw let a planted `fix typo` set your clipboard (OSC 52) in kitty, Alacritty, Windows Terminal and tmux. Every output helper now writes control characters (newlines included), C1, bidi overrides and invisible characters as `\uXXXX`; only the CLI's own line breaks and colours get through. `vfs cat` and `functions code` do the same when writing to a terminal, keeping the file's own line breaks and tabs, and write unescaped when piped. They print text, not bytes; `vfs get` saves a file exactly. `--json` output stays valid JSON. `vcs log` and `vcs commit` show a message's first line, as `git log --oneline` does, rather than its body as escapes.

### Added

- **`vcs merge --abort`** gives up on a merge, and needs `@muhkoo/connect` 0.14.0-alpha.9, which adds `repo.abortMerge()`. That release also stops every `commit()` on a pending-merge record it cannot read, with an error that says to abort the merge, so this is the way out of that as well as of a merge that stopped for conflicts. It deletes only the merge record, so it works when that record is unreadable, and leaves your files as the merge left them. Then it prints the command that puts them back: `vcs switch <branch> --discard` on a branch, or `vcs checkout <commit> --discard` on a detached HEAD, which keeps HEAD where it was (switching to a branch would move it to that branch's tip). `--discard` runs that for you. `--json` prints `{ "aborted", "merge" }`. Anything else given with `--abort`, a branch name included, is refused and named. Only the SDK's unreadable-record error counts as an unreadable record: a network failure, or no session, fails the command rather than report a merge abandoned that may never have been under way. `vcs status` reports an unreadable record, with the way out, and still lists your changes, rather than fail with the same error.

### Fixed

- **`vfs mount --dry-run` previews instead of mounting.** The flag was read by `import` alone, so `vfs mount <dir> --dry-run` dropped it and mounted for real — pulling, pushing and, with `--allow-delete`, deleting: the opposite of what was asked. It now runs the same scan and plan a pass does, lists what mounting would download, upload and delete in both directions, marks a delete that needs `--allow-delete`, and stops. The plan has none of a pass's limits, so for a large project it shows everything the mount would do over the passes it runs one after another, not the first pass alone. While an ignore file from your filesystem cannot be read, a mount uploads nothing; the preview marks those uploads held, leaves them out of the count and names the file. A directory that does not exist yet is not created, and is planned under the ignore rules recorded for it, from the copy under `~/.muhkoo`, as the mount will be once it has created it. A path the mount could not create (under a file, a dangling symlink, a parent that cannot be searched or written) is refused rather than given a plan.
- **A dry run writes nothing, not even for a moment.** `vfs mount --dry-run` and `vfs import --dry-run` asked whether the volume folds case by writing a probe file into the directory's `.muhkoo/`, creating `.muhkoo/` for it when there was none, and then removing it. That left nothing behind, but it changed the directory, and through a `.muhkoo` symlink the directory it points to. A dry run now asks the names already in the directory instead, and assumes the volume folds case when none of them can tell. A dry run also no longer pairs a machine that is not paired yet, which enrolled a device on the server and saved its key to `~/.muhkoo/config.json`. It signs you in for that one command instead, and it leaves a stale working directory or a revoked pairing in the config for the next ordinary command to clear.
- **`--no-pair` works.** The argument parser hands it over as `"no-pair"`, and only `pair: false` was ever read, so the flag was ignored and the machine was paired anyway. In `vfs import` and `vfs mount` it no longer swallows a directory that follows it.
- **`muhkoo --help` lists every `vfs` and `vcs` subcommand.** `vfs mount`, `import` and `ignore` — the commands that write to your disk — were missing, along with `vfs cd`, `pwd`, `stat`, `tree`, `mkdir`, `sweep`, `use-app` and `app`, and `vcs show`, `checkout` and `restore`. A test now checks it against each command's own help in both directions, and that help against the subcommands the code dispatches, so a subcommand added to one and not the other fails, and so does a stale or misspelled name.
- **`vfs mount <dir>` at the default root `/` works.** It never pulled anything: through 0.14.0-alpha.8 the SDK answered `exists("/")` with false, so every pass saw an empty filesystem, and pass two planned deleting every file pass one had uploaded (`--allow-delete` carried it out; without it, the project re-uploaded forever). Keys at `/` also lost their leading slash. The mount no longer asks whether `/` exists, and keeps its paths slash-prefixed; the SDK now answers `true` as well.
- **What one side deliberately did not look at is never read as deleted.** Refused, over the 100MB limit, unreadable, or not a regular file: the planner now leaves such paths — and their state — alone. A large remote asset was deleted with its history by a size limit only one side applied; a file re-included under an excluded directory flipped between pull and delete; one unreadable remote file stopped every pass, and `mount` from starting. A remote size the directory record admits is over the limit skips the read. Checking a path against what was left alone walks it a segment at a time: slicing every prefix afresh held the event loop for half a second over a thousand remote paths 61 deep.
- **A circuit breaker on mass deletion.** A pass that would delete more than three files and leave fewer than half of the most this session has tracked — or anything at all when the other side is suddenly empty — deletes none of them in that direction and says why: the signature of a missing root or a wiped directory, not an edit. Deleting the last file of a project is now done by hand. The breaker catches broken views, **not an adversary**: whatever can write your filesystem can add filler files first so that its deletions stay a minority. `--allow-delete` trusts the remote.
- **No more busy loop.** A pass wrote its state file even when nothing changed, the watcher woke for it, and a plan that could never converge (a remote file where a local directory stands) re-ran the full remote read four times a second. State is written only when it changes, `.muhkoo/` never wakes the watcher, and a refused action is warned about once and changes nothing.
- **Stopping is prompt and clean.** Ctrl-C during `mount`'s first pass was ignored, leaving kill as the only way out. A stop now takes effect between steps of any pass, and within a scan; `mount` waits for the step under way before it returns, and says so — `Stopping after the current file — press Ctrl-C again to quit now` — and a second Ctrl-C quits at once (exit 130), which is safe because every file lands by rename. A closed terminal (SIGHUP) stops it the same way.
- **`mount` saves its state correctly on exit.** The final save dropped the root, so every restart began from empty state and treated every difference as a conflict.
- **The watcher uses the sync's own rules.** A hard-coded list dropped edits under any `vendor/`, `target/` or `build/` directory, even where the project syncs it.
- **`import` only uploads.** It ran the full two-way sync — writing remote files into the project and, with `--allow-delete`, deleting local ones. Remote-only changes are now skipped and reported (`mount` brings them down), conflicts upload with local winning, and only deletions *to your filesystem* happen, with `--allow-delete`. `--dry-run` and the live output mark which side a delete lands on (`✕↑` your filesystem, `✕↓` this disk).
- **`import` exits non-zero when any directory fails**, so `muhkoo vfs import ~ && …` stops.
- **git's ignore rules in full**, when there is no `.vcsignore`: nested `.gitignore` files scoped to their directories, and `.git/info/exclude`, so files a sub-package's own `.gitignore` kept out no longer upload. As in git, a file under an excluded directory cannot be re-included, and a negated directory (`!keys/` after `*.pem`, or the `*` / `!*/` / `!*.js` whitelist) keeps the directory, not the files in it that another rule excludes.
- **`muhkoo vfs ignore --write` carries every file git reads into the `.vcsignore`** — nested `.gitignore` files re-anchored under their directories, and `.git/info/exclude` — since a `.vcsignore` replaces them all. It drafted from the root `.gitignore` alone, switching the rest off. It drafts from the files as they stand on disk; with the ratchet, a `.vcsignore` looser than the rules it replaces lets nothing new through until accepted. **Changed:** `muhkoo vfs ignore <dir>` on its own now shows what the ratchet holds back; `--draft` prints the draft it used to print. A flag given before the directory — `vfs ignore --accept ~/proj` — takes it as the directory (it accepted the working directory instead), and `--accept` refuses a directory that was never mounted or imported; `vfs ignore` on one says it has no stored rules. `vfs ignore` no longer needs `--hidden`: it lists held files in dot-directories whatever the mount's flags, since an accept that never listed them still released them — but it reads a dot-directory's own `.gitignore` only where the mount does (with `--hidden`, as the rules file records), so the `*` a pytest, ruff or mypy cache writes no longer shows, for good, as older rules in force. `--write` refuses a draft past an ignore file's limits (a monorepo's worth of nested files flattened into one), which every pass would then have refused; `--draft` says so.
- **One bad line in an ignore file is skipped with a warning.** An invalid range such as `[z-a]` threw, and the throw silently discarded every rule in the file. As in git: `**` — or any whole segment of two or more stars — is special only as a whole path segment; a leading space is part of the pattern (` !server.pem` is not a negation); trailing spaces are dropped unless escaped (`foo\ ` is `foo `); and on a case-sensitive volume `[A-Z]` matches only capitals, so `[!A-Z]*.key` excludes `server.key`.
- **Case-insensitive volumes match ignore rules case-insensitively**, as git's `core.ignorecase` does, so a rule for `config/master.key` also covers `Config/Master.key`; every volume matches them normalization-insensitively, as APFS compares names.
- **Leftover `.muhkoo-tmp-*` files never sync**, even with `--hidden`.
- **A file already identical on both sides is recorded as in sync.** Nothing needed copying, so nothing recorded it, and a checkout mounted onto the project it came from — a git clone, or a directory whose `.muhkoo/` was cleaned — read a teammate's next edit as a conflict, which this machine's stale copy won.
- **A flag before a directory no longer swallows it** in `vfs import` and `vfs mount`, as in `vfs ignore`: `vfs import ~/a --dry-run ~/b` dry-ran `~/a` and skipped `~/b` without a word, and `vfs mount --allow-delete ~/proj` asked for a directory.
- **`FORCE_COLOR` is now honoured**, as supports-color and chalk read it: any other non-empty value forces colour even when output is not a terminal, and `FORCE_COLOR=0` and `FORCE_COLOR=false` mean no colour. It was ignored before, so colour went only to a terminal. `NO_COLOR` still turns colour off.

## 0.13.2-alpha.0 — `mount` and `import` read in parallel (2026-08-29)

### Fixed

- **`scanRemote` reads files concurrently instead of one at a time**, which is what made `muhkoo vfs mount` look like it had hung on anything of size. Each read is an independent round trip (a manifest lookup plus its shards), so doing them in series cost the sum of the latencies. Measured on doodledottie — 38 files, 16.5MB — the scan went from **10974ms to 3143ms**. Affects `mount` and `import` alike, and the filters now run once up front rather than being interleaved with the reads.

## 0.13.1-alpha.0 — faster `vfs tree`, `mount` and `import` (2026-08-29)

### Fixed

- Picks up `@muhkoo/connect@0.13.1-alpha.0`, where `vfs.walk` lists sibling directories concurrently rather than one at a time. Every command that enumerates the filesystem — `tree`, `find`, `mount`, `import`, `sweep` — spent 1–2s walking before it did anything. Output order is unchanged.

## 0.13.0-alpha.0 — the sync no longer trusts what comes down (2026-08-24)

### Security

`vfs mount` writes the remote filesystem onto local disk, so anything able to write a user's VFS could choose both the bytes and the path of a file landing on their machine. Today that includes **every app the user signs into**, because hosted auth hands the app the master seed (tracked as SEC-3 in `accelerator/SECURITY-FOLLOWUPS.md`).

- **The ignore rules apply in both directions.** They previously decided only what LEFT the machine — nothing filtered what arrived, so a remote `/.git/config` was written straight into the developer's repository. `core.pager`, `alias.*` and `core.fsmonitor` are shell commands git runs itself on an ordinary `git status`, and need no execute bit, which the 0644 the sync writes would otherwise have denied.
- **An always-refused list that no flag overrides**: `.git/`, `.ssh/`, `.muhkoo/`, `.vscode/`, `.idea/`, `node_modules/`, `.envrc`, `.npmrc`, `.netrc` and shell rc files. `--hidden` means "sync dot-files", not "let a remote party rewrite my git config".
- **Writes and deletes refuse anything that is not a regular file.** `writeFile` opens with `O_CREAT|O_TRUNC` and follows symlinks, so a link anywhere in the mounted tree redirected remote content to whatever it pointed at — the one way content genuinely escaped the mount directory, on every platform. `scanLocal` already refused to *read* non-regular files; the two directions now agree.
- **A containment check** so a synced path cannot resolve outside the mount, applied to every action. Traversal was not reachable through the normal remote path (the SDK collapses `..` before a path leaves `walk()`), but nothing here relied on that, and the state file is a second source of keys that never passes through it.
- **`delete-local` is gated behind `--allow-delete`**, like the remote direction. Anything able to delete a file from the filesystem previously deleted it from the developer's disk with no flag and no prompt.

Covered by the new `tests/mount.test.js` — 11 of its cases fail against the previous release.

## 0.12.0-alpha.0 — `muhkoo vcs`, bulk import, and `.vcsignore` (2026-08-24)

### Added

- **`muhkoo vcs` — version control for a project.** `status`, `commit -m`, `log`, `show`, `diff`, `branch`, `switch`, `checkout`, `merge`, `restore`. The project comes from your VFS working directory, so `muhkoo vfs cd /apps/my-app` then `muhkoo vcs log` does what you would expect; `--project <slug>` overrides it. Drives `client.vcs` through the SDK, because commit hashes come from a canonical encoding and a second implementation here would only have to agree with it byte-for-byte forever.
- **`muhkoo vfs import <dir…>` — upload whole projects in one pass.** Several directories in ONE process on purpose: every invocation of the CLI unlocks the vault, and a shell loop over a dozen projects trips the auth rate limiter before it finishes. `--dry-run` lists what would go up and the total size before spending metered bytes.
  - The destination defaults to the slug the project declares in `.muhkoo-app.json`, falling back to the directory name. This matters because the portal opens the IDE at `?app=<slug>` and the IDE reads `/apps/<slug>` — a project imported under its directory name is invisible to both wherever the two differ.
- **`.vcsignore` — what not to sync.** Same syntax as `.gitignore` (`!` negation with last-match-wins, trailing `/` for directories, leading `/` to anchor, `*`, `**`, `?`, character classes), layered on top of built-in Node defaults. Resolution is `.vcsignore`, else `.gitignore`, else the defaults alone — so a project works before it opts in. `muhkoo vfs ignore [dir] [--write]` drafts one from the defaults plus the project's own `.gitignore`.
  - Defaults cover dependencies, build output, logs, and `.env` / `.env.*` with `!.env.example` — uploading a `.env` by accident is the expensive mistake here.
  - `.vcsignore` and `.gitignore` now travel with the project; every other dot-entry is still treated as machine state.

### Fixed

- **Sync state is scoped to the remote root.** It recorded which paths were in sync but not *where*, and `planSync` reads "present locally, in the state, absent remotely" as deleted on the other side — so re-pointing a directory at a different `--path` made every local file look deleted, and with `--allow-delete` they would have been. State from a different root is now ignored.
- `-m`, `-n` and `-r` are read from the positionals. The shared argument parser only understands `--flags`, so `muhkoo vcs commit -m "…"` silently lost its message and `muhkoo vfs rm <path> -r` silently refused to recurse.
- `muhkoo vfs ignore` no longer opens a client. Unlocking the vault to write a file on your own disk is both pointless and, in a loop, enough to trip the auth rate limiter.

## 0.10.11-alpha.0 — Access tokens + `muhkoo login` fix (2026-07-29)

### Fixed

- **`muhkoo login` no longer fails with `ERR_MODULE_NOT_FOUND: snarkjs`.** The ZK login path needs `snarkjs` at runtime, but it was never declared as a dependency — so a clean `npm i -g @muhkoo/cli` couldn't sign in (the workaround was installing `snarkjs` globally by hand). It's now a direct dependency.

### Added

- `muhkoo tokens ls|create|revoke <appId>` — manage **[access tokens](https://docs.muhkoo.dev/concepts/access-tokens/)**, the scoped, expiring credential a machine (CI, a server, a function) presents instead of a ZK sign-in. `create` takes `--scopes` (comma-separated, default `db:read,db:write`), `--env`, `--expires-in <days>`, and `--label`; the secret is printed once. `ls` shows label, env, scopes, expiry, and status.

> Versioned in lockstep with `@muhkoo/connect@0.10.11-alpha.0`.

## 0.10.9-alpha.0 — `promote` command (2026-07-06)

### Added

- `muhkoo promote [<appId>]` — promote an app's **test** hosting release (and functions) to **production**, in place. Complements `muhkoo deploy` (which publishes to the test env): deploy → verify on the test URL → `promote`. Owner-only (uses your developer session); the app id falls back to `.muhkoo-app.json`. Production data and per-env app config (CORS + redirect URIs) are not touched. `--json` for machine-readable output; a partial promote exits non-zero.

> Versioned in lockstep with `@muhkoo/connect@0.10.9-alpha.0` (passkey platform-authenticator fix).

## 0.7.0-alpha.5 — Security hardening (2026-06-18)

### Security

- Write `~/.muhkoo/config.json` (session token) and `.muhkoo-app.json` (app secret keys) with `0600` permissions — config via temp-file + atomic rename, directory `0700` — so there's no world-readable window.
- HTML-escape the loopback sign-in page, and redact app keys / long tokens from echoed server error bodies (login, deploy, and generic request errors).
- Added `SECURITY.md`.

> Versioned in lockstep with `@muhkoo/connect`; the jump to `0.7.0-alpha.5` keeps the two aligned.

## 0.1.0-alpha.0 — Initial release

First public alpha of the `muhkoo` CLI. Built on `@muhkoo/connect`.

### Added

- **Account:** `login` (zero-knowledge developer login → stored session token),
  `login --web` (browser sign-in via auth.muhkoo.dev over a localhost loopback —
  password/passkey/Google, no credentials touch the CLI), `logout`, `whoami`.
  Token also resolvable via `--token` / `$MUHKOO_DEV_TOKEN`.
- **Apps:** `apps ls|get|create|slug|rm`, `keys rotate`.
- **Backend provisioning:** `provision --spec <file>` — idempotently create/update
  database tables, agents, and serverless functions from one JSON spec; `--enable`
  to wire agents/functions onto channels; `--dry-run` to preview.
- **Hosting:** `deploy` (content-addressed blob upload + atomic release; accepts a
  developer session or an app secret key), `hosting status|rollback|rm-release|unpublish`.
- **Custom domains:** `domains ls|add|rm`.
- **Inspection:** `tables ls|get|rm`, `agents ls|get|rm|enable|disable|models`,
  `functions ls|get|code|deploy|rm|enable|disable`, `logs`.
- **Tools:** `eject` — preview an agent's compiled system prompt + tools config.
- **Environments:** `--base prod|staging|local|<url>` on every command;
  `--json` output on read commands.
