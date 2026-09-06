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

Ask for the **`alpha`** tag explicitly. `latest` still points at the older
`0.13.2-alpha.0` line, so a bare install gets a CLI without the commands
documented here.

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
there is no interactive login to pair with.

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
Files       vfs ls|cat|put|get|rm|cp|mv|find|history|restore · vcs status|commit|log|diff|branch|switch|merge
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
