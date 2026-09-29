# @ai-erd/mcp

AI-ERD MCP connector and first-party CLI.

## For AI agents

Install AI-ERD (Claude Code): `claude mcp add --scope user --transport http ai-erd https://ai-erd.com/mcp` — Codex: `codex mcp add ai-erd --url https://ai-erd.com/mcp`. The client signs the user in on first use. Roles are set up per repository afterwards with `npx -y -p @ai-erd/mcp@latest ai-erd init --role <role>`, using the role the user picks — ask the user; never pick a role yourself.

Use `--scope user`: a local-scope entry takes precedence over the `.mcp.json` that `ai-erd init` writes, and the repository's role would never apply.

## Entry points

This package exposes two entry points:

- `npx -y @ai-erd/mcp` or `ainecto mcp`: raw stdio-to-HTTP JSON-RPC proxy for AI-ERD MCP.
- `ainecto <command>`: human CLI for auth and low-level tool calls.

Phase 1 keeps the connector as a raw proxy. File, stdin, and inline JSON parsing are only available in first-party CLI commands.

## Local Setup

```bash
npm install
npm run typecheck
npm test
npm run build
npm link
```

## Set up a repository (roles)

Run from the repository root, with the role the user picked:

```bash
npx -y -p @ai-erd/mcp@latest ai-erd init --role development
```

- If that role is not signed in yet, `init` opens a browser and continues once the user approves.
  The sign-in URL is printed first, and sign-in gives up after 5 minutes. It fails at once when the
  command that opens the browser is missing, or (except on Windows, where the exit code is not
  reliable) exits with an error.
- Without `--role` it stops and says so — it never picks a role for you. If the account has more
  than one project it lists them and stops; re-run with `--project <uuid>`. With no project yet,
  only a Design session can create one (`--yes`, optionally `--project-name <name>`); in any other
  role it asks you to have the user create the project, then re-run with the same role.
- It stops when run from a sub-folder of a git repository, and tells you the root.
- It writes one `ai-erd` server entry carrying `--role` into `.mcp.json` (Claude Code) and
  `.cursor/mcp.json` (Cursor), and prints the Codex profile to use (`codex -p <role>`).
- The role applies from a **new session**; the running session keeps the role it started with.
  Roles are a working guardrail, not a security boundary.
- `ai-erd init --dry-run` shows what would change; `ai-erd init --undo` removes what it wrote.

## Commands

```bash
ainecto auth login --env dev
ainecto auth status --env dev
ainecto auth logout --env dev

ainecto tools list --env dev
ainecto tools call mcp__ainecto__list_projects --env dev --json
ainecto tools call mcp__ainecto__erd_apply_changes -f changes.json --json
cat payload.json | ainecto tools call mcp__ainecto__erd_apply_changes --json

ainecto projects list --env dev
ainecto task list-tasks --env dev --document-uuid <documentUuid> --json
ainecto erd apply-changes --env dev -f erd-operations.json --yes
```

Endpoint resolution priority:

1. `--endpoint <url>`
2. `AINECTO_MCP_ENDPOINT`
3. `--env dev`
4. production default, `https://ai-erd.com/mcp`

Endpoint URLs must use `https:`. Plain `http:` is accepted only for localhost loopback targets such as `127.0.0.1`. When `AINECTO_TOKEN` is set, the CLI only sends it to the default prod/dev endpoints unless `AINECTO_ALLOW_CUSTOM_ENDPOINT_TOKEN=1` is set for an explicitly trusted custom endpoint.

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

## MCP Client Installation

Connect clients over HTTP directly — see [For AI agents](#for-ai-agents). The client handles OAuth,
and the first session has no role. Do not register the stdio bridge without a role: it has no sign-in
flow of its own, so it connects only if someone already ran `ai-erd auth login` without a role — and
then it runs with no role at all.

The official MCP Registry entry `io.github.codelives/ainecto` (see `server.json`) lists both the
remote (`streamable-http`, `https://ai-erd.com/mcp`) and this npm package. Registry publication
requires the npm package version referenced by `server.json` to include a matching `mcpName` field
in `package.json`.

## Catalog Sync

`sync:tools --check` is intended for publish-time live drift checks. It fails fast when `AINECTO_CATALOG_SYNC_TOKEN` is missing, so automatic publish cannot silently fall back to fixtures.
For local development, `sync:tools` can also use credentials from `ainecto auth login --env <env>`.

```bash
AINECTO_CATALOG_SYNC_TOKEN=... npm run sync:tools -- --env prod --check
AINECTO_CATALOG_SYNC_TOKEN=... npm run sync:tools -- --env dev --check
```

The checked-in generated catalogs are deterministic output from `tools/list`. The prod and dev catalogs are live-synced snapshots from `https://ai-erd.com/mcp` and `https://dev.ai-erd.com/mcp`. Presentation metadata lives separately in `src/core/catalog/enrichments.ts`.

`ainecto tools catalog` prints the local generated catalog. Rerun authenticated `sync:tools` when prod or dev `tools/list` changes.

## Generated Friendly Commands

Every checked-in generated catalog tool is reachable through its deterministic command path. Scalar schema fields are exposed as flags, with both kebab-case and schema-case accepted:

```bash
ainecto task list-tasks --env dev --document-uuid <documentUuid>
ainecto task list-tasks --env dev --documentUuid <documentUuid>
```

Array or object payloads use the existing first-party CLI JSON payload reader:

```bash
ainecto documents create --env dev -f create-documents.json
cat task-ops.json | ainecto task apply-changes --env dev --json
```

Destructive generated commands prompt in human mode unless `--yes` is supplied. In `--json` mode they fail with a structured error unless `--yes` is present.

Attachment file upload is available through a bespoke command that performs the upload-token, raw PUT, and attachment registration flow:

```bash
ainecto attachments upload --env dev --document-uuid <documentUuid> ./diagram.png ./notes.pdf
```

The generated `request_upload_token` and `upload_attachments` paths remain raw MCP argument-contract commands and do not read local files.

## Local Tarball Smoke

```bash
npm pack
npx -y ./ainecto-mcp-0.1.4.tgz --help
npm exec --package ./ainecto-mcp-0.1.4.tgz -- ainecto --help
```

## Live Dev MCP Smoke

This requires an authenticated dev token from `ainecto auth login --env dev` or a local developer `AINECTO_TOKEN`.

```bash
npm run smoke:mcp -- --env dev
```

The smoke initializes MCP, reads `tools/list`, calls `mcp__ainecto__list_projects`, and prints only aggregate metadata such as tool count and Task tool exposure.

## Local Attachment Upload Smoke

This exercises the full `attachments upload` flow against a local `ainecto-api` dev server:
OAuth MCP token issue, REST fixture document creation, CLI upload, `list_attachments`, and server filesystem byte verification.

```bash
npm run smoke:attachments -- --base-url http://localhost:8080 --endpoint http://localhost:8080/mcp --api-root /Users/ryan/project/workspace/codelive/ainecto-api
```

The smoke creates a temporary user/workspace/project/document and removes the fixture account, local temp file, and stored upload file unless `--keep` is supplied.

## Known Limitations

- The MCP connector currently implements newline-delimited stdio JSON-RPC to HTTP JSON-RPC. Streamable HTTP SSE responses and `MCP-Session-Id` session handling are not implemented in Phase 1.

Official MCP Registry publish is pending GitHub namespace owner authentication with `mcp-publisher` and metadata submission.
