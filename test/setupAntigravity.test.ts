import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSetupCommand, type SetupCommandOptions } from "../src/adapters/cli/setupCommand";
import { systemCommandRunner } from "../src/core/setup/commandRunner";
import type { McpRpcClient } from "../src/core/mcp/rpcClient";
import { installFakeAgents, type FakeAgents } from "./support/fakeAgentClis";

/**
 * `ainecto setup` — Antigravity(전역 ~/.gemini/config/mcp_config.json · 등록 명령 없음 → JSON 병합). ★실 설정은 건드리지 않는다(임시 HOME).
 * 모양 근거: antigravity.google/docs/mcp — 원격은 {"serverUrl": …}.
 */
const ENDPOINT = "https://ainecto.com/mcp";
let home: string;
let fake: FakeAgents;
const out: string[] = [];
const configPath = () => join(home, ".gemini", "config", "mcp_config.json");

function options(argv: string[]): SetupCommandOptions {
  return {
    argv,
    endpoint: ENDPOINT,
    env: "prod",
    auth: { getAccessToken: async () => "t", login: async () => undefined },
    client: {
      initialize: async () => ({}),
      toolsCall: async () => ({ content: [{ type: "text", text: JSON.stringify({ userId: "u-1", displayName: "Ryan", jobProfile: { title: "PM" } }) }] }),
    } as unknown as McpRpcClient,
    runner: systemCommandRunner({ cwd: home, env: fake.env }),
    home,
    json: true,
    io: {
      stdout: { write: (text: string) => { out.push(text); return true; } },
      stderr: { write: () => true },
    } as unknown as SetupCommandOptions["io"],
  };
}
const result = () => JSON.parse(out.join("")).data as { agents: Array<{ client: string; label: string; status: string }>; next: string[] };
const antigravity = () => result().agents.find((agent) => agent.client === "antigravity");
const config = async () => JSON.parse(await readFile(configPath(), "utf8"));

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ainecto-setup-antigravity-"));
  fake = await installFakeAgents(home, []);
  await mkdir(join(home, ".gemini", "config"), { recursive: true });
  out.length = 0;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("ainecto setup — Antigravity", () => {
  it("serverUrl 로 병합하고 남의 서버는 그대로 · 로그인 안내는 Authenticate", async () => {
    await writeFile(configPath(), JSON.stringify({ mcpServers: { other: { serverUrl: "https://x.test/mcp" } } }));
    await executeSetupCommand(options([]));
    expect(antigravity()).toMatchObject({ label: "Antigravity", status: "connected" });
    expect((await config()).mcpServers).toEqual({ other: { serverUrl: "https://x.test/mcp" }, ainecto: { serverUrl: ENDPOINT } });
    expect(result().next.join("\n")).toContain("Authenticate");
  });

  it("빈 설정 파일(0바이트)도 항목 없음으로 보고 쓴다 · 다시 돌리면 already connected", async () => {
    await writeFile(configPath(), "");
    await executeSetupCommand(options([]));
    expect(antigravity()?.status).toBe("connected");
    out.length = 0;
    await executeSetupCommand(options([]));
    expect(antigravity()?.status).toBe("connected");
    expect((await config()).mcpServers.ainecto).toEqual({ serverUrl: ENDPOINT });
  });

  it("남의 주소인 ainecto 항목은 kept", async () => {
    await writeFile(configPath(), JSON.stringify({ mcpServers: { ainecto: { serverUrl: "https://mcp.example.com/mcp" } } }));
    await executeSetupCommand(options([]));
    expect(antigravity()?.status).toBe("kept");
  });

  it("--undo 는 우리 항목만 지운다", async () => {
    await writeFile(configPath(), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    await executeSetupCommand(options([]));
    out.length = 0;
    await executeSetupCommand(options(["--undo"]));
    expect(antigravity()?.status).toBe("removed");
    expect((await config()).mcpServers).toEqual({ other: { command: "x" } });
  });

  it("~/.gemini/config 가 없으면 not installed", async () => {
    await rm(join(home, ".gemini"), { recursive: true });
    await executeSetupCommand(options([]));
    expect(antigravity()?.status).toBe("not installed");
  });
});
