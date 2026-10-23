# MCP Registry Registration Prep

Date: 2026-07-10 KST (updated 2026-10-14 for 0.6.0, 2026-10-22 remote draft, 2026-10-22 rename)
Status: published up to 0.8.1 as `io.github.codelives/ainecto` (package only). `server.json` 0.9.0 is
renamed to `com.ainecto/mcp` and adds the remote — validated (`mcp-publisher validate`), not
published. The current procedure is in README «MCP Registry»; the publish-day command sequence is
«Move day» below.

## Identity

- Registry name: `com.ainecto/mcp` (from 0.9.0; before: `io.github.codelives/ainecto`)
- Namespace auth path: `ainecto.com` domain, HTTP method (`com.ainecto/*`)
- npm package: `@ainecto/mcp`
- Package version: see `server.json` (same as `package.json#version`)
- Remote: `https://ainecto.com/mcp` (`streamable-http`) — the connection standard; `setup` registers it
- Package: `npx -y @ainecto/mcp` over stdio — the local bridge `setup --local` / `init --mcp --local` write
- Homepage: `https://ainecto.com`
- Repository: `https://github.com/codelives/ainecto`
- License metadata: `UNLICENSED`

The repository contains `server.json` at the package root. Its `name` must match `package.json#mcpName`
(official «Package Types»: the registry checks `mcpName` of the npm version `server.json` references).

### Why `com.ainecto/*` (2026-10-22, KAN-26)

The registry gives one remote URL to one server name (`validateNoDuplicateRemoteURLs` — «remote URL …
is already used by server …»). The remote `https://ainecto.com/mcp` is listed for the first time in
0.9.0, so it goes under the domain name, not the GitHub org name. `remotes` and `packages` coexist
(official «Supporting Remote and Non-remote Installation»).

Name form: domain auth grants `com.ainecto/*` (official «Authentication»: `com.example.*/*`). The part
after `/` is free. `mcp` was chosen: it matches the npm package `@ainecto/mcp` 1:1 and follows the
`com.stripe/mcp` / `com.notion/mcp` convention (user decision 2026-10-22).

### Domain auth — HTTP method

Official «Authentication» → «HTTP Authentication». Registry source
(`internal/api/handlers/v0/auth/http.go`): it GETs `https://ainecto.com/.well-known/mcp-registry-auth`
with redirects **disabled**, needs status 200, reads at most 4096 bytes and trims whitespace. HTTP auth
grants `com.ainecto/*` only (no subdomains; DNS auth would also grant `com.ainecto.*`).

- Key: Ed25519. The private key (hex, the form `--private-key` takes) is only in the macOS keychain,
  service `codelive-mcp-registry`, account `ainecto.com`. No file.
- Public record (not secret) to serve as `text/plain`:

```text
v=MCPv1; k=ed25519; p=aGJHaCzLoZzNrdfw1VymjNItFMZaUrjgbOQkixf9jIY=
```

- Serving: production nginx (`/etc/nginx/sites-enabled/ai-erd`, the `ainecto.com` block) proxies
  `location /.well-known` to the API, so a homepage `public/` file would never be reached. One exact
  location placed before it is enough:

```nginx
location = /.well-known/mcp-registry-auth {
    default_type text/plain;
    return 200 "v=MCPv1; k=ed25519; p=aGJHaCzLoZzNrdfw1VymjNItFMZaUrjgbOQkixf9jIY=\n";
}
```

- Check after reload: `curl -s https://ainecto.com/.well-known/mcp-registry-auth` returns the line above.
- Rotating the key: generate a new pair, replace the keychain item and the nginx line together.

DNS method (not used): TXT record on `ainecto.com` with the same value
(`ainecto.com. IN TXT "v=MCPv1; k=ed25519; p=…"`), then `mcp-publisher login dns --domain ainecto.com
--private-key …`. Needs a Cloudflare DNS write token.

### The old name `io.github.codelives/ainecto`

Its versions (≤ 0.8.1, package only) stay listed. After the first `com.ainecto/mcp` publish, mark them
deprecated (`mcp-publisher status --help`, checked on 1.7.9; the registry accepts a publish permission on
the name, so it needs the `io.github.codelives/*` GitHub login below).

#### Move day — commands to run in order (from this folder)

`mcp-publisher` keeps one login at a time, so the domain login comes first and the GitHub login last.

```bash
# 1. npm 0.9.0 under all names (typecheck·test·build once; re-run with a new code if the OTP expires)
npm run release -- --otp=<code>
npm view @ainecto/mcp@0.9.0 mcpName          # must print com.ainecto/mcp

# 2. Domain login (public record must already be served)
curl -s https://ainecto.com/.well-known/mcp-registry-auth   # v=MCPv1; k=ed25519; p=…
mcp-publisher login http --domain ainecto.com \
  --private-key "$(security find-generic-password -s codelive-mcp-registry -a ainecto.com -w)"

# 3. Publish
mcp-publisher validate
mcp-publisher publish

# 4. Verify — com.ainecto/mcp 0.9.0 with remotes + packages
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.ainecto/mcp"

# 5. Deprecate the old name (GitHub Owner of codelives, classic PAT with read:org)
MCP_GITHUB_TOKEN=$(pbpaste) mcp-publisher login github
mcp-publisher status --status deprecated --all-versions \
  --message "Moved to com.ainecto/mcp" io.github.codelives/ainecto
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.codelives/ainecto"
```

Step 5 only after step 4 shows the new entry — the old one is the only listing until then.

### GitHub login for `io.github.codelives/*` (2026-09-29)

Only an org **Owner** gets the org namespace, and the registry must be able to read the role.
The browser login (`mcp-publisher login github`) came back with `io.github.Ryan9071/*` only, even
for an Owner with public membership. A classic PAT with just `read:org` worked:
`MCP_GITHUB_TOKEN=$(pbpaste) mcp-publisher login github`.

## Official Registry Procedure

Official docs:

- Registry overview: https://modelcontextprotocol.io/registry/about
- Quickstart: https://modelcontextprotocol.io/registry/quickstart
- Package types: https://modelcontextprotocol.io/registry/package-types
- Authentication: https://modelcontextprotocol.io/registry/authentication
- GitHub Actions automation: https://modelcontextprotocol.io/registry/github-actions
- Registry repo and publisher releases: https://github.com/modelcontextprotocol/registry

Steps:

1. Add `mcpName` to npm `package.json`. For domain auth the name is `com.ainecto/<server>`; for GitHub auth `io.github.<user-or-org>/<server>`.
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

5. Authenticate. For this repo, use `ainecto.com` HTTP auth (see «Domain auth — HTTP method»):

```bash
mcp-publisher login http --domain ainecto.com \
  --private-key "$(security find-generic-password -s codelive-mcp-registry -a ainecto.com -w)"
```

Other documented methods are GitHub (device flow / OIDC for Actions) and DNS TXT verification.

6. Publish:

```bash
mcp-publisher validate
```

```bash
mcp-publisher publish
```

7. Verify after publish:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.ainecto/mcp"
```

Before Registry publication, the `@ainecto/mcp` version in `server.json` must be on npm and contain `mcpName: "com.ainecto/mcp"`.

## Community Directory Mapping

| Directory | Current path | Intake model | Action |
| --- | --- | --- | --- |
| Official MCP Registry | https://registry.modelcontextprotocol.io/ | `mcp-publisher` metadata publish after package verification | User/auth owner must authenticate and publish the prepared metadata. |
| PulseMCP | https://www.pulsemcp.com/submit | Ingests the official Registry daily and processes weekly; manual URL/email path for adjustments | Prefer official Registry first; email PulseMCP if a week passes or listing edits are needed. |
| Glama | https://glama.ai/mcp/faq | Submit GitHub repo from the servers page; automated quality checks; optional `glama.json` metadata | User or maintainer can submit the public GitHub repo after Registry/npm readiness. |
| MCP.so | https://mcp.so/submit | Public GitHub server submit form; draft completion publishes automatically | User or maintainer signs in and submits GitHub repository URL. |
| MCP.Directory | https://mcp.directory/submit | GitHub URL form; auto-pulls metadata, tools, README, npm/PyPI; review within 24 hours; can claim auto-discovered official Registry entries | Submit GitHub repo and optional npm package, or claim if auto-discovered. |
| mcpservers.org | https://mcpservers.org/submit | Form with server name, description, GitHub/docs link, category, contact email | User or maintainer submits form; premium review is optional. |
| Smithery | https://smithery.ai/docs/build/publish | URL publish for Streamable HTTP servers, or MCPB bundle for local stdio distribution | Use the hosted Streamable HTTP endpoint `https://ainecto.com/mcp`. |

## User-Only Actions

- Serve the public record at `https://ainecto.com/.well-known/mcp-registry-auth` (production nginx).
- Log in with the `ainecto.com` key from the keychain; deprecate the old name with a GitHub `codelives` Owner login.
- Confirm the published npm package version referenced by `server.json` still contains the matching `mcpName`.
- Run `mcp-publisher login http --domain ainecto.com …` and `mcp-publisher publish`.
- Submit or claim listings in community directories that require account login, email, or ownership proof.

## Developer-Ready Actions

- Keep `server.json` and `package.json#mcpName` synchronized.
- Keep the README «For AI agents» install line current (HTTP direct, `--scope user`).
- Before user publish, run local checks:

```bash
npm run typecheck
npm test
npm run build
```

- After a user publish, verify Registry search output and direct package execution.
