import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ainectoBridge, AINECTO_CODEX_MCP_SERVER, AINECTO_MCP_SERVER, type AinectoBridge } from "../src/core/agent/agents";
import { ANTIGRAVITY_MCP_SERVER, antigravityMcpConfig } from "../src/core/agent/antigravityArgs";
import { claudeAgentArgs, claudeMcpConfig } from "../src/core/agent/claudeArgs";
import { codexAppServerArgs } from "../src/core/agent/codexArgs";
import { tokenKey } from "../src/core/auth/tokenStore";

/**
 * ★Room 읽기만 — 세 엔진 공통 인수(루트 판정 REQ 3644d7b6 · 리뷰 R2-b P1 의 후속 인수 기준).
 * 엔진마다 ★운영 인자 함수가 만든 MCP 설정에서 브리지 명령을 꺼내 그대로 띄우고(실제 bin 프로세스), 격리된 시험 서버에 붙여
 * 호스트처럼 tools/list · 읽기 호출 · 쓰기 호출을 보낸다. Room = 읽기 호출은 서버에 닿고 쓰기 처리기 호출 0 · Connect = 예전 그대로.
 */
const ROOT = resolve(__dirname, "..");
const CLI = join(ROOT, "src/bin/ainecto.ts");
const TOOLS = [
  { name: "execute_read", annotations: { readOnlyHint: true } },
  { name: "execute_edit", annotations: { readOnlyHint: false } },
];

let server: Server;
let endpoint: string;
let home: string;
/** 서버 tools/call 처리기에 닿은 이름(차례대로). */
const handled: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      const rpc = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
      const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      res.setHeader("content-type", "application/json");
      if (rpc.method === "tools/list") return reply({ tools: TOOLS });
      if (rpc.method === "tools/call") {
        handled.push(String(rpc.params?.name));
        return reply({ content: [{ type: "text", text: "ok" }] });
      }
      return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test", version: "0" } });
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  home = await mkdtemp(join(tmpdir(), "ainecto-room-bridge-"));
  await mkdir(join(home, ".ainecto"), { recursive: true });
  await writeFile(join(home, ".ainecto", "tokens.json"), JSON.stringify({
    [tokenKey(endpoint)]: { endpoint, accessToken: "seeded-token", tokenType: "Bearer", expiresAt: Date.now() + 3_600_000 },
  }), "utf8");
});

afterAll(async () => {
  await new Promise((closed) => server.close(closed));
  await rm(home, { recursive: true, force: true });
});

/** 엔진별 운영 인자 함수 → 그 설정이 띄우는 AiNecto 브리지 명령. */
const ENGINES: Record<string, (bridge: AinectoBridge, readOnly: boolean) => AinectoBridge> = {
  "claude-code": (bridge, readOnly) => {
    const args = claudeAgentArgs({ schema: {}, mcpConfig: claudeMcpConfig(bridge), ...(readOnly ? { readTools: ["execute_read"] } : {}) });
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]!) as { mcpServers: Record<string, AinectoBridge> };
    return config.mcpServers[AINECTO_MCP_SERVER]!;
  },
  // Codex 브리지 이름은 Claude 와 다르다(ainecto_cli — KAN-1617).
  codex: (bridge, readOnly) => {
    const args = codexAppServerArgs(bridge, readOnly ? [] : ["execute_edit"]);
    const value = (key: string) => args.find((a) => a.startsWith(`mcp_servers.${AINECTO_CODEX_MCP_SERVER}.${key}=`))!.split("=").slice(1).join("=");
    return { command: JSON.parse(value("command")) as string, args: JSON.parse(value("args")) as string[] };
  },
  antigravity: (bridge) => (antigravityMcpConfig(bridge) as { mcpServers: Record<string, AinectoBridge> }).mcpServers[ANTIGRAVITY_MCP_SERVER]!,
};

/** 그 브리지를 띄워 호스트처럼 말한다 — 답은 요청 id 순. */
async function hostSession(bridge: AinectoBridge): Promise<Array<{ id: number; result?: { tools?: Array<{ name: string }> }; error?: { code: number } }>> {
  const child = spawn(bridge.command, bridge.args, {
    cwd: ROOT,
    env: { ...process.env, HOME: home, NODE_OPTIONS: "--import tsx", AINECTO_TOKEN: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => { out += String(chunk); });
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-host", version: "0" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "execute_read", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "execute_edit", arguments: {} } },
  ];
  child.stdin.end(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await new Promise((closed) => child.on("close", closed));
  return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: number }).sort((a, b) => a.id - b.id);
}

describe("Room 읽기만 — 브리지가 세 엔진 공통으로 지킨다(실제 bin · 격리 시험 서버)", () => {
  for (const [engine, configOf] of Object.entries(ENGINES)) {
    it(`★${engine} — Room: 읽기 호출만 서버에 닿고 쓰기 처리기 호출 0 · Connect: 예전 그대로`, async () => {
      handled.length = 0;
      const room = await hostSession(configOf(ainectoBridge(process.execPath, CLI, endpoint, undefined, true), true));
      expect(room.find((a) => a.id === 2)!.result!.tools!.map((t) => t.name)).toEqual(["execute_read"]);
      expect(room.find((a) => a.id === 4)!.error?.code).toBe(-32602);
      expect(handled).toEqual(["execute_read"]);

      handled.length = 0;
      const connect = await hostSession(configOf(ainectoBridge(process.execPath, CLI, endpoint, undefined, false), false));
      expect(connect.find((a) => a.id === 2)!.result!.tools!.map((t) => t.name)).toEqual(["execute_read", "execute_edit"]);
      expect(handled).toEqual(["execute_read", "execute_edit"]);
    }, 60_000);
  }
});
