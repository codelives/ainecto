# MCP Registry Registration Prep

Date: 2026-07-10 KST
Status: prepared, not submitted

## Proposed Identity

- Registry name: `io.github.codelives/ainecto`
- Namespace auth path: GitHub organization namespace `io.github.codelives/*`
- npm package: `@ainecto/mcp`
- Package version: `0.1.3`
- Execution: `npx -y @ainecto/mcp`
- Transport: stdio
- Homepage: `https://ainecto.com`
- Repository: `https://github.com/codelives/ainecto`
- License metadata: `UNLICENSED`

The repository contains `server.json` at the package root. Its `name` must match `package.json#mcpName`.

## Official Registry Procedure

Official docs:

- Registry overview: https://modelcontextprotocol.io/registry/about
- Quickstart: https://modelcontextprotocol.io/registry/quickstart
- Package types: https://modelcontextprotocol.io/registry/package-types
- Authentication: https://modelcontextprotocol.io/registry/authentication
- GitHub Actions automation: https://modelcontextprotocol.io/registry/github-actions
- Registry repo and publisher releases: https://github.com/modelcontextprotocol/registry

Steps:

1. Add `mcpName` to npm `package.json`. For GitHub auth, the name must use `io.github.<user-or-org>/<server>`.
2. Publish the npm package before publishing Registry metadata. The official Registry hosts metadata, not package code.
3. Install `mcp-publisher`:

```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
sudo mv mcp-publisher /usr/local/bin/
```

Homebrew is also documented:

```bash
brew install mcp-publisher
```

4. Create or refresh `server.json`:

```bash
mcp-publisher init
```

5. Authenticate. For this repo, use GitHub org namespace auth:

```bash
mcp-publisher login github
```

Other documented methods are GitHub OIDC for Actions, DNS TXT verification, and HTTP well-known verification.

6. Publish:

```bash
mcp-publisher validate
```

```bash
mcp-publisher publish
```

7. Verify after publish:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.codelives/ainecto"
```

Current patch readiness: `@ainecto/mcp@0.1.3` is prepared locally and contains `mcpName: "io.github.codelives/ainecto"`. npm publish is pending user approval before Registry publication.

## Community Directory Mapping

| Directory | Current path | Intake model | Action |
| --- | --- | --- | --- |
| Official MCP Registry | https://registry.modelcontextprotocol.io/ | `mcp-publisher` metadata publish after package verification | User/auth owner must authenticate and publish the prepared metadata. |
| PulseMCP | https://www.pulsemcp.com/submit | Ingests the official Registry daily and processes weekly; manual URL/email path for adjustments | Prefer official Registry first; email PulseMCP if a week passes or listing edits are needed. |
| Glama | https://glama.ai/mcp/faq | Submit GitHub repo from the servers page; automated quality checks; optional `glama.json` metadata | User or maintainer can submit the public GitHub repo after Registry/npm readiness. |
| MCP.so | https://mcp.so/submit | Public GitHub server submit form; draft completion publishes automatically | User or maintainer signs in and submits GitHub repository URL. |
| MCP.Directory | https://mcp.directory/submit | GitHub URL form; auto-pulls metadata, tools, README, npm/PyPI; review within 24 hours; can claim auto-discovered official Registry entries | Submit GitHub repo and optional npm package, or claim if auto-discovered. |
| mcpservers.org | https://mcpservers.org/submit | Form with server name, description, GitHub/docs link, category, contact email | User or maintainer submits form; premium review is optional. |
| Smithery | https://smithery.ai/docs/build/publish | URL publish for Streamable HTTP servers, or MCPB bundle for local stdio distribution | Current stdio npm package is not directly enough; prepare MCPB or hosted HTTP endpoint before Smithery listing. |

## User-Only Actions

- Authenticate as a GitHub user or org member allowed to publish under `io.github.codelives/*`.
- Confirm the published npm package version referenced by `server.json` still contains the matching `mcpName`.
- Run `mcp-publisher login github` and `mcp-publisher publish`.
- Submit or claim listings in community directories that require account login, email, or ownership proof.

## Developer-Ready Actions

- Keep `server.json` and `package.json#mcpName` synchronized.
- Keep README direct-install JSON current.
- Before user publish, run local checks:

```bash
npm run typecheck
npm test
npm run build
```

- After a user publish, verify Registry search output and direct package execution.
