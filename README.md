# ai-erd — AI-ERD CLI and MCP connector

Published as `ai-erd` and `@ai-erd/mcp` (same code). Command: `ai-erd`.

**In a terminal, from your repository root:** `npx -y ai-erd@latest init` — it asks which role this
repository's AI sessions should have and which AI-ERD project to use, and signs you in through the
browser if needed.

## For AI agents

**Ask the user which role this repository's AI sessions should have — Design, Development, Test, or Validation. Never pick one yourself. Then, from the repository root: `npx -y ai-erd@latest init --role <role>` (it signs the user in through the browser if needed).**

- Use a long command timeout (at least 6 minutes): sign-in waits up to 5 minutes for the user.
- If `init` lists projects, ask the user which one and re-run with `--project <uuid>`. If it says
  this is not the repository root, re-run from the folder it names.
- The role applies from a **new session**. Tell the user to start one (Claude Code: exit, then
  `claude -c` in this folder to keep the conversation; approve the `ai-erd` server from `.mcp.json`
  when asked). Codex: save the profile `init` prints and start with `codex -p <role>`.
- **A server added during a session is not available in that session.** In our test, a server added
  with `claude mcp add` while Claude Code was running did not attach to the running session. Do not
  tell the user it will work right away — ask them to start a new session. `/mcp` shows what the
  current session actually loaded.
- Claude Code's auto mode may block running an external package with `npx`. If it does, ask the user
  to allow the command.

To connect AI-ERD without a repository role (for example before `init`), add the remote server at
**user scope** — a local-scope entry would hide the `.mcp.json` that `init` writes:

```bash
claude mcp add --scope user --transport http ai-erd https://ai-erd.com/mcp   # Claude Code
codex mcp add ai-erd --url https://ai-erd.com/mcp                            # Codex
```

The client signs the user in on first use. That session has no role until `init` runs and a new
session starts.

## Set up a repository (roles)

```bash
npx -y ai-erd@latest init                     # in a terminal: asks for the role and the project
npx -y ai-erd@latest init --role development  # agents, scripts, CI: nothing is asked
```

In a terminal (stdin and stdout both a TTY, no `--json`) `init` asks for whatever the flags did not
give: the role (by number, with no default — the repository's current role is the default only when
it already has one) and the project (by number; «Create a new project» is offered to Design only).
Ctrl+C or Ctrl+D at a question cancels without writing any file (Ctrl+D exits with 130); choosing
«Create a new project» creates it right away. Anywhere else (an agent's shell, CI) it asks nothing.
In both cases:

- If that role is not signed in yet, `init` opens a browser and continues once the user approves.
  The sign-in URL is printed first (with `--json`, as one JSON line on stderr:
  `{"event":"login_url","url":…,"role":…}`), and sign-in gives up after 5 minutes. It fails at once
  when the command that opens the browser is missing, or (except on Windows, where the exit code is
  not reliable) exits with an error.
- Outside a terminal, without `--role` it stops and says so — it never picks a role for you. If the
  account has more than one project it lists them and stops; re-run with `--project <uuid>`. With no project yet,
  only a Design session can create one (`--yes`, optionally `--project-name <name>`); in any other
  role it asks you to have the user create the project, then re-run with the same role.
- It stops when run from a sub-folder of a git repository, and tells you the root.
- It writes one `ai-erd` server entry carrying `--role` into `.mcp.json` (Claude Code) and
  `.cursor/mcp.json` (Cursor), and prints the Codex profile to use (`codex -p <role>`).
- The role applies from a **new session**; the running session keeps the role it started with.
  Roles are a working guardrail, not a security boundary.
- `ai-erd init --dry-run` shows what would change (it does not sign in or refresh a sign-in);
  `ai-erd init --undo` removes what it wrote.

## Commands

Prefer `npx -y ai-erd@latest <command>`. To install once instead, use `npm install -g ai-erd` — but install
only one of `ai-erd` and `@ai-erd/mcp` globally: they ship the same command names and conflict.

```bash
ai-erd auth login --role design
ai-erd auth status --role design
ai-erd auth logout --role design

ai-erd --role design tools list
ai-erd --role design tools call list_projects --json
ai-erd --role design tools call erd_apply_changes -f changes.json --json
cat payload.json | ai-erd --role design tools call erd_apply_changes --json

ai-erd --role design projects list
ai-erd --role design erd apply-changes -f erd-operations.json --yes
```

Pass the role you signed in with (`--role`, or `AI_ERD_ROLE`); each role has its own sign-in.
Tool names are the server's own names (`list_projects`, `erd_apply_changes`, …). Your AI client
shows them with its own prefix, for example `mcp__ai-erd__list_projects` in Claude Code; the CLI
does not use that prefix. The older `mcp__ainecto__…` form is still accepted.

Every command takes `--env dev` for `https://dev.ai-erd.com/mcp`. Endpoint resolution priority:

1. `--endpoint <url>`
2. `AINECTO_MCP_ENDPOINT`
3. `--env dev`
4. production default, `https://ai-erd.com/mcp`

Endpoint URLs must use `https:`. Plain `http:` is accepted only for localhost loopback targets such
as `127.0.0.1`. When `AINECTO_TOKEN` is set, the CLI only sends it to the default prod/dev endpoints
unless `AINECTO_ALLOW_CUSTOM_ENDPOINT_TOKEN=1` is set for an explicitly trusted custom endpoint.

The MCP Registry name `io.github.codelives/ainecto` still says `ainecto` and is kept for
compatibility. The commands are `ai-erd` and `ai-erd-mcp` (plus `mcp`, which `npx -y @ai-erd/mcp`
runs). The `AINECTO_*` environment variables
above are the **only** names for those settings — there is no `AI_ERD_*` equivalent, so do not guess
one. (The one `AI_ERD_*` variable is `AI_ERD_ROLE`.)

## Generated Friendly Commands

Every checked-in generated catalog tool is reachable through its deterministic command path. Scalar
schema fields are exposed as flags, with both kebab-case and schema-case accepted:

```bash
ai-erd --role design documents list --project-uuid <projectUuid>
ai-erd --role design documents list --projectUuid <projectUuid>
```

Array or object payloads use the first-party CLI JSON payload reader:

```bash
ai-erd --role design documents create -f create-documents.json
cat erd-operations.json | ai-erd --role design erd apply-changes --json
```

Destructive generated commands prompt in human mode unless `--yes` is supplied. In `--json` mode
they fail with a structured error unless `--yes` is present.

Attachment file upload is available through a bespoke command that performs the upload-token, raw
PUT, and attachment registration flow:

```bash
ai-erd --role design attachments upload --document-uuid <documentUuid> ./diagram.png ./notes.pdf
```

The generated `request_upload_token` and `upload_attachments` paths remain raw MCP argument-contract
commands and do not read local files.

## Connector Mode

```bash
ai-erd mcp --role <design|development|test|validation> [--env dev]
```

The package doubles as a stdio-to-HTTP proxy for the resolved `/mcp` endpoint. It proxies
`initialize`, `tools/list`, and `tools/call`, does not rewrite remote schemas, and does not interpret
local file references. It uses the sign-in stored for its role (`ai-erd auth login --role <role>`,
or the sign-in `ai-erd init` performs) and never opens a browser on its own.

This is the entry `ai-erd init` writes into a repository's MCP config — you normally do not add it
by hand:

```json
{
  "mcpServers": {
    "ai-erd": {
      "command": "npx",
      "args": ["-y", "@ai-erd/mcp", "--role", "development"]
    }
  }
}
```

Do not register the stdio bridge without a role: it has no sign-in flow of its own, so it connects
only if someone already ran `ai-erd auth login` without a role — and then it runs with no role at all.

The official MCP Registry entry (see `server.json`) lists both the remote (`streamable-http`,
`https://ai-erd.com/mcp`) and the `@ai-erd/mcp` npm package. Registry publication requires the npm
package version referenced by `server.json` to include a matching `mcpName` field in `package.json`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm link            # puts `ai-erd` on your PATH
```

### Catalog Sync

`sync:tools --check` is intended for publish-time live drift checks. It fails fast when
`AINECTO_CATALOG_SYNC_TOKEN` is missing, so automatic publish cannot silently fall back to fixtures.
For local development, `sync:tools` can also use credentials from `ai-erd auth login --env <env>`
(without a role).

```bash
AINECTO_CATALOG_SYNC_TOKEN=... npm run sync:tools -- --env prod --check
AINECTO_CATALOG_SYNC_TOKEN=... npm run sync:tools -- --env dev --check
```

The checked-in generated catalogs are deterministic output from `tools/list`, live-synced from
`https://ai-erd.com/mcp` and `https://dev.ai-erd.com/mcp`. Presentation metadata lives separately in
`src/core/catalog/enrichments.ts`. `ai-erd tools catalog` prints the local generated catalog.

### Local Tarball Smoke

```bash
npm pack
npm exec --package ./ai-erd-mcp-<version>.tgz -- ai-erd --help
```

### Live Dev MCP Smoke

This requires an authenticated dev token from `ai-erd auth login --env dev` or a local developer
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

`npm run release -- --otp=<code>` publishes the same build as `@ai-erd/mcp` and `ai-erd`
(`--dry-run` shows what would go out). An already-published name is skipped, so a retry after an
expired code is safe.

## Known Limitations

- The MCP connector implements newline-delimited stdio JSON-RPC to HTTP JSON-RPC. Streamable HTTP SSE
  responses and `MCP-Session-Id` session handling are not implemented.
- Official MCP Registry publication is pending GitHub namespace owner authentication with
  `mcp-publisher`.
