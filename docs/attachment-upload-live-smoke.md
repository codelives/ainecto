# Attachment Upload Live Smoke

Purpose: verify the bespoke `ainecto attachments upload` command against a local `ainecto-api` dev server with real file bytes.

## Command

```bash
npm run smoke:attachments -- --base-url http://localhost:8080 --endpoint http://localhost:8080/mcp --api-root /Users/ryan/project/workspace/codelive/ainecto-api
```

## Scope

- Issues a real OAuth MCP bearer token for the local `/mcp` resource.
- Creates a temporary user, workspace, project, and mutable ERD document.
- Runs the CLI command:

```bash
ainecto attachments upload --env dev --endpoint http://localhost:8080/mcp --document-uuid <documentUuid> <file> --json
```

- Verifies `request_upload_token`, raw bytes `PUT`, `upload_attachments`, `list_attachments`, and server filesystem bytes.
- Removes the temporary user, local temp file, and stored upload file unless `--keep` is supplied.

## 2026-07-09 Result

Target API:

- repo: `/Users/ryan/project/workspace/codelive/ainecto-api`
- branch: `dev`
- commit: `ef2f3a0 feat: support attachment upload tokens`
- health: `http://localhost:8080/actuator/health` returned `UP`

Result:

- status: PASS
- endpoint: `http://localhost:8080/mcp`
- documentUuid: `3067fb4465614b818008a4bd31c6ceaa`
- attachmentUuid: `c345f375-a4c0-4d0e-8013-f2fbb834f8cd`
- storageKey: `attachments/e5269e5e-9310-4f5c-8e4a-f1fa971de068/3067fb4465614b818008a4bd31c6ceaa/bafe4c36-57e3-483b-bfd1-6610dc055f4c/live-attachment.txt`
- contentType: `text/plain`
- sizeBytes: `80`

Checks:

- `requestUploadToken`: PASS
- `rawPut`: PASS
- `uploadAttachments`: PASS
- `listAttachments`: PASS
- `fsBytesMatch`: PASS
- cleanup: temporary user and stored upload file removed

Notes:

- Initial live run found that `request_upload_token` returns the standard MCP `content[].text` wrapper, not a direct object. The CLI now unwraps that response before reading `token`, `uploadUrl`, and `storageKey`.
- Local MCP rollout allowed only ERD documents in this environment, so the smoke fixture uses an ERD document.
