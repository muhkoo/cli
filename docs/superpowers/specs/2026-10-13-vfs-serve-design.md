# `muhkoo vfs serve` — the drive on demand, as a local network drive

Status: design approved in conversation by Matt, 2026-10-13. Awaiting review of
this written spec.

Repos: `cli` (the server and the shared rules), `connect` (`vfs.readRange` and
chunk read-ahead). Staging first; npm releases and production only on Matt's
ask, each time.

## Why

`muhkoo vfs mount` is a two-way **mirror**: it puts every file of the chosen
VFS tree on local disk before it is in sync. Mounting a whole drive (`--path /`)
downloads every IDE project and every large file, one file at a time, so it is
slow where the web drive feels instant — the web drive lists folders and only
fetches a file when it is opened.

Matt wants the web drive's behaviour on the desktop: see the whole drive, and
download a file only when something opens it — on macOS, Linux **and**
Windows — while code projects still work with editors, git and npm.

## Decision (Matt, 2026-10-13)

**A plus the mirror.**

- **`vfs serve`** (new) serves the VFS as a WebDAV server on `127.0.0.1`, which
  each OS mounts with its own built-in client. Browsing is metadata only;
  content is fetched on open, by the chunk.
- **`vfs mount`** stays the mirror, for code under `apps/`, where real local
  files keep tools fast. It gains parallel pulls (separate work, already in
  progress) and a pointer to `serve` in its help.

Rejected:
- **Native per-OS on-demand** (macOS File Provider, Windows Cloud Files API,
  Linux FUSE). The best experience, but three native codebases, signed apps,
  and a FUSE install on Linux: months, not days.
- **A mirror that leaves large files behind.** Simple, but it is not "download
  on open" — the user still chooses what to fetch.

WebDAV is the base because it is the only protocol all three OSes mount with
no extra software (macOS Finder and `mount_webdav`, the Windows WebClient
service, GNOME gvfs or davfs2). An NFS mode is out of scope for now.

## Behaviour

### Command

```
muhkoo vfs serve [--path <vfs dir>] [--port <n>] [--cache-size <size>] [--rotate] [--app <name>] [--key <k>]
```

- Serves `--path` (default `/`) until Ctrl-C, in the foreground.
- Binds `127.0.0.1` only. Port 4915 by default, else the next free one; `--port`
  pins it (and fails if taken).
- On start it prints the address, whether it is read-write or read-only (and
  why), and the mount command for the current OS (below).

### The address carries a secret

`http://127.0.0.1:<port>/<secret>/` — the secret is 128 random bits,
base64url. Any request whose first path segment is not the secret gets a bare
404, so another local process or user cannot browse the drive without it.

- A secret in the path, not a password: the Windows WebClient refuses Basic
  auth over plain http unless `BasicAuthLevel` is changed in the registry.
- The secret is saved per served VFS path under `~/.muhkoo` (0600), so the
  address survives restarts and a remembered Finder or Explorer mount
  reconnects. `--rotate` replaces it.
- The secret is never logged; the startup line is the only place it appears.

### Reading

- **Listings** (PROPFIND depth 0 and 1) come from `vfs.list` / `vfs.stat`: no
  file content is fetched to show a folder. Depth `infinity` is refused (403),
  as RFC 4918 allows.
- **Files** (GET, HEAD) are read on demand. A `Range` request reads only the
  chunks that cover it (`vfs.readRange`, below), so a video scrubs and a large
  file opens without downloading all of it. Responses: 200, 206 with
  `Content-Range`, 416 for an unsatisfiable range.
- `ETag` is the file's current version id; `Last-Modified` its mtime.
- **Changes from elsewhere** (web drive, another machine) appear through
  `vfs.watch`, which invalidates the in-memory listing cache. A listing older
  than 30 s is re-read regardless.

### Writing ("read-write, safe deletes")

Writes are metered to an app, so they need an app signed in, exactly as
`vfs put` does (`--app` / `--key`). With none, `serve` runs **read-only** and
says so at startup; every write method answers 403.

| Client action | WebDAV | VFS |
|---|---|---|
| Save / new file | PUT | `writeFile` — a new version; history kept |
| New folder | MKCOL | `mkdir` |
| Rename / move | MOVE | `rename` — a folder move never re-uploads |
| Copy | COPY | read + `writeFile` (files), recursive for folders |
| Delete | DELETE | **move to Trash** (below), never `vfs.delete` |
| Lock / unlock | LOCK / UNLOCK | in-memory only (below) |

- **Trash** uses the web drive's layout exactly (`cloud-drive/src/lib/trash.ts`,
  freedesktop):
  - `/.trash/info/<id>.trashinfo` containing
    `[Trash Info]` / `Path=<percent-encoded original path>` /
    `DeletionDate=<UTC YYYY-MM-DDThh:mm:ss>`, written FIRST to reserve `<id>`;
  - then the item is renamed whole to `/.trash/files/<id>` (same file ids, so
    history survives a restore); a failed move deletes the info file again;
  - `<id>` is the item's name, made unique with " (2)", " (3)"…, and trimmed so
    `<id>.trashinfo` fits the 255-byte name limit.
  So anything deleted from Finder or Explorer appears in the web drive's Trash
  and restores there. The CLI gets its own implementation of this format, with
  a test that parses its output with the web drive's `parseInfo` rules.
- **Deleting inside `/.trash`** is refused (403): emptying the Trash stays in
  the web drive.
- **Locks.** macOS Finder mounts a server read-only, and Office refuses to save,
  unless it is DAV class 2. `serve` answers LOCK with an in-memory exclusive
  write lock (opaquelocktoken, timeout honoured, max 1 h) and enforces it on
  PUT/MOVE/DELETE from other lock holders. Locks are local to the process and
  are not a cross-machine guarantee.
- **Two writers.** Last save wins; the earlier save stays in the file's
  version history.
- **Payment refusals.** A `PaymentRequiredError` (402) on a write is answered
  as 403 to the client (which shows its normal "couldn't save" error), and the
  terminal prints the code and the upgrade link once per code.

### Never uploaded

- **OS and editor junk** is accepted from the client but kept only in a
  per-session in-memory scratch store, never written to the VFS: `.DS_Store`,
  `._*`, `.Spotlight-V100`, `.Trashes`, `.fseventsd`, `.TemporaryItems`,
  `Thumbs.db`, `desktop.ini`, `~$*` (Office owner files), `.~lock.*#`, `*.swp`
  / `*.swx` / `4913` (vim), `.goutputstream-*`. A GET of one serves the scratch
  copy if present, else 404. This also stops Finder's thousands of `._` probes
  from reaching the network.
- **Refused paths**: the mirror's never-sync set (`cli/src/lib/mount.js:267`,
  `.git`, `.ssh`, `.muhkoo`, credential and shell files…) is **moved into a
  shared module** used by both commands, and refused (403) on write by
  `serve`. Reading them is allowed (they are the user's own files).

### Cache

- **Content** is cached as the **encrypted shards** it is stored as, keyed by
  shard hash, under `~/.muhkoo/cache/shards/` (0700). No decrypted content is
  ever written to disk by `serve`.
- Capped at `--cache-size` (default 2 GB), least-recently-used out first,
  checked on insert. The cap is shared by every `serve` process.
- **Listings** are cached in memory only (see Reading).

### Mount commands printed at startup

- **macOS:** `mkdir -p ~/Muhkoo && mount_webdav -S http://127.0.0.1:4915/<secret>/ ~/Muhkoo`, or Finder → Go → Connect to Server.
- **Windows:** `net use M: http://127.0.0.1:4915/<secret>/`. Plus a warning: the
  WebClient service refuses files over 50 MB by default; raise
  `HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters\FileSizeLimitInBytes`
  (max 4294967295) and restart WebClient. The one-line `reg add` is printed.
- **Linux:** `gio mount dav://127.0.0.1:4915/<secret>/`, or davfs2.

## SDK additions (connect)

- **`vfs.readRange(path, start, endExclusive): Promise<Uint8Array>`** — reads
  only the chunks covering the range, via the file's manifest (chunk index =
  `floor(offset / chunkSize)`), verifying each chunk as a full read does.
  Ranges past the end are clamped; `start >= size` returns empty. Exported on
  every build surface (browser, server, workers).
- **Read-ahead** in `FileStorage.readFileFromShards` / `readChunksFromShards`:
  up to 2 chunks fetched ahead of the one being decoded. Peak memory stays
  bounded (at most 3 chunks in flight for the stream variant). This is the
  large-file speed-up the mirror needs too.
- **A shard cache hook for Node**: the client takes an optional persistent
  shard store (get/put by hash, ciphertext only); `serve` passes its disk
  cache. If the existing browser cache abstraction already fits, reuse it.

The connect change ships in a release before the CLI that uses it.

## Code layout (cli)

- `src/commands/vfs.js` — the `serve` subcommand: args, startup output.
- `src/lib/serve/server.js` — the `http` server, secret check, routing.
- `src/lib/serve/dav.js` — the method handlers and PROPFIND XML.
- `src/lib/serve/locks.js` — the in-memory lock table.
- `src/lib/serve/junk.js` — junk patterns and the scratch store.
- `src/lib/serve/shardCache.js` — the disk cache with its LRU cap.
- `src/lib/trash.js` — the freedesktop Trash writer.
- `src/lib/paths.js` — the never-sync set, moved out of `mount.js`.

No new runtime dependencies.

## Testing

Unit (TDD, cli and connect):
- `readRange`: start and end mid-chunk, exact chunk boundaries, one byte, the
  last byte, empty, past the end; only the covering chunks fetched.
- Read-ahead: order preserved, bounded in-flight count, a failed chunk fails
  the read.
- WebDAV against an in-memory fake VFS: PROPFIND XML (escaping, Unicode, depth
  0/1, depth infinity refused), GET/HEAD/Range (200, 206, 416), PUT creates a
  version, MKCOL, MOVE and COPY with and without `Overwrite`, DELETE into Trash
  (and the info file parses with the web drive's rules), delete inside
  `/.trash` refused, LOCK/UNLOCK and conflicting writers, junk kept local,
  refused paths, 402 → 403 with one terminal line, read-only mode.
- Secret: a wrong or missing secret is 404; `..`, `%2e%2e`, encoded slashes
  and backslashes cannot leave the served path.
- Shard cache: the cap, LRU order, nothing but ciphertext on disk, 0600/0700
  modes.

Real clients, on **staging**, with a throwaway account:
- macOS (Finder and `mount_webdav`): browse; open a PDF and a large video
  (scrubbing fetches only nearby chunks); save from TextEdit; rename; delete,
  then see it in the web drive's Trash and restore it; git status and an editor
  on a small project, to record what to expect.
- Linux: `gio mount` in a container: list, read, save, rename, delete.
- Windows: not runnable here. A checklist for Matt (`net use`, open, save,
  delete, the 50 MB limit and its fix); until it is run, Windows is documented
  as untested.

## Rollout

1. connect: `readRange`, read-ahead, the shard-store hook → staging-tested →
   release (npm, on Matt's ask).
2. cli: `serve`, the shared modules, the parallel mirror → release (npm, on
   Matt's ask), pinning that connect.
3. Docs: a "Mount your drive" section in `docs/guides/cli.mdx` (when to use
   `serve` vs `mount`, per-OS steps, the Windows limit); `readRange` in the VFS
   reference; connect and cli CHANGELOGs.

## Out of scope

Running as a background service or at login; an NFS mode; native per-OS
apps; serving several roots from one process; emptying the Trash from the
mounted drive.
