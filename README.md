# ainecto — AiNecto CLI and MCP connector

Published as `ainecto`, `@ainecto/mcp` and `@ainecto/cli` — the same code. Command: `ainecto`.

**In a terminal, from your repository root:** `npx -y ainecto@latest init` — it asks which role this
repository's AI sessions should have and which AiNecto project to use, and signs you in through the
browser if needed.

## For AI agents

**Ask the user which role this repository's AI sessions should have — Design, Development, Test, or Validation. Never pick one yourself. Then, from the repository root: `npx -y ainecto@latest init --role <role>` (it signs the user in through the browser if needed).**

- Use a long command timeout (at least 6 minutes): sign-in waits up to 5 minutes for the user.
- If `init` lists projects, ask the user which one and re-run with `--project <uuid>`. If it says
  this is not the repository root, re-run from the folder it names.
- **No restart is needed.** Right after `init`, keep working in the same session through the CLI:
  `ainecto` commands run from the repository read its role on every call (read `.ainecto/HARNESS.md`,
  then `ainecto tools list` and `ainecto tools call <tool> '<json>'`). Do not use MCP tools the session
  started with for that work — they keep the role (or no role) the session started with.
- A new session is optional and only adds the role's MCP tools (Claude Code: exit, then `claude -c`
  in this folder to keep the conversation; approve the `ainecto` server from `.mcp.json` when asked).
  Codex: save the profile `init` prints and start with `codex -p <role>`.
- **A server added during a session is not available in that session.** In our test, a server added
  with `claude mcp add` while Claude Code was running did not attach to the running session — that is
  why the CLI is the way to keep going. `/mcp` shows what the current session actually loaded.
- Inside the repository, `ainecto` commands (`ainecto tools call …`) use the repository's role
  automatically — do not pass `--role`; a different `--role` is refused.
- Claude Code's auto mode may block running an external package with `npx`. If it does, ask the user
  to allow the command.

To connect AiNecto without a repository role (for example before `init`), add the remote server at
**user scope** under the name `ainecto` — a local-scope entry would hide the `.mcp.json` that `init`
writes, and a different name would sit next to it as a second server with no role:

```bash
claude mcp add --scope user --transport http ainecto https://ainecto.com/mcp  # Claude Code
codex mcp add ainecto --url https://ainecto.com/mcp                           # Codex
```

The client signs the user in on first use. That session has no role until `init` runs and a new
session starts.

## Set up a repository (roles)

```bash
npx -y ainecto@latest init                     # in a terminal: asks for the role and the project
npx -y ainecto@latest init --role development  # agents, scripts, CI: nothing is asked
```

In a terminal (stdin and stdout both a TTY, no `--json`, and not under an agent or CI — `CLAUDECODE`,
`CI`, `GEMINI_CLI`, `CODEX_SANDBOX`, `CURSOR_AGENT`) `init` asks for what was not given:
- the role, unless `--role` or `AINECTO_ROLE` is set — by number, with no default. The role already
  set on the repository is the default only when there is one (if its agent configs disagree, there
  is no default);
- the project, unless `--project` is set — by number; «Create a new project» is offered to Design only.

Ctrl+C or Ctrl+D at a question cancels without writing repository files (Ctrl+D exits with 130). A
sign-in you already completed stays saved, and choosing «Create a new project» creates it right away.
Anywhere else (an agent's shell, CI) it asks nothing. In both cases:

- If this machine is not signed in to AiNecto yet, `init` opens a browser and continues once the user
  approves — **once per machine** (per server), not per role. The sign-in URL is printed first (with
  `--json`, as one JSON line on stderr: `{"event":"login_url","url":…}`), and sign-in gives up after
  5 minutes. It fails at once
  when the command that opens the browser is missing, or (except on Windows, where the exit code is
  not reliable) exits with an error.
- Outside a terminal, with no `--role`/`AINECTO_ROLE` it uses the role already set on the repository.
  If there is none (or the repository's agent configs disagree) it stops and says to ask the user —
  it never picks a role for you. If the account has more than one project it lists them and stops;
  re-run with `--project <uuid>`. With no project yet,
  only a Design session can create one (`--yes`, optionally `--project-name <name>`); in any other
  role it asks you to have the user create the project, then re-run with the same role.
- It stops when run from a sub-folder of a git repository, and tells you the root.
- It writes one `ainecto` server entry carrying `--role` into `.mcp.json` (Claude Code) and
  `.cursor/mcp.json` (Cursor), and prints the Codex profile to use (`codex -p <role>`).
- `ainecto` commands in the repository use the new role **at once**; MCP tools pick it up in a **new
  session** (a running session's MCP tools keep the role they started with). Roles are a working
  guardrail, not a security boundary.
- `ainecto init --dry-run` shows what would change (it does not sign in or refresh a sign-in);
  `ainecto init --undo` removes what it wrote.

## Commands

Prefer `npx -y ainecto@latest <command>`. To install once instead, use `npm install -g ainecto` — but
install only **one** of `ainecto`, `@ainecto/mcp` and `@ainecto/cli` globally: they are the same code
and all ship the `ainecto` command, so a second global install conflicts. (`@ainecto/mcp` also carries
`mcp`, the bridge.)

```bash
ainecto auth login          # once per machine (and per --env); not per role
ainecto auth status
ainecto auth logout

ainecto tools list
ainecto tools call list_projects --json
ainecto tools call erd_apply_changes -f changes.json --json
cat payload.json | ainecto tools call erd_apply_changes --json

ainecto projects list
ainecto erd apply-changes -f erd-operations.json --yes
```

**The role comes from the repository.** Inside a folder set up with `ainecto init` (the command looks
from the current folder upward for the first `.mcp.json`/`.cursor/mcp.json` with an `ainecto` entry),
every command uses that folder's role without `--role`. A `--role` or `AINECTO_ROLE` that differs from
it is refused — the role changes only with `ainecto init --role <role>`, after asking the user. If the
role there cannot be read (the `@ainecto/mcp` bridge entry without a valid `--role`, configs that
disagree, broken JSON that mentions `ainecto`, a link that points outside the folder), the command
stops. An entry that is not this bridge (for example an HTTP
`url` or `mcp-remote` entry) means no role there. Your home folder itself is never read as a
repository (`~/.cursor/mcp.json` is Cursor's global config). Outside such a folder there is no role
(no restriction), and `--role` narrows it.
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

## Connector Mode

```bash
ainecto mcp --role <design|development|test|validation> [--env dev]
```

The package doubles as a stdio-to-HTTP proxy for the resolved `/mcp` endpoint. It proxies
`initialize`, `tools/list`, and `tools/call`, does not rewrite remote schemas, and does not interpret
local file references. It uses this machine's one sign-in (`ainecto auth login`, or the sign-in
`ainecto init` performs) and never opens a browser on its own. Its role comes only from `--role` (or
`AINECTO_ROLE`) and is sent with every request; the server applies it.

This is the entry `ainecto init` writes into a repository's MCP config — you normally do not add it
by hand:

```json
{
  "mcpServers": {
    "ainecto": {
      "command": "npx",
      "args": ["-y", "@ainecto/mcp", "--role", "development"]
    }
  }
}
```

A bridge without a role has no restriction. If a session inside a set-up repository still has no role,
another `ainecto` entry (for example Claude Code's local scope) is usually hiding the one `init` wrote —
check with `claude mcp get ainecto`. An entry under another name does not hide it but adds a second
server with no role — remove it.

### MCP Registry

`server.json` is the Registry entry `io.github.codelives/ainecto` (same as `package.json#mcpName`). It
lists only the npm package `@ainecto/mcp` — the per-repository role bridge `init` writes. Registry
publication requires the npm version it references to carry that `mcpName`, so publish npm first.
Registration is done by a person:

1. `npm run release -- --otp=<code>` (below) so that `@ainecto/mcp@<version>` is on npm.
2. GitHub org namespace login as a `codelives` org **Owner** — a classic PAT with only `read:org`
   works where the browser login did not: `MCP_GITHUB_TOKEN=<pat> mcp-publisher login github`.
3. `mcp-publisher publish` from this folder.

Listing `https://ainecto.com/mcp` as a remote here, or a `com.ainecto/*` name, would need ainecto.com
domain auth (`mcp-publisher login dns|http --domain ainecto.com`) and is not part of this release.

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
