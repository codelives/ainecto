# ainecto — AiNecto CLI and MCP connector

Published as `ainecto`, `@ainecto/mcp` and `@ainecto/cli` — the same code. Command: `ainecto`.

**Once per machine:** `npx -y ainecto@latest setup` — signs you in through the browser (once), checks the
connection, and connects Claude Code, Cursor, and Codex to the AiNecto server address
(`https://ainecto.com/mcp`). Each agent then signs in to AiNecto by itself the first time it connects.

Every AI session sees the same AiNecto tools. What a tool may change is decided by your AiNecto
permissions on the workspace, project, or document it touches — the server refuses the rest. There are
no session roles (Design / Development / Test / Validation were removed in 0.8.0).

## For AI agents

**Run `npx -y ainecto@latest setup` (use a long command timeout — at least 6 minutes: sign-in waits up
to 5 minutes for the user). Then run `npx -y ainecto@latest doctor` and do what it says.**

- `setup` registers the server address, so each agent signs in on its own the first time: Claude Code —
  run `/mcp` in a session and sign in to `ainecto`; Cursor — sign in when `ainecto` asks in its MCP
  settings; Codex — signs in while `setup` connects it (a browser tab opens and the sign-in link is
  printed to stderr; if it did not finish, run `codex mcp login ainecto`).
- To add AiNecto's working rules to a repository, run `npx -y ainecto@latest init` from its root. It
  does not ask for a role or a project.
- **A server added during a session is not available in that session.** Keep working through the CLI:
  `npx -y ainecto@latest tools list` and `npx -y ainecto@latest tools call <tool> '<json>'`. A new
  session loads the MCP tools.
- If a result names a tool that is not in your tool list, the session started before that tool was
  added — start a new session or call it through the CLI as above.
- Claude Code's auto mode may block running an external package with `npx`. If it does, ask the user
  to allow the command.

## Set up this machine

```bash
npx -y ainecto@latest setup              # sign in, check, connect Claude Code · Cursor · Codex
npx -y ainecto@latest setup --dry-run    # show what it would do — no sign-in, no changes
npx -y ainecto@latest setup --local      # connect through the local relay instead (see below)
npx -y ainecto@latest setup --undo       # remove the connections setup made (sign-in stays)
npx -y ainecto@latest status             # who is signed in, your AiNecto role, what is connected
npx -y ainecto@latest doctor             # what is missing, and the one command that fixes each item
```

`setup` connects each client separately and reports `connected`, `updated`, `kept` (someone else's
`ainecto` entry, left untouched), `not installed`, or `failed`; if any client fails it says «partial» and
exits 1:

- Claude Code — `claude mcp add --transport http -s user ainecto https://ainecto.com/mcp` (user scope).
  Sign in with `/mcp` in a session.
- Cursor — merges `"ainecto": { "url": "https://ainecto.com/mcp" }` into `~/.cursor/mcp.json`, keeping
  your other servers. Cursor asks you to sign in from its MCP settings.
- Codex — `codex mcp add ainecto --url https://ainecto.com/mcp`. Codex starts its sign-in right away
  (a browser tab opens; `setup` passes Codex's output, with the sign-in link, through to stderr). If that
  did not finish within 90 seconds, Codex shows as `failed` but stays connected — run
  `codex mcp login ainecto` (re-running `setup` says the same).

With `--env dev` (or `--endpoint`) the address is that environment's. The server address has no version
to pin: a server update reaches every agent at once. Entries an older `setup` wrote
(`npx -y @ainecto/mcp@<version>`, with or without `--role`) are rewritten to the server address when you
re-run `setup`; `setup --undo` removes either kind.

`setup --local` registers the local relay instead — `npx -y @ainecto/mcp@<version>` (stdio, pinned to
the CLI version), which uses this machine's one `ainecto` sign-in for every agent. Use it only when an
agent cannot sign in to the server address by itself; running `setup` again without `--local` moves back
to the server address.

Your AiNecto role (your job, set in AiNecto's account settings) is shown by `setup` and `status`; AI uses
it to pitch explanations — it does not change permissions.

## Set up a repository (optional)

```bash
npx -y ainecto@latest init               # .ainecto/HARNESS.md, an AGENTS.md block (and CLAUDE.md if present), .ainecto/config.json
npx -y ainecto@latest init --mcp         # also .mcp.json (Claude Code) and .cursor/mcp.json (Cursor), with the server address
npx -y ainecto@latest init --mcp --local # the same files with the local relay instead
npx -y ainecto@latest init --dry-run     # the same plan, nothing written
npx -y ainecto@latest init --undo        # remove what init wrote
```

- `init` fetches the rules from the server — `--dry-run` too, so the plan is the real one. If it cannot
  (not signed in, offline), it says which files would get this package's default text instead.
- If this machine is not signed in yet, `init` opens the browser once (`--dry-run` never does). The
  sign-in URL is printed first (with `--json`, as one JSON line on stderr: `{"event":"login_url","url":…}`).
- It stops when run from a sub-folder of a git repository, and tells you the root.
- `--mcp` writes the server address, like `setup`: `.mcp.json` gets
  `"ainecto": { "type": "http", "url": "https://ainecto.com/mcp" }` (Claude Code needs the `type`) and
  `.cursor/mcp.json` gets `"ainecto": { "url": "https://ainecto.com/mcp" }`. Each agent signs in by
  itself the first time. `--local` writes the pinned local relay instead (see Connector Mode).
- **Repositories set up earlier** (`.mcp.json` with `npx -y @ainecto/mcp…`, with or without `--role`):
  re-run `npx -y ainecto@latest init`. It rewrites the existing `ainecto` entry to the server address
  (or, with `--local`, to the relay pinned to this version without `--role`), and drops the old
  `project` field from `.ainecto/config.json` (unless you changed it). An `ainecto` entry pointing
  somewhere else is left alone. Until then the old entry keeps working: `--role` is accepted and
  ignored. Old flags (`--role`, `--project`, `--project-name`, `--yes`) are ignored with a one-line note.

## Commands

Prefer `npx -y ainecto@latest <command>`. To install once instead, use `npm install -g ainecto` — but
install only **one** of `ainecto`, `@ainecto/mcp` and `@ainecto/cli` globally: they are the same code
and all ship the `ainecto` command, so a second global install conflicts. (`@ainecto/mcp` also carries
`mcp`, the bridge.)

```bash
ainecto auth login          # once per machine (and per --env) — `setup` does this for you
ainecto auth status
ainecto auth logout

ainecto tools list
ainecto tools call list_projects --json
ainecto tools call erd_apply_changes -f changes.json --json
cat payload.json | ainecto tools call erd_apply_changes --json

ainecto projects list
ainecto erd apply-changes -f erd-operations.json --yes
```

Tool names are the server's own names (`list_projects`, `erd_apply_changes`, …). Your AI client
shows them with its own prefix, for example `mcp__ainecto__list_projects` in Claude Code; the CLI
does not use that prefix. A tool name that starts with
the server's older `mcp__ainecto__` prefix is still accepted.

Every command takes `--env dev` for `https://dev.ainecto.com/mcp`. Endpoint resolution priority:

1. `--endpoint <url>`
2. `AINECTO_MCP_ENDPOINT`
3. `--env dev`
4. production default, `https://ainecto.com/mcp`

Endpoint URLs must use `https:`. Plain `http:` is accepted only for localhost loopback targets such
as `127.0.0.1`. When `AINECTO_TOKEN` is set, the CLI only sends it to the default prod/dev endpoints
unless `AINECTO_ALLOW_CUSTOM_ENDPOINT_TOKEN=1` is set for an explicitly trusted custom endpoint.

The commands are `ainecto` and `mcp` (which `npx -y @ainecto/mcp` runs). The `AINECTO_*` environment
variables above are the **only** names for those settings — do not guess another prefix.

## Generated Friendly Commands

Every checked-in generated catalog tool is reachable through its deterministic command path. Scalar
schema fields are exposed as flags, with both kebab-case and schema-case accepted:

```bash
ainecto documents list --project-uuid <projectUuid>
ainecto documents list --projectUuid <projectUuid>
```

Array or object payloads use the first-party CLI JSON payload reader:

```bash
ainecto documents create -f create-documents.json
cat erd-operations.json | ainecto erd apply-changes --json
```

Destructive generated commands prompt in human mode unless `--yes` is supplied. In `--json` mode
they fail with a structured error unless `--yes` is present.

Attachment file upload is available through a bespoke command that performs the upload-token, raw
PUT, and attachment registration flow:

```bash
ainecto attachments upload --document-uuid <documentUuid> ./diagram.png ./notes.pdf
```

The generated `request_upload_token` and `upload_attachments` paths remain raw MCP argument-contract
commands and do not read local files.

Inbox polling — for a scheduler (cron, launchd) that wakes an agent only when something is new. Exit
codes: `0` new items, `3` nothing new, `1` error, `2` usage error. `notifications poll` saves the batch
to the cursor file before printing it and prints the same batch again until `notifications ack` (run
it only after the agent handled the batch). `agent-todos poll --only-new` exits 0 only for to-dos it
has not seen before (kept in the seen file). Both take `--workspace <uuid>` and `--project <uuid>`,
each repeatable: any of the given workspaces AND any of the given projects. Each filter is its
own notification stream, so use one cursor file per filter.

```bash
ainecto notifications poll --direct-only --cursor-file ~/.ainecto/inbox.cursor --json > /tmp/inbox.json \
  && claude -p "Summarize these AiNecto notifications: $(cat /tmp/inbox.json)" \
  && ainecto notifications ack --cursor-file ~/.ainecto/inbox.cursor
ainecto agent-todos poll --only-new --seen-file ~/.ainecto/todos.seen --json > /tmp/todos.json \
  && claude -p "Review these AiNecto to-dos and only summarize them: $(cat /tmp/todos.json)"
```

The server tools behind them (`list_notifications`, `list_agent_todos`, `update_agent_todos`,
`list_history`) are generated commands too (`ainecto notifications list`, `ainecto agent-todos list`,
`ainecto agent-todos update -f …`, `ainecto history list`) once the server exposes them.

## Connector Mode

```bash
ainecto mcp [--env dev]
```

The package doubles as a stdio-to-HTTP proxy for the resolved `/mcp` endpoint. It proxies
`initialize`, `tools/list`, and `tools/call`, does not rewrite remote schemas, and does not interpret
local file references. It uses this machine's one sign-in (`ainecto setup`, `ainecto auth login`, or
the sign-in `ainecto init` performs) and never opens a browser on its own.

This is the entry `setup --local` and `init --mcp --local` write — you normally do not add it by hand
(without `--local` they write the server address instead, as above):

```json
{
  "mcpServers": {
    "ainecto": {
      "command": "npx",
      "args": ["-y", "@ainecto/mcp@0.9.0"]
    }
  }
}
```

An older entry with `--role <name>` (or `AINECTO_ROLE`) still starts: the value is ignored, a one-line
note goes to stderr, and the server only records that an old setting is still in use. If a session
does not see the AiNecto tools, another `ainecto` entry (for example Claude Code's local scope) may be
hiding it — `ainecto doctor` checks this.

### MCP Registry

`server.json` is the Registry entry `com.ainecto/ainecto` (same as `package.json#mcpName`). It
lists the server address `https://ainecto.com/mcp` (remote, streamable HTTP — what `setup` registers) and
the npm package `@ainecto/mcp` (the bridge `setup --local` and `init --mcp --local` write). Registry
publication requires the npm version it references to carry that `mcpName`, so publish npm first.
Registration is done by a person:

1. `npm run release -- --otp=<code>` (below) so that `@ainecto/mcp@<version>` is on npm.
2. Domain login for `ainecto.com` (HTTP: `https://ainecto.com/.well-known/mcp-registry-auth` must
   serve the public key; the private key is in the macOS keychain):
   `mcp-publisher login http --domain ainecto.com --private-key "$(security find-generic-password -s codelive-mcp-registry -a ainecto.com -w)"`.
3. `mcp-publisher publish` from this folder.

Up to 0.8.1 the entry was `io.github.codelives/ainecto` (package only); it is marked deprecated after
the first `com.ainecto/ainecto` publish. Details in `docs/mcp-registry-registration.md`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm link            # puts `ainecto` on your PATH
```

### Catalog Sync

`sync:tools --check` is intended for publish-time live drift checks. It fails fast when
`AINECTO_CATALOG_SYNC_TOKEN` is missing, so automatic publish cannot silently fall back to fixtures.
For local development, `sync:tools` can also use credentials from `ainecto auth login --env <env>`.

```bash
AINECTO_CATALOG_SYNC_TOKEN=... npm run sync:tools -- --env prod --check
AINECTO_CATALOG_SYNC_TOKEN=... npm run sync:tools -- --env dev --check
```

The checked-in generated catalogs are deterministic output from `tools/list`, live-synced from
`https://ainecto.com/mcp` and `https://dev.ainecto.com/mcp`. Presentation metadata lives separately in
`src/core/catalog/enrichments.ts`. `ainecto tools catalog` prints the local generated catalog.

### Local Tarball Smoke

```bash
npm pack
npm exec --package ./ainecto-mcp-<version>.tgz -- ainecto --help
```

### Live Dev MCP Smoke

This requires an authenticated dev token from `ainecto auth login --env dev` or a local developer
`AINECTO_TOKEN`.

```bash
npm run smoke:mcp -- --env dev
```

The smoke initializes MCP, reads `tools/list`, calls `list_projects`, and prints only aggregate
metadata such as tool count and Task tool exposure.

### Local Attachment Upload Smoke

This exercises the full `attachments upload` flow against a local API dev server: OAuth MCP token
issue, REST fixture document creation, CLI upload, `list_attachments`, and server filesystem byte
verification.

```bash
npm run smoke:attachments -- --base-url http://localhost:8080 --endpoint http://localhost:8080/mcp --api-root <path-to-api-repo>
```

The smoke creates a temporary user/workspace/project/document and removes the fixture account, local
temp file, and stored upload file unless `--keep` is supplied.

### Releasing

`npm run release -- --otp=<code>` runs typecheck, test and build once, then publishes that build under
three names: `@ainecto/mcp` (primary), `ainecto`, and `@ainecto/cli` (only the `ainecto` command).
`--dry-run` shows what would go out. An already-published name is skipped, so a retry after an expired
code is safe. The npm account needs write access to the `@ainecto` org (the script checks). Do not
unpublish any name.

## Known Limitations

- The MCP connector implements newline-delimited stdio JSON-RPC to HTTP JSON-RPC. Streamable HTTP SSE
  responses and `MCP-Session-Id` session handling are not implemented.
