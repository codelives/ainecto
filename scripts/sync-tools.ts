import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveEndpoint, type AinectoEnv } from "../src/core/config/endpoints";
import { McpRpcClient } from "../src/core/mcp/rpcClient";
import { generateCatalog, serializeGeneratedCatalog, stableStringify } from "../src/core/catalog/generator";
import type { McpToolListItem } from "../src/core/catalog/types";

interface Args {
  env: AinectoEnv;
  check: boolean;
  fixture?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tools = args.fixture
    ? await readFixture(args.fixture)
    : await fetchLiveTools(args.env, args.check);
  const generated = generateCatalog(tools, args.env);
  const generatedPath = join(process.cwd(), `src/core/catalog/generated.${args.env}.ts`);
  const fixturePath = join(process.cwd(), `test/fixtures/tools-list.${args.env}.json`);
  const nextGenerated = serializeGeneratedCatalog(generated);
  const nextFixture = `${JSON.stringify({ tools }, null, 2)}\n`;

  if (args.check) {
    const currentGenerated = await readFile(generatedPath, "utf8");
    const currentFixture = await readFile(fixturePath, "utf8");
    if (currentGenerated !== nextGenerated || stableStringify(JSON.parse(currentFixture)) !== stableStringify(JSON.parse(nextFixture))) {
      throw new Error(`CATALOG_DRIFT_${args.env.toUpperCase()}: generated catalog or fixture differs from live tools/list.`);
    }
    return;
  }

  await writeFile(generatedPath, nextGenerated);
  await writeFile(fixturePath, nextFixture);
}

async function fetchLiveTools(env: AinectoEnv, check: boolean): Promise<McpToolListItem[]> {
  const token = process.env.AINECTO_CATALOG_SYNC_TOKEN;
  if (!token) {
    const code = check ? "CATALOG_SYNC_AUTH_MISSING" : "CATALOG_SYNC_AUTH_MISSING";
    throw new Error(`${code}: AINECTO_CATALOG_SYNC_TOKEN is required for live catalog sync.`);
  }
  const resolved = resolveEndpoint({ env });
  const client = new McpRpcClient({
    endpoint: resolved.endpoint,
    tokenProvider: {
      getAccessToken: async () => token,
      refreshAfterUnauthorized: async () => undefined,
    },
  });
  await client.initialize();
  const tools = await client.toolsList();
  return tools.map(assertMcpToolListItem);
}

async function readFixture(path: string): Promise<McpToolListItem[]> {
  const fixture = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(fixture) || !Array.isArray(fixture.tools)) {
    throw new Error("Fixture must include a tools array.");
  }
  return fixture.tools.map(assertMcpToolListItem);
}

function parseArgs(argv: string[]): Args {
  let env: AinectoEnv = "prod";
  let check = false;
  let fixture: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env") {
      const value = argv[++index];
      if (value !== "prod" && value !== "dev") {
        throw new Error("--env must be prod or dev.");
      }
      env = value;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--fixture") {
      fixture = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { env, check, fixture };
}

function assertMcpToolListItem(value: unknown): McpToolListItem {
  if (!isRecord(value) || typeof value.name !== "string") {
    throw new Error("tools/list item must include a name.");
  }
  return {
    name: value.name,
    description: typeof value.description === "string" ? value.description : undefined,
    inputSchema: isRecord(value.inputSchema) ? value.inputSchema : undefined,
    annotations: isRecord(value.annotations) ? {
      destructiveHint: typeof value.annotations.destructiveHint === "boolean" ? value.annotations.destructiveHint : undefined,
      readOnlyHint: typeof value.annotations.readOnlyHint === "boolean" ? value.annotations.readOnlyHint : undefined,
    } : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
