# @muhkoo/cli

The command-line interface for the [Muhkoo](https://muhkoo.dev) platform. Provision
app backends, deploy hosted clients, and manage agents, functions, databases, and
custom domains — everything the Muhkoo app builder does, from your terminal.

Built on top of [`@muhkoo/connect`](https://www.npmjs.com/package/@muhkoo/connect).

## Install

```bash
npm install -g @muhkoo/cli@alpha
# or run without installing:
npx @muhkoo/cli@alpha --help
```

The **`alpha`** and **`latest`** tags both point at the newest alpha, and the
CLI is released in lockstep with `@muhkoo/connect`.

Requires Node.js 20+.

## Quickstart

```bash
# 1. Sign in (zero-knowledge login — your password never leaves the machine)
muhkoo login

# 2. Create an app and provision its backend from a spec
muhkoo apps create --slug my-app --email you@example.com
muhkoo provision --spec app.json

# 3. Build your client, deploy to the test env, then promote to production
muhkoo deploy
muhkoo promote
```

`provision` writes `.muhkoo-app.json` (app id + keys). `deploy` reads it, so once an
app is provisioned every command runs with no extra flags. `deploy` publishes to the
app's **test** environment; once it looks right on the test URL, `promote` copies that
release onto **production**, in place.

## Sign in

```bash
muhkoo login --web      # opens auth.muhkoo.dev in your browser (recommended)
muhkoo login            # zero-knowledge login from the terminal (prompts)
```

`--web` opens the hosted sign-in page, you authenticate however you like (password,
passkey, or Google), and the CLI captures the session over a one-time `localhost`
redirect — your credentials never touch the CLI. The terminal flow runs the
zero-knowledge login locally; your password still never leaves your machine.

## Authentication

Most commands use your **developer session**, established by `muhkoo login` and stored
in `~/.muhkoo/config.json`. You can override per-invocation:

| Source | How |
| --- | --- |
| Flag | `--token <sessionToken>` |
| Env | `MUHKOO_DEV_TOKEN` |
| Stored | written by `muhkoo login` |

`deploy` also accepts an app **secret key** (`--key mk_*_sk_*` or `MUHKOO_DEPLOY_KEY`),
which is what CI typically uses.

### Paired machines

Commands that open your encrypted filesystem (`vfs`, `vcs`, and `devices`
itself) need the master seed as well as a session, and the seed is never stored
on disk. The first such command signs you in once and **pairs this machine**: it
generates a key here,
asks the vault to hold your seed wrapped under it, and keeps only the key. So
nothing on this disk is the seed, and the pairing can be withdrawn from anywhere
— which a stored seed never could be, because nothing can reach out and un-store
it.

```bash
muhkoo devices ls              # paired machines; the current one is marked
muhkoo devices rm <factorId>   # withdraw access — takes effect immediately
```

Revoking the machine you are on also clears its now-useless local key, so the
next filesystem command pairs again from scratch rather than retrying a pairing
the server has forgotten. `MUHKOO_SEED` bypasses pairing entirely, for CI, where
there is no interactive login to pair with. `--no-pair` signs in for one command
and stores nothing. (In 0.14.0-alpha.8 the flag was ignored, and the machine
was paired anyway.)

## Environments

`--base` selects the API base for any command:

```bash
muhkoo apps ls --base staging
muhkoo deploy  --base local      # http://localhost:8787
muhkoo whoami  --base https://api.example.com
```

`prod` is the default. The chosen base is remembered by `muhkoo login`.

## Commands

```
Account     login · logout · devices ls|rm · whoami
Apps        apps ls|get|create|slug|rm · keys rotate · tokens ls|create|revoke
Backend     provision · tables · agents · functions
Files       vfs cd|pwd|ls|stat|tree|cat|put|get|mkdir|rm|cp|mv|find|history|restore
            vfs import|mount|ignore · vfs sweep|use-app|app
            vcs status|commit|log|show|diff|branch|switch|checkout|merge|restore · vcs merge --abort
            kv ls [prefix]
Hosting     deploy · promote · hosting status|rollback|rm-release|unpublish · domains
Tools       logs · eject
```

Run `muhkoo <command> --help` for details. A few highlights:

```bash
muhkoo apps ls                                  # list your apps
muhkoo provision --spec app.json --dry-run      # preview API calls
muhkoo provision --spec app.json --enable       # enable agents/functions on channels
muhkoo deploy                                   # publish dist/ to the test env
muhkoo promote                                  # promote test → production, in place
muhkoo hosting status <appId>                   # releases + current pointer
muhkoo hosting rollback <appId> --release <id>  # instant rollback
muhkoo domains add <appId> app.example.com      # attach a custom domain
muhkoo agents enable <appId> <agentId> --channel general
muhkoo eject src/agent/agentApp.ts              # preview an agent's prompt + tools
```

## Syncing a directory

This section describes 0.14.0-alpha.9. In 0.14.0-alpha.8,
`vfs ignore [dir] [--write]` only drafts a `.vcsignore`, with no `--accept` or
`--draft`, and `import` runs the full two-way sync: it writes remote files
into the project, and with `--allow-delete` it deletes local files too.

```bash
muhkoo vfs import ./my-app --dry-run            # what would upload, and what import skips
muhkoo vfs import ./my-app                      # upload once, to /apps/<slug>
muhkoo vfs mount ./my-app --path /apps/my-app --dry-run   # what mounting would do
muhkoo vfs mount ./my-app --path /apps/my-app   # two-way sync, live until Ctrl-C
muhkoo vfs ignore ./my-app                      # what earlier ignore rules still hold back
muhkoo vfs ignore ./my-app --accept             # preview an accept, and its digest
muhkoo vfs ignore ./my-app --accept <digest>    # accept exactly the files you previewed
```

`import` uploads whole projects once, then stops. It only uploads: it never
writes or deletes anything on this disk. Each directory goes to `/apps/<slug>`,
where `<slug>` comes from its `.muhkoo-app.json`, or failing that its own name.
If any directory fails, the rest are still tried and the command exits 1.
`--dry-run` works for both. For `import` it lists what would upload; for `mount`
it lists what mounting would download, upload and delete, then stops without
syncing or watching. Neither writes anything, not even for a moment: not in the
directory, not under `~/.muhkoo`, and not in your filesystem. A dry run does not
pair this machine either; if it is not paired yet, you sign in for that one
command. (In 0.14.0-alpha.8, `mount` ignored `--dry-run` and mounted for real.)

`mount` keeps one directory in sync with your filesystem until you stop it.
`--path` defaults to `/`, your whole filesystem, so pass the subtree you mean.
Ctrl-C, SIGTERM or closing the terminal stops it after the current file and
saves its state. A second Ctrl-C quits at once (exit code 130), which is safe
because every file lands by renaming a temp file into place.

What syncs is decided by a root `.vcsignore` if there is one. Otherwise git's
rules apply in full: every `.gitignore`, each scoped to its own directory, and
`.git/info/exclude`. Built-in Node defaults sit underneath either way (build
output, logs, `.env` and `.env.*`, but not `.env.example`). Dot-files, other
than `.vcsignore` and `.gitignore` files, are skipped unless you pass
`--hidden`. `muhkoo vfs ignore <dir> --draft` prints a `.vcsignore` drafted
from all of them.

### What mount and import protect against

Every app you sign into holds your master seed, so any of them can write your
filesystem, and so choose the paths, names and bytes that `mount` brings down.
Everything read from your filesystem is therefore treated as untrusted input,
and it cannot reach this disk except through these checks:

- **Some paths never sync, in either direction.** No flag and no ignore rule
  changes that: `.git`, `.ssh`, `.muhkoo`, `node_modules`, `.husky`, editor and
  agent directories (`.vscode`, `.idea`, `.config`, `.claude`, `.cursor`,
  `.zed`, `.fleet`), and credential and shell start-up files (`.envrc`,
  `.npmrc`, `.netrc`, `.gitconfig`, `.profile`, `.bashrc`, `.zshrc`, `.zshenv`
  and the rest). Each one either holds credentials or can run code without an
  execute bit. Names are compared the way a case-folding volume would compare
  them, so `Node_Modules`, `.GIT` and `GIT~1` are refused too.
- **Never your home directory.** Both commands refuse the filesystem root, your
  home directory, and anything that contains it. There is no override.
- **One write boundary.** Every write and delete on disk checks each part of
  the path: no symlinks, no alternative spellings, and no replacing a local
  file that is not synced. A new file never gets an execute bit.
- **An edit to an ignore file cannot widen what syncs.** A new exclusion
  applies at once. A loosening, whether you made it or it arrived from your
  filesystem, waits until `muhkoo vfs ignore <dir> --accept <digest>` accepts
  exactly the files you previewed. Each change to the rules since the last
  accept is kept as another set, up to 64 sets or 2 MB. Past that, or if the
  stored rules cannot be read, nothing syncs until you accept.
- **Deletes are off by default, in both directions.** A delete removes the
  file's history too, so unlike an overwrite it cannot be undone.
  `--allow-delete` trusts the remote side. A pass that would delete more than 3
  files and leave fewer than half of those it has tracked, or delete anything
  when the other side is empty, deletes nothing in that direction and says why.
  That guard catches a missing or renamed root, not whatever can write your
  filesystem.
- **Each pass is bounded.** Files over 100 MB are skipped. One pass of `mount`
  pulls at most 2 GiB or 10,000 files and reads at most as much to compare. A
  pull waits when it would leave less than 5% of the disk free (at least 1 GiB,
  at most 10 GiB). A size your filesystem reports can only get a file skipped
  or held sooner: the size limit, the pull budget and the reserve are checked
  again against the bytes that arrive.
- **Remote text is escaped** before it reaches your terminal, so a planted
  file name or commit message cannot send control sequences.

What this does not cover: ordinary project files, such as source, scripts,
`bin/` and package-manager configs, still sync in both directions, so an app
holding your seed can change code that you later run. Anything you upload can
be read by every app you sign into. The root cause, apps being handed your
master seed at sign-in, is not fixed yet.

If you used `--hidden` with 0.14.0-alpha.8 or earlier, it may have uploaded
`.git/`, `.npmrc`, `.netrc` and similar files, and `.env` files if an ignore
file negated the default `.env` rules. Check with `muhkoo vfs tree`, remove
them with `muhkoo vfs rm -r`, and rotate any token they held. Before the first
run, also look over your ignore files, nested ones included, for lines you did
not write: this version takes whatever is on disk the first time it runs as
your own rules. The [CHANGELOG](./CHANGELOG.md) has the details.

## The provision spec

```jsonc
{
  "slug": "team-standup",
  "allowedOrigins": "*",
  "email": "you@example.com",        // only needed to bootstrap a new developer
  "tables": [
    {
      "table": "tasks",
      "columns": [
        { "name": "title", "type": "text", "nullable": false },
        { "name": "done",  "type": "boolean", "nullable": false, "default": false }
      ]
    }
  ],
  "agents":    [ { "handle": "@helper", "model": "...", "systemPrompt": "...", "enableChannel": "general" } ],
  "functions": [ { "name": "hello", "code": "export default { async fetch() { return new Response('hi'); } }" } ]
}
```

`provision` is idempotent — re-running updates tables/agents/functions in place.

## License

MIT
