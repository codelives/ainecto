import { FileTokenStore } from "../src/core/auth/tokenStore";
import { OAuthClient } from "../src/core/auth/oauth";
import { resolveEndpoint, type AinectoEnv } from "../src/core/config/endpoints";
import { McpRpcClient } from "../src/core/mcp/rpcClient";

interface Args {
  env: AinectoEnv;
  endpoint?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const resolved = resolveEndpoint({ env: args.env, endpoint: args.endpoint });
  const auth = new OAuthClient({
    endpoint: resolved.endpoint,
    tokenStore: new FileTokenStore(),
  });
  const token = await auth.getAccessToken();
  if (!token) {
    throw new Error("SMOKE_AUTH_REQUIRED: run `ai-erd auth login --env dev` or provide AINECTO_TOKEN before smoke.");
  }

  const client = new McpRpcClient({ endpoint: resolved.endpoint, tokenProvider: auth });
  await client.initialize();
  const tools = await client.toolsList();
  const toolNames = tools.map((tool) => isRecord(tool) && typeof tool.name === "string" ? tool.name : "").filter(Boolean);
  const result = await client.toolsCall("list_projects", {});
  // ★서버는 이제 짧은 이름(`task_list_tasks`)을 내보낸다. `__task_` 로 찾으면 늘 false 였다(0.4.1 리뷰 P2).
  //   긴 이름(`mcp__ainecto__task_…`)도 같은 규칙으로 맞춘다.
  const hasTaskTools = toolNames.some((name) => /^(?:mcp__ainecto__)?tasks?_/.test(name));

  console.log(JSON.stringify({
    ok: true,
    endpoint: resolved.endpoint,
    toolCount: toolNames.length,
    hasTaskTools,
    listProjectsCall: result !== undefined,
  }, null, 2));
}

function parseArgs(argv: string[]): Args {
  let env: AinectoEnv = "dev";
  let endpoint: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env") {
      const value = argv[++index];
      if (value !== "prod" && value !== "dev") {
        throw new Error("--env must be prod or dev.");
      }
      env = value;
    } else if (arg === "--endpoint") {
      endpoint = argv[++index];
      if (!endpoint) {
        throw new Error("--endpoint requires a value.");
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { env, endpoint };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
