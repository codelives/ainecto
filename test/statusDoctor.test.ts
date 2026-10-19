import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeDoctorCommand, executeStatusCommand, type StatusCommandOptions } from "../src/adapters/cli/statusCommand";
import type { StoredTokenSet, TokenStore } from "../src/core/auth/tokenStore";
import { McpRpcError, type McpRpcClient } from "../src/core/mcp/rpcClient";
import { systemCommandRunner } from "../src/core/setup/commandRunner";
import { doctorChecks, olderThan } from "../src/core/setup/doctorChecks";
import type { CollectInput, MachineStatus } from "../src/core/setup/machineStatus";
import { installFakeAgents, type FakeAgents } from "./support/fakeAgentClis";

const ENDPOINT = "https://ainecto.com/mcp";

let home: string;
let repo: string;
let fake: FakeAgents;
const out: string[] = [];

const store = (token?: Partial<StoredTokenSet>): TokenStore => ({
  load: async () => token as StoredTokenSet | undefined,
  save: async () => undefined,
  delete: async () => undefined,
});

function accountClient(jobProfile: unknown = { title: "QA Engineer" }): McpRpcClient {
  return {
    initialize: async () => ({}),
    toolsCall: async (name: string) => ({
      content: [{ type: "text", text: JSON.stringify(name === "identity_get_self"
        ? { userId: "u-1", displayName: "Ryan", jobProfile }
        : { projects: [{ uuid: "p-1", name: "A" }] }) }],
    }),
  } as unknown as McpRpcClient;
}

function collect(extra: Partial<CollectInput> = {}): CollectInput {
  const runner = systemCommandRunner({ cwd: home, env: fake.env });
  return {
    endpoint: ENDPOINT,
    env: "prod",
    cliVersion: "0.8.0",
    tokenStore: store({ endpoint: ENDPOINT, accessToken: "SECRET-TOKEN", expiresAt: Date.now() + 3_600_000 }),
    auth: { getAccessToken: async () => "SECRET-TOKEN" },
    client: accountClient(),
    runner,
    hereRunner: runner,
    home,
    cwd: repo,
    envVars: {},
    ...extra,
  };
}

function options(extra: Partial<CollectInput> = {}): StatusCommandOptions {
  return {
    argv: [],
    collect: collect(extra),
    json: true,
    io: { stdout: { write: (text: string) => { out.push(text); return true; } }, stderr: { write: () => true } } as never,
  };
}

const data = () => JSON.parse(out.join("")).data;
const check = (item: string) => (data().checks as Array<{ item: string; level: string; fix?: string; detail: string }>)
  .find((entry) => entry.item === item);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ainecto-doctor-home-"));
  repo = await mkdtemp(join(tmpdir(), "ainecto-doctor-repo-"));
  await mkdir(join(repo, ".git"));
  fake = await installFakeAgents(home);
  await mkdir(join(home, ".cursor"));
  out.length = 0;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe("ainecto status", () => {
  it("읽기 전용 한 화면 — 계정·직무·연결·저장소, 토큰 값·이메일은 없다", async () => {
    await fake.seed("claude", "cmd|npx -y @ainecto/mcp@0.8.0");

    expect(await executeStatusCommand(options())).toBe(0);

    const view = data();
    expect(view.account).toMatchObject({ signedIn: true, userId: "u-1", name: "Ryan", role: "QA Engineer", projects: 1 });
    expect(view.agents).toContainEqual({ client: "Claude Code", state: "connected (user)", bridge: "@ainecto/mcp@0.8.0" });
    expect(view.agents).toContainEqual({ client: "Codex", state: "not connected" });
    expect(view.repository).toMatchObject({ root: repo, git: true, harnessDoc: false });
    const text = out.join("");
    expect(text).not.toContain("SECRET-TOKEN");
    expect(text).not.toMatch(/email/i);
    // 읽기만 — 아무 add/remove 도 돌리지 않는다.
    expect((await fake.log("claude")).filter((line) => !line.startsWith("mcp get"))).toEqual([]);
  });
});

describe("ainecto doctor", () => {
  it("모두 맞으면 fail 0 — 종료 0", async () => {
    await fake.seed("claude", "cmd|npx -y @ainecto/mcp@0.8.0");
    await fake.seed("codex", "cmd|npx -y @ainecto/mcp@0.8.0");
    await writeFile(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { ainecto: { command: "npx", args: ["-y", "@ainecto/mcp@0.8.0"] } } }));

    expect(await executeDoctorCommand(options())).toBe(0);
    expect(data().summary).toBe("all good");
  });

  it("★로그인 없음 → fail + `ainecto setup`, 종료 1", async () => {
    expect(await executeDoctorCommand(options({
      tokenStore: store(undefined), auth: { getAccessToken: async () => undefined },
    }))).toBe(1);
    expect(check("sign-in")).toMatchObject({ level: "fail", fix: "ainecto setup" });
  });

  it("★옛 설정 잔존 — 저장소 --role·config project → `ainecto init`, AINECTO_ROLE·AI_ERD_ROLE·Codex 역할 프로필 → 지워도 된다", async () => {
    await writeFile(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { ainecto: { command: "npx", args: ["-y", "@ainecto/mcp", "--role", "design"] } } }));
    await mkdir(join(repo, ".ainecto"));
    await writeFile(join(repo, ".ainecto", "config.json"), JSON.stringify({ version: 1, project: { uuid: "p-1" } }));
    const codexHome = join(home, "codex-home");
    await mkdir(codexHome);
    await writeFile(join(codexHome, "design.config.toml"), '[mcp_servers.ainecto]\ncommand = "npx"\nargs = ["-y","@ainecto/mcp","--role","design"]\n');
    await writeFile(join(codexHome, "other.config.toml"), 'model = "o3"\n');

    const code = await executeDoctorCommand(options({ envVars: { AINECTO_ROLE: "design", AI_ERD_ROLE: "x", CODEX_HOME: codexHome } }));

    // 잔존은 warn — 지금도 동작한다(0.8.0 이 옛 입력을 받아 넘긴다).
    expect(code).toBe(0);
    expect(check("repository")).toMatchObject({ level: "warn", fix: `ainecto init (in ${repo})` });
    expect(check("repository")!.detail).toContain(".mcp.json passes the removed --role");
    expect(check("repository")!.detail).toContain("old project field");
    expect(check("AINECTO_ROLE")).toMatchObject({ level: "warn", fix: "unset AINECTO_ROLE (it can be deleted)" });
    expect(check("AI_ERD_ROLE")?.level).toBe("warn");
    expect(check("Codex role profiles")!.detail).toContain("design.config.toml");
    expect(check("Codex role profiles")!.detail).not.toContain("other.config.toml");
  });

  it("에이전트 — 미연결·옛 --role·낮은 고정 판·남의 항목을 각각 고칠 명령과 함께", async () => {
    await fake.seed("claude", "cmd|npx -y @ainecto/mcp --role development");
    await fake.seed("codex", "url|https://ainecto.com/mcp");
    await writeFile(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { ainecto: { command: "npx", args: ["-y", "@ainecto/mcp@0.7.9"] } } }));

    await executeDoctorCommand(options());

    expect(check("Claude Code")).toMatchObject({ level: "warn", fix: "ainecto setup" });
    expect(check("Claude Code")!.detail).toContain("removed --role");
    expect(check("Cursor")!.detail).toContain("@ainecto/mcp@0.7.9; 0.8.0 is available");
    expect(check("Codex")!.detail).toContain("someone else's");
  });

  it("★PATH 의 ainecto 가 낮으면 `npm i -g ainecto@latest`", async () => {
    await writeFile(join(fake.bin, "ainecto"), '#!/bin/sh\necho \'{"ok":true,"data":{"version":"0.7.0"}}\'\n', "utf8");
    await chmod(join(fake.bin, "ainecto"), 0o755);

    await executeDoctorCommand(options());

    expect(check("global ainecto")).toMatchObject({ level: "warn", fix: "npm i -g ainecto@latest" });
  });

  it("★직무 미설정은 warn — 실패가 아니다(설정 링크)", async () => {
    await fake.seed("claude", "cmd|npx -y @ainecto/mcp@0.8.0");
    expect(await executeDoctorCommand(options({ client: accountClient(null) }))).toBe(0);
    expect(check("AiNecto role")).toMatchObject({ level: "warn", fix: "set it at https://ainecto.com/home/settings" });
  });

  it("서버 거절의 원인을 가른다 — 401 / 403(요금제) / 네트워크", async () => {
    const failing = (error: Error) => ({ initialize: async () => { throw error; } }) as unknown as McpRpcClient;
    const cases: Array<[Error, RegExp]> = [
      [new McpRpcError("x", "MCP_HTTP_ERROR", { status: 401 }), /HTTP 401/],
      [new McpRpcError("x", "MCP_HTTP_ERROR", { status: 403 }), /plan does not include MCP/],
      [new TypeError("fetch failed"), /cannot reach/],
    ];
    for (const [error, detail] of cases) {
      out.length = 0;
      expect(await executeDoctorCommand(options({ client: failing(error) }))).toBe(1);
      expect(check("server")!.detail).toMatch(detail);
    }
  });
});

describe("doctorChecks — 순수 판정", () => {
  const base: MachineStatus = {
    cliVersion: "0.8.0", endpoint: ENDPOINT, env: "prod", token: { state: "signed-in" }, agents: [],
    legacyEnv: [], legacyCodexProfiles: [],
  };

  it("이 폴더의 Claude local 범위 항목이 사용자 범위를 가리면 warn", () => {
    const checks = doctorChecks({
      ...base,
      claudeHere: { client: "claude-code", installed: true, scope: "local", entry: { url: "https://x" }, ours: false, carriesRole: false },
    });
    expect(checks).toContainEqual(expect.objectContaining({ item: "Claude Code (this folder)", fix: "claude mcp remove ainecto -s local" }));
  });

  it("판 비교 — dev 같은 비판본은 판정하지 않는다", () => {
    expect(olderThan("0.7.9", "0.8.0")).toBe(true);
    expect(olderThan("0.8.0", "0.8.0")).toBe(false);
    expect(olderThan("0.10.0", "0.8.0")).toBe(false);
    expect(olderThan("0.7.0", "dev")).toBe(false);
    expect(olderThan(undefined, "0.8.0")).toBe(false);
  });
});
