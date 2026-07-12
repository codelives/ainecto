# @ainecto/mcp

Ainecto MCP connector and first-party CLI.

This package exposes two entry points:

- `npx -y @ainecto/mcp` or `ainecto mcp`: raw stdio-to-HTTP JSON-RPC proxy for Ainecto MCP.
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
4. production default, `https://ainecto.com/mcp`

## Connector Mode

```bash
npx -y @ainecto/mcp
ainecto mcp --env dev
```

The connector proxies `initialize`, `tools/list`, and `tools/call` to the resolved `/mcp` endpoint. It does not rewrite remote schemas or interpret local file references.

## MCP Client Installation

Use the direct package configuration until the server is published to the official MCP Registry.

```json
{
  "mcpServers": {
    "ainecto": {
      "command": "npx",
      "args": ["-y", "@ainecto/mcp"]
    }
  }
}
```

For a non-production endpoint, pass CLI flags through the package args:

```json
{
  "mcpServers": {
    "ainecto-dev": {
      "command": "npx",
      "args": ["-y", "@ainecto/mcp", "--env", "dev"]
    }
  }
}
```

The planned official Registry server name is `io.github.codelives/ainecto`, backed by the public npm package `@ainecto/mcp`. Registry publication requires the npm package version referenced by `server.json` to include a matching `mcpName` field in `package.json`.

## Catalog Sync

`sync:tools --check` is intended for publish-time live drift checks. It fails fast when `AINECTO_CATALOG_SYNC_TOKEN` is missing, so automatic publish cannot silently fall back to fixtures.
For local development, `sync:tools` can also use credentials from `ainecto auth login --env <env>`.

```bash
AINECTO_CATALOG_SYNC_TOKEN=... npm run sync:tools -- --env prod --check
AINECTO_CATALOG_SYNC_TOKEN=... npm run sync:tools -- --env dev --check
```

The checked-in generated catalogs are deterministic output from `tools/list`. The dev catalog has been live-synced from `https://dev.ainecto.com/mcp`; the prod catalog remains a seed fixture until prod auth is available. Presentation metadata lives separately in `src/core/catalog/enrichments.ts`.

`ainecto tools catalog` prints the local generated catalog. Prod output is fixture-only until authenticated prod live sync updates `generated.prod.ts` and `tools-list.prod.json`.

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
npx -y ./ainecto-mcp-0.1.3.tgz --help
npm exec --package ./ainecto-mcp-0.1.3.tgz -- ainecto --help
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
