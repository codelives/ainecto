import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAinectoCli } from "../src/adapters/cli/ainectoCli";
import { executeInitCommand, type InitCommandOptions } from "../src/adapters/cli/initCommand";
import { parseMcpArgs } from "../src/adapters/mcp/args";
import { runConnector } from "../src/adapters/mcp/connector";
import { tokenKey } from "../src/core/auth/tokenStore";
import { AGENT_NAME_HEADER, McpRpcClient } from "../src/core/mcp/rpcClient";

/**
 * 에이전트 «이름» 싣기(설계 agent-identity-plan §1) — 이름은 폴더에 붙고, 입력은 `init --agent` 한 번이다.
 * 브리지는 `--agent` 가 우선이고 없으면 `.ainecto/agent.local`, 직접 명령도 같은 파일을 읽는다.
 * 이름이 없으면 지금과 똑같다(헤더 없음). 네트워크는 타지 않는다 — fetch 는 전부 가짜다.
 */
const ENDPOINT = "https://ainecto.com/mcp";
const NAME_HEADER = AGENT_NAME_HEADER.toLowerCase();

let home: string;
let work: string;
let originalHome: string | undefined;
let originalCwd: string;
let originalFetch: typeof fetch;
const sent: Array<Record<string, string>> = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ainecto-home-"));
  work = await mkdtemp(join(tmpdir(), "ainecto-work-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  originalCwd = process.cwd();
  process.chdir(work);
  sent.length = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent.push((init?.headers ?? {}) as Record<string, string>);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
  }) as unknown as typeof fetch;
  await mkdir(join(home, ".ainecto"), { recursive: true });
  await writeFile(join(home, ".ainecto", "tokens.json"), JSON.stringify({
    [tokenKey(ENDPOINT)]: {
      endpoint: ENDPOINT, accessToken: "seeded-token", tokenType: "Bearer", expiresAt: Date.now() + 3_600_000,
    },
  }), "utf8");
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

async function writeAgentLocal(name: string) {
  await mkdir(join(work, ".ainecto"), { recursive: true });
  await writeFile(join(work, ".ainecto", "agent.local"), name);
}

describe("브리지 인자 --agent", () => {
  it("이름을 받고 앞뒤 공백만 걷는다 — 규칙은 서버가 본다", () => {
    expect(parseMcpArgs(["--agent", "tester"]).agent).toBe("tester");
    expect(parseMcpArgs(["--agent", "  Tester_02 "]).agent).toBe("Tester_02");
    expect(parseMcpArgs([]).agent).toBeUndefined();
  });

  it("값이 없거나 비면 멈춘다", () => {
    expect(() => parseMcpArgs(["--agent"])).toThrow("--agent requires a value.");
    expect(() => parseMcpArgs(["--agent", "--env", "dev"])).toThrow("--agent requires a value.");
    expect(() => parseMcpArgs(["--agent", "   "])).toThrow("--agent requires a value.");
  });
});

describe("헤더 싣기", () => {
  it("이름이 있으면 모든 요청에 X-AiNecto-Agent-Name, 없으면 싣지 않는다(종류 헤더와 따로)", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    }) as unknown as typeof fetch;

    const named = new McpRpcClient({ endpoint: ENDPOINT, fetchImpl, channel: "mcp", agentName: "tester" });
    named.useAgent("claude-code");
    await named.toolsList();
    await named.toolsCall("identity_get_self", {});
    expect(seen[0]).toMatchObject({ [NAME_HEADER]: "tester", "x-ainecto-agent": "claude-code" });
    expect(seen[1]).toMatchObject({ [NAME_HEADER]: "tester" });

    await new McpRpcClient({ endpoint: ENDPOINT, fetchImpl, channel: "cli" }).toolsList();
    expect(Object.keys(seen[2]!)).not.toContain(NAME_HEADER);
  });

  it("★서버의 이름 거절(400 AGENT_NAME_INVALID · 409 AGENT_LIMIT)은 사람이 읽을 한 줄로 그대로 보인다", async () => {
    const reply = (status: number, error: string, description: string) => vi.fn(async () =>
      new Response(JSON.stringify({ error, error_description: description }), { status })) as unknown as typeof fetch;

    const invalid = new McpRpcClient({ endpoint: ENDPOINT, channel: "cli", agentName: "Bad Name",
      fetchImpl: reply(400, "AGENT_NAME_INVALID", "Agent name must match [a-z0-9][a-z0-9._-]*.\nFix it.") });
    await expect(invalid.toolsList()).rejects.toMatchObject({
      code: "MCP_HTTP_ERROR",
      message: "MCP HTTP request failed with HTTP 400 — AGENT_NAME_INVALID: Agent name must match [a-z0-9][a-z0-9._-]*. Fix it.",
      details: { status: 400, error: "AGENT_NAME_INVALID" },
    });

    const limit = new McpRpcClient({ endpoint: ENDPOINT, channel: "cli", agentName: "fifty-first",
      fetchImpl: reply(409, "AGENT_LIMIT", "Archive agents you no longer use with update_agents.") });
    await expect(limit.toolsList()).rejects.toThrow(
      "MCP HTTP request failed with HTTP 409 — AGENT_LIMIT: Archive agents you no longer use with update_agents.");
  });
});

describe("브리지(connector) — --agent 가 우선, 없으면 .ainecto/agent.local", () => {
  async function bridge(options: { agentFlag?: string }) {
    const input = new PassThrough();
    input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
    await runConnector({ endpoint: ENDPOINT, envVars: {}, input, output: new PassThrough(), errorOutput: new PassThrough(), ...options });
  }

  it("agent.local 만 있으면 그 이름", async () => {
    await writeAgentLocal(" reviewer02\n");
    await bridge({});
    expect(sent[0]?.[NAME_HEADER]).toBe("reviewer02");
  });

  it("--agent 가 파일보다 우선", async () => {
    await writeAgentLocal("reviewer02\n");
    await bridge({ agentFlag: "tester" });
    expect(sent[0]?.[NAME_HEADER]).toBe("tester");
  });

  it("둘 다 없으면 이름 없는 연결 — 헤더 없음", async () => {
    await bridge({});
    expect(Object.keys(sent[0]!)).not.toContain(NAME_HEADER);
  });

  it("`ainecto mcp --agent <이름>` 도 같은 파서로 받는다", async () => {
    const stdin = new PassThrough();
    stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
    const io = { stdout: new PassThrough(), stderr: new PassThrough(), stdin } as unknown as Parameters<typeof runAinectoCli>[1];
    expect(await runAinectoCli(["mcp", "--agent", "tester"], io)).toBe(0);
    expect(sent[0]?.[NAME_HEADER]).toBe("tester");
  });
});

describe("직접 명령 — 이 폴더의 agent.local 을 읽는다", () => {
  const io = () => ({
    stdout: { write: () => true },
    stderr: { write: () => true },
    stdin: { on: () => undefined, resume: () => undefined },
  }) as unknown as Parameters<typeof runAinectoCli>[1];

  it("tools list 가 agent.local 의 이름을 싣는다", async () => {
    await writeAgentLocal("ainecto-root\n");
    expect(await runAinectoCli(["tools", "list"], io())).toBe(0);
    expect(sent[0]?.[NAME_HEADER]).toBe("ainecto-root");
  });

  it("파일이 없으면 헤더 없음(지금과 같다)", async () => {
    expect(await runAinectoCli(["tools", "list"], io())).toBe(0);
    expect(Object.keys(sent[0]!)).not.toContain(NAME_HEADER);
  });
});

describe("ainecto init --agent — 입력은 한 번, 세 파일이 같은 이름", () => {
  const out: string[] = [];
  const io = {
    stdout: { write: (text: string) => { out.push(text); return true; } },
    stderr: { write: () => true },
  } as unknown as InitCommandOptions["io"];

  const documentHeaders: Array<Record<string, string>> = [];
  /** 서버 문서 응답 — 계약을 지킨 본문 한 벌. 받은 헤더를 적어 둔다. */
  const serverDocuments = (async (_url: unknown, init?: RequestInit) => {
    documentHeaders.push((init?.headers ?? {}) as Record<string, string>);
    return new Response(JSON.stringify({
      documents: {
        "HARNESS.DOC": { body: "SERVER DOC for {{endpoint}}\n", version: "HARNESS.DOC@r11" },
        "HARNESS.AGENT_NOTE": {
          body: "<!-- ainecto:begin -->\nSERVER NOTE {{harnessDocPath}} {{serverName}}\n<!-- ainecto:end -->",
          version: "HARNESS.AGENT_NOTE@r4",
        },
      },
    }), { status: 200 });
  }) as unknown as typeof fetch;

  function options(argv: string[], fetchImpl: typeof fetch = serverDocuments): InitCommandOptions {
    return {
      argv,
      endpoint: ENDPOINT,
      env: "prod",
      cliVersion: "@ainecto/mcp test",
      cwd: work,
      json: true,
      accessToken: async () => "t",
      fetchImpl,
      io,
    };
  }

  const read = async (path: string) => readFile(join(work, path), "utf8");
  const entryOf = async (path: string) => JSON.parse(await read(path)).mcpServers.ainecto;

  beforeEach(() => {
    out.length = 0;
    documentHeaders.length = 0;
  });

  it("★agent.local · .mcp.json(headers) · .cursor/mcp.json · .codex/config.toml(http_headers) — --mcp 없이도", async () => {
    expect(await executeInitCommand(options(["--agent", " tester "]))).toBe(0);

    expect(await read(".ainecto/agent.local")).toBe("tester\n");
    expect(await entryOf(".mcp.json")).toEqual({ type: "http", url: ENDPOINT, headers: { [AGENT_NAME_HEADER]: "tester" } });
    expect(await entryOf(".cursor/mcp.json")).toEqual({ url: ENDPOINT, headers: { [AGENT_NAME_HEADER]: "tester" } });
    expect(await read(".codex/config.toml")).toBe([
      "[mcp_servers.ainecto]",
      `url = "${ENDPOINT}"`,
      `http_headers = { "${AGENT_NAME_HEADER}" = "tester" }`,
      "",
    ].join("\n"));
    // init 의 인증된 호출(서버 문서)에도 같은 이름이 실린다.
    expect(documentHeaders[0]?.[NAME_HEADER]).toBe("tester");
  });

  it("--local 이면 브리지 인자 --agent 로 싣는다(세 파일 모두)", async () => {
    expect(await executeInitCommand(options(["--agent", "tester", "--local"]))).toBe(0);

    const bridge = await entryOf(".mcp.json");
    expect(bridge.command).toBe("npx");
    expect(bridge.args.slice(-2)).toEqual(["--agent", "tester"]);
    expect((await entryOf(".cursor/mcp.json")).args.slice(-2)).toEqual(["--agent", "tester"]);
    const codex = await read(".codex/config.toml");
    expect(codex).toContain('command = "npx"');
    expect(codex).toContain('"--agent", "tester"]');
  });

  it("다시 친 init(--agent 없음)은 이름을 지우지 않는다 — agent.local 이 진실원", async () => {
    await executeInitCommand(options(["--agent", "tester"]));
    expect(await executeInitCommand(options([]))).toBe(0);

    expect(await read(".ainecto/agent.local")).toBe("tester\n");
    expect((await entryOf(".mcp.json")).headers).toEqual({ [AGENT_NAME_HEADER]: "tester" });
    expect(documentHeaders[1]?.[NAME_HEADER]).toBe("tester");
  });

  it("이름을 바꾸면 세 파일이 함께 바뀐다", async () => {
    await executeInitCommand(options(["--agent", "tester"]));
    expect(await executeInitCommand(options(["--agent", "reviewer02"]))).toBe(0);

    expect(await read(".ainecto/agent.local")).toBe("reviewer02\n");
    expect((await entryOf(".mcp.json")).headers).toEqual({ [AGENT_NAME_HEADER]: "reviewer02" });
    expect(await read(".codex/config.toml")).toContain('"reviewer02"');
  });

  it("남의 .codex/config.toml 은 병합하지 않고 그대로 둔다 — 넣을 줄을 안내", async () => {
    await mkdir(join(work, ".codex"));
    await writeFile(join(work, ".codex", "config.toml"), 'model = "o3"\n');

    expect(await executeInitCommand(options(["--agent", "tester"]))).toBe(0);

    expect(await read(".codex/config.toml")).toBe('model = "o3"\n');
    const notes = (JSON.parse(out.join("")) as { data: { notes: string[] } }).data.notes.join("\n");
    expect(notes).toContain("left untouched");
    expect(notes).toContain(`http_headers = { "${AGENT_NAME_HEADER}" = "tester" }`);
  });

  it("--undo 가 init 이 쓴 것을 전부 걷는다", async () => {
    await executeInitCommand(options(["--agent", "tester"]));
    expect(await executeInitCommand(options(["--undo"]))).toBe(0);

    for (const path of [".ainecto/agent.local", ".mcp.json", ".cursor/mcp.json", ".codex/config.toml", ".ainecto"]) {
      expect(existsSync(join(work, path))).toBe(false);
    }
  });

  it("★서버가 이름을 거절하면(400 AGENT_NAME_INVALID) 한 줄로 멈추고 아무 파일도 쓰지 않는다", async () => {
    const refuse = (async () => new Response(
      JSON.stringify({ error: "AGENT_NAME_INVALID", error_description: "Agent name must match [a-z0-9][a-z0-9._-]*." }),
      { status: 400 },
    )) as unknown as typeof fetch;

    await expect(executeInitCommand(options(["--agent", "Bad Name"], refuse))).rejects.toThrow(
      'AiNecto refused the agent name "Bad Name" (HTTP 400 — AGENT_NAME_INVALID: Agent name must match [a-z0-9][a-z0-9._-]*.). Nothing was changed.',
    );
    expect(existsSync(join(work, ".ainecto"))).toBe(false);
    expect(existsSync(join(work, ".mcp.json"))).toBe(false);
  });

  it("--agent 값이 없으면 멈춘다", async () => {
    await expect(executeInitCommand(options(["--agent"]))).rejects.toThrow("--agent requires a name.");
    await expect(executeInitCommand(options(["--agent", "  "]))).rejects.toThrow("--agent requires a name.");
  });

  it("이름이 없으면 지금과 같다 — MCP 파일·Codex 파일·agent.local 을 쓰지 않는다", async () => {
    expect(await executeInitCommand(options([]))).toBe(0);
    for (const path of [".ainecto/agent.local", ".mcp.json", ".codex/config.toml"]) {
      expect(existsSync(join(work, path))).toBe(false);
    }
    expect(Object.keys(documentHeaders[0]!)).not.toContain(NAME_HEADER);
  });
});
