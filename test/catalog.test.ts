import { mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import prodFixture from "./fixtures/tools-list.prod.json";
import devFixture from "./fixtures/tools-list.dev.json";
import { enrichments } from "../src/core/catalog/enrichments";
import { generatedTools as prodGenerated } from "../src/core/catalog/generated.prod";
import { generatedTools as devGenerated } from "../src/core/catalog/generated.dev";
import { generateCatalog, stableStringify } from "../src/core/catalog/generator";
import { assertUniqueCommandPaths } from "../src/adapters/cli/commandBuilder";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..");

describe("catalog generation", () => {
  it("matches checked-in prod and dev fixtures", () => {
    expect(stableStringify(generateCatalog(prodFixture.tools, "prod"))).toBe(stableStringify(prodGenerated));
    expect(stableStringify(generateCatalog(devFixture.tools, "dev"))).toBe(stableStringify(devGenerated));
  });

  /**
   * ★서버가 2026-09-22 부터 도구 이름을 «짧게» 내보낸다.
   *
   * 예전 generator 는 `mcp__ainecto__` prefix 가 없으면 throw 했다 — 다음 sync:tools 에서
   * 곧바로 터졌을 자리다. 두 형태가 같은 명령으로 떨어지는지 고정한다.
   */
  it("accepts both the short server name and the legacy prefixed one", () => {
    const schema = { type: "object", properties: {} };
    const [shortForm] = generateCatalog([{ name: "list_projects", description: "", inputSchema: schema }], "prod");
    const [legacyForm] = generateCatalog(
      [{ name: "mcp__ainecto__list_projects", description: "", inputSchema: schema }],
      "prod",
    );

    expect(shortForm.commandPath).toEqual(legacyForm.commandPath);
    // mcpName 은 «서버가 준 이름»을 그대로 들고 간다 — 서버는 둘 다 받는다
    expect(shortForm.mcpName).toBe("list_projects");
    expect(legacyForm.mcpName).toBe("mcp__ainecto__list_projects");
  });

  it("keeps generated commands reachable and unique", () => {
    for (const tool of [...prodGenerated, ...devGenerated]) {
      expect(tool.commandPath.length).toBeGreaterThan(0);
      expect(tool.mcpName).toMatch(/^mcp__ainecto__/);
    }
    expect(() => assertUniqueCommandPaths(prodGenerated)).not.toThrow();
    expect(() => assertUniqueCommandPaths(devGenerated)).not.toThrow();
  });

  it("requires enrichments to refer to generated tools and stay presentation-only", () => {
    const names = new Set([...prodGenerated, ...devGenerated].map((tool) => tool.mcpName));
    for (const enrichment of enrichments) {
      expect(names.has(enrichment.mcpName)).toBe(true);
      expect(enrichment).not.toHaveProperty("inputSchema");
      expect(enrichment).not.toHaveProperty("required");
      expect(enrichment).not.toHaveProperty("payloadMode");
      expect(enrichment).not.toHaveProperty("destructive");
    }
  });

  it("does not let sync:tools --check pass through fixture fallback when auth is missing", () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "ainecto-empty-home-"));
    const result = spawnSync("npm", ["run", "sync:tools", "--", "--env", "prod", "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { HOME: emptyHome, PATH: process.env.PATH ?? "" },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("CATALOG_SYNC_AUTH_MISSING");
  });

  it("keeps publish workflow fail-fast auth gate before npm publish", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/publish.yml"), "utf8");
    const authGateIndex = workflow.indexOf("AINECTO_CATALOG_SYNC_TOKEN is required");
    const publishIndex = workflow.indexOf("npm publish --provenance --access public");
    expect(authGateIndex).toBeGreaterThan(0);
    expect(publishIndex).toBeGreaterThan(authGateIndex);
    expect(workflow).not.toContain("set -x");
  });
});
