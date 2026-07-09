# Ainecto CLI Phase 2 Design: Friendly Commands And Attachment Upload

Date: 2026-07-09 KST
Status: proposal for reviewer-front review
Base repo: `/Users/ryan/project/workspace/codelive/ainecto-cli`
Base commit: `959d2d5`

## Summary

Phase 2 should add a generated friendly command router for the checked-in MCP catalog and one bespoke attachment upload workflow.

Recommended MVP:

1. Make every generated dev/prod catalog tool reachable through its deterministic `commandPath`, while keeping `ainecto tools call <mcpName>` as the raw escape hatch.
2. Add friendly flag parsing, destructive confirmation, help, and output hints through catalog/enrichment SSOTs, not hand-written per-tool clients.
3. Add a dedicated `ainecto attachments upload` command for local file upload because it is multi-step and cannot be represented well as a plain `tools call`.
4. Keep MCP connector mode (`npx -y @ainecto/mcp` / `ainecto mcp`) as a raw JSON-RPC proxy. It must not inherit local file upload or friendly command semantics.

This gives broad CLI coverage without creating a second backend contract surface.

## Current Facts

- Dev catalog is live-synced and contains 76 tools.
- Task tools are exposed in dev:
  - `mcp__ainecto__task_apply_changes`
  - `mcp__ainecto__task_get_snapshot`
  - `mcp__ainecto__task_get_task`
  - `mcp__ainecto__task_list_statuses`
  - `mcp__ainecto__task_list_tasks`
- Prod catalog is still a seed fixture until prod auth is available.
- Phase 1 already has:
  - endpoint resolution
  - PKCE OAuth + file TokenStore
  - `McpRpcClient`
  - `--file` / stdin / inline JSON input parser for first-party CLI paths
  - generated catalog metadata: `mcpName`, `commandPath`, `group`, `payloadMode`, `destructive`, `required`, `schemaHash`
  - raw `tools call`
  - preliminary `uploadAttachment` helper, but its request/commit assumptions need correction against the live catalog contract.

## Friendly Command Scope

### Two-Layer Scope

Layer 1: universal generated command router.

- Applies to all 76 generated tools.
- No hand-written domain REST clients.
- Maps `GeneratedToolDefinition.commandPath` to `McpRpcClient.toolsCall`.
- Reuses `payloadMode`, `required`, and `destructive` from generated catalog.
- Keeps `ainecto tools call <mcpName>` available for exact remote calls and as the compatibility escape hatch.

Layer 2: polished Phase 2 MVP UX.

- Adds curated aliases, examples, table columns, and output hints for high-use groups only.
- Does not mutate generated schema or required args.
- Leaves lower-priority groups mechanically reachable through Layer 1 until later phases.

### MVP Groups

Recommended Phase 2 MVP includes:

- Workspace/project/folder/document backbone:
  - `workspaces list|get|create|update|delete|unarchive`
  - `projects list|get|create|update|delete|unarchive`
  - `folders list|create|update|delete|move|unarchive`
  - `documents list|get|create|update|delete|move|unarchive|search`
- Versions/trash/share:
  - `versions list|get|restore`
  - `trash list`
  - `shares enable|disable` as friendly aliases for current fallback paths
- ERD:
  - `erd list-tables|get-table|list-refs|get-ref|list-enums|get-enum|list-table-groups|get-table-group|arrange-tables|apply-changes`
- Task:
  - `task list-tasks|get-task|list-statuses|get-snapshot|apply-changes`
- Readme:
  - `readme generate-document`
  - `readme append-document`
- Attachment:
  - `attachments list|get|delete`
  - bespoke `attachments upload`

Recommended deferred polish:

- Testcase has 22 tools and should be Layer-1 reachable in Phase 2, but custom output/table UX and workflow-specific aliases should be Phase 3 unless user explicitly prioritizes testcase now.
- Full 76-tool bespoke documentation is not Phase 2 MVP. Generated help is enough for non-MVP groups.

## Naming And Flag Rules

Command naming:

- Collection commands use plural nouns: `projects list`, `documents create`, `attachments delete`.
- Single-object reads use singular nouns when generated that way: `project get`, `document get`, `attachment get`.
- Domain tools keep domain prefix: `erd apply-changes`, `task list-tasks`, `testcase create-runs`.
- Fallback remains `tools run <slug>` when deterministic verb/resource inference cannot produce a natural path.
- Friendly aliases may be added in `enrichments.ts`, for example:
  - `shares enable` -> `mcp__ainecto__enable_shares`
  - `shares disable` -> `mcp__ainecto__disable_shares`
  - `attachments upload` -> bespoke upload workflow, not a direct MCP tool alias.

Flag rules:

- Scalar schema properties become flags.
- Prefer kebab-case CLI flags while mapping back to schema keys:
  - `projectUuid` -> `--project-uuid`
  - `documentUuid` -> `--document-uuid`
  - `versionNumber` -> `--version-number`
- Also accept exact schema-case flags as compatibility aliases:
  - `--projectUuid`
  - `--documentUuid`
- Array/object payloads use existing `--file` / stdin / inline JSON parser.
- Missing required scalar flags produce structured errors in `--json` mode.
- Destructive tools require confirmation in human mode unless `--yes` is supplied.
- In `--json` mode, destructive tools without `--yes` fail with a stable structured error instead of prompting.

Output rules:

- `--json` always returns the raw normalized MCP result plus warnings.
- Human output is best-effort and driven by `enrichments.ts`.
- MVP table output should cover list/get commands in workspace/project/folder/document/task/attachment groups.
- If no output hint exists, fall back to formatted JSON.

## Raw Proxy Relationship

No change to raw proxy mode.

- `npx -y @ainecto/mcp` and `ainecto mcp` remain stdio JSON-RPC to `/mcp` HTTP JSON-RPC proxy.
- They do not synthesize friendly command schemas.
- They do not interpret local files, `--file`, or upload shortcuts.
- All friendly behavior lives only under first-party `ainecto <command>` paths.

This preserves the 2026-07-09 user-confirmed connector decision.

## Attachment Upload Design

### Proposed Command Surface

```bash
ainecto attachments upload --document-uuid <uuid> ./file.png
ainecto attachments upload --document-uuid <uuid> ./a.png ./b.pdf --json
ainecto attachments upload --document-uuid <uuid> --name diagram.png --content-type image/png ./diagram-export
```

Related direct catalog commands:

```bash
ainecto attachments list --project-uuid <projectUuid>
ainecto attachment get --uuid <attachmentUuid>
ainecto attachments delete --file delete-payload.json --yes
```

### Upload Flow

For each file:

1. Resolve and stat the file.
2. Determine filename and content type.
3. Request an upload token/target.
4. PUT the file bytes to the returned upload URL.
5. Register the uploaded object through `mcp__ainecto__upload_attachments` with:
   - `documentUuid`
   - `filename`
   - `storageKey`
   - `contentType`
   - `sizeBytes`
6. Render per-file success/failure.

Human progress:

- For files below a small threshold, simple status lines are enough.
- For larger files, show byte progress if Node stream upload progress can be implemented without extra runtime dependencies.
- Never print bearer/upload tokens.

JSON output:

```json
{
  "ok": true,
  "data": {
    "uploaded": [
      {
        "path": "./file.png",
        "filename": "file.png",
        "sizeBytes": 12345,
        "result": {}
      }
    ]
  }
}
```

### Retry And Error Policy

- Retry PUT on transient network errors and HTTP 429/5xx up to 2 times with short exponential backoff.
- If upload target expires, request a new upload target once and retry the current file.
- Do not automatically retry `upload_attachments` registration after an ambiguous network failure unless the backend provides idempotency semantics.
- In multi-file uploads, default behavior is fail-fast; optional `--continue-on-error` can be deferred.
- `--json` errors must use the existing stable error shape.

### Contract Gap To Resolve

The dev catalog currently has:

- `mcp__ainecto__request_upload_token`
  - `purpose` enum: `mcp.call`, `document.create`, `document.update`, `document.append`
  - optional `scopeJson`, `maxBytes`, `ttlSeconds`
- `mcp__ainecto__upload_attachments`
  - requires `items[].storageKey`
  - says `storageKey` is returned by `request_upload_token`

There is no explicit attachment upload purpose in the request schema. Before implementing `attachments upload`, we need one of these decisions:

1. Backend confirms which existing `purpose` value and `scopeJson` shape are valid for attachment uploads.
2. Backend adds an explicit purpose, for example `attachment.upload`, and documents response shape.
3. Phase 2 ships friendly commands first and gates `attachments upload` until the upload-token contract is explicit.

Recommended: add/confirm `purpose=attachment.upload` with response `{ uploadUrl, storageKey, expiresAt? }`.

## Architecture

Suggested modules:

```text
src/adapters/cli/
  generatedCommandRouter.ts
  flagParser.ts
  destructiveConfirmation.ts
  commands/
    attachments.ts
src/core/upload/
  attachmentUpload.ts
  uploadTarget.ts
  retry.ts
src/core/output/
  table.ts
```

Responsibilities:

- `generatedCommandRouter.ts`
  - loads `getGeneratedTools(env)`
  - matches argv command path
  - parses scalar flags and payload files
  - calls `McpRpcClient.toolsCall`
- `flagParser.ts`
  - one SSOT for kebab-case/schema-case flag aliases
  - type coercion for string/integer/number/boolean
  - required validation
- `destructiveConfirmation.ts`
  - shared human prompt / `--yes` behavior
- `commands/attachments.ts`
  - handles `attachments upload`
  - direct attachment list/get/delete can still go through generated router
- `attachmentUpload.ts`
  - should be corrected to the live response shape and should not assume `uploadId` unless the backend contract confirms it.

## Phase 1 Compatibility

- TokenStore stays endpoint-scoped and remains the only normal auth source.
- `AINECTO_TOKEN` remains debug override only.
- `sync:tools --check` remains fail-fast and must not fixture-fallback when no credential exists.
- Generated catalog stays the schema SSOT; enrichments remain presentation-only.
- Publish workflow is unchanged.
- Dev catalog can be used for implementation and tests; prod catalog remains seed until prod auth sync.

## Testing Plan

Unit tests:

- command matching from generated catalog
- kebab-case and schema-case flag aliases
- scalar coercion and missing required errors
- file-json payload source priority remains unchanged
- destructive confirmation and `--yes`
- output table fallback behavior
- attachment upload happy path with mocked token request, PUT, and registration
- upload retry cases:
  - transient PUT failure then success
  - expired upload target then re-request
  - registration ambiguous failure not retried

Integration/local smoke:

- non-mutating generated commands on dev:
  - `workspaces list --env dev --json`
  - `projects list --env dev --json`
  - `task list-statuses --env dev --document-uuid <safe-doc>` only if safe document UUID is provided
- attachment upload smoke requires a safe dev document UUID and a small fixture file.

Reviewer/tester handoff after implementation:

- developer runs typecheck/test/build.
- tester-front can validate detached HEAD with mocked upload and optionally live dev upload if root provides a safe document UUID.

## User Decisions Needed

1. Phase 2 MVP breadth:
   - Recommended: universal generated router for all 76 tools, polished UX for backbone/ERD/Task/Readme/Attachment, testcase polish deferred.
   - Alternative: only implement backbone + attachment now, leaving all other friendly command paths for later.
2. Attachment upload token contract:
   - Confirm existing `request_upload_token` purpose/scope for attachments, or approve backend/API follow-up for `attachment.upload`.
3. Upload smoke target:
   - Provide a safe dev `documentUuid` for live attachment upload smoke, or accept mocked upload tests only for Phase 2 review.
4. Destructive command UX:
   - Recommended: human prompt unless `--yes`; `--json` requires `--yes` and never prompts.
5. Testcase priority:
   - Recommended: generated reachability only in Phase 2, polished workflow commands later.

## Recommendation

Proceed with Phase 2 only after reviewer GO and user decision on the attachment upload token contract.

Implementation order after GO:

1. Generated command router + flag parser + destructive confirmation.
2. Presentation enrichments and basic table output for MVP groups.
3. Attachment upload workflow after contract confirmation.
4. Tests and docs.
5. Local smoke and reviewer/tester handoff.
