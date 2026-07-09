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

## Catalog Sync

`sync:tools --check` is intended for publish-time live drift checks. It fails fast when `AINECTO_CATALOG_SYNC_TOKEN` is missing, so automatic publish cannot silently fall back to fixtures.

```bash
AINECTO_CATALOG_SYNC_TOKEN=... npm run sync:tools -- --env prod --check
AINECTO_CATALOG_SYNC_TOKEN=... npm run sync:tools -- --env dev --check
```

The checked-in generated catalogs are deterministic output from `tools/list` fixtures. Presentation metadata lives separately in `src/core/catalog/enrichments.ts`.

`ainecto tools catalog` prints the local generated catalog. In the Phase 1 seed state, that output is fixture-only until authenticated live sync updates the generated prod/dev catalogs.

## Local Tarball Smoke

```bash
npm pack
npx -y ./ainecto-mcp-0.1.0.tgz --help
npm exec --package ./ainecto-mcp-0.1.0.tgz -- ainecto --help
```

## Live Dev MCP Smoke

This requires an authenticated dev token from `ainecto auth login --env dev` or a local developer `AINECTO_TOKEN`.

```bash
npm run smoke:mcp -- --env dev
```

The smoke initializes MCP, reads `tools/list`, calls `mcp__ainecto__list_projects`, and prints only aggregate metadata such as tool count and Task tool exposure.

## Known Limitations

- The MCP connector currently implements newline-delimited stdio JSON-RPC to HTTP JSON-RPC. Streamable HTTP SSE responses and `MCP-Session-Id` session handling are not implemented in Phase 1.

Public publish is blocked until the npm `@ainecto` org and publish secrets are ready.
