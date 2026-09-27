import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createdChain, executeInitCommand, readRepositoryRole } from "../src/adapters/cli/initCommand";
import { readRecordBody } from "../src/core/harness/initPlan";

const RECORD_FILE = ".ai-erd/init-record.json";

/**
 * 되돌리기 기록. ★«기록 파일»에서 읽는다 — 7차 독립 리뷰 뒤에 기록을 config 에서 자기 파일로
 * 내보냈다. 한 파일에 주인이 둘이라 「이 칸이 누구 것인가」를 매번 판정해야 했고, 그 판정이
 * 네 차수 연속 샜다.
 */
async function recordOf(root: string) {
  return readRecordBody(await readFile(join(root, RECORD_FILE), "utf8"));
}

import { McpRpcError } from "../src/core/mcp/rpcClient";
import type { McpRpcClient } from "../src/core/mcp/rpcClient";
import type { HarnessRole } from "../src/core/harness/role";

/**
 * 계획이 아니라 «실제로 디스크에 무엇이 생기는가»를 본다.
 * 네트워크는 안 탄다 — 프로젝트 조회만 가짜 client 로 바꾼다.
 */
describe("ai-erd init (files on disk)", () => {
  let root: string;
  const out: string[] = [];

  const io = {
    stdout: { write: (text: string) => { out.push(text); return true; } },
    stderr: { write: () => true },
  } as unknown as { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream };

  function client(projects: Array<{ uuid: string; name: string }>, created?: { uuid: string; name: string }) {
    const calls: string[] = [];
    const stub = {
      toolsCall: async (name: string) => {
        calls.push(name);
        const payload = name === "create_projects" ? { created: [created] } : { projects };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      },
    } as unknown as McpRpcClient;
    return { stub, calls };
  }

  function options(argv: string[], rpc: McpRpcClient) {
    // ★--role 은 이제 «전역» 플래그다 — 한 번 정해서 로그인·브리지·도구 호출이 같이 쓴다.
    const roleIndex = argv.indexOf("--role");
    const role = roleIndex >= 0 ? (argv[roleIndex + 1] as HarnessRole) : undefined;
    const rest = roleIndex >= 0
      ? argv.filter((_, i) => i !== roleIndex && i !== roleIndex + 1)
      : argv;
    return {
      argv: rest,
      role,
      client: rpc,
      endpoint: "https://ai-erd.com/mcp",
      env: "prod" as const,
      cliVersion: "@ai-erd/mcp test",
      cwd: root,
      json: true,
      io,
    };
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ai-erd-init-"));
    out.length = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("wires a fresh repository and binds the single project it finds", async () => {
    const { stub, calls } = client([{ uuid: "p-1", name: "Billing" }]);

    const code = await executeInitCommand(options(["--role", "development"], stub));

    expect(code).toBe(0);
    expect(calls).toEqual(["list_projects"]);
    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers["ai-erd"].args).toEqual(["-y", "@ai-erd/mcp", "--role", "development"]);
    expect(JSON.parse(await readFile(join(root, ".ai-erd/config.json"), "utf8")).project.uuid).toBe("p-1");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain("AI-ERD Harness");
    expect(existsSync(join(root, ".cursor/mcp.json"))).toBe(true);
  });

  it("stops and lists when more than one project could be meant", async () => {
    const { stub } = client([{ uuid: "p-1", name: "A" }, { uuid: "p-2", name: "B" }]);

    const code = await executeInitCommand(options(["--role", "design"], stub));

    expect(code).toBe(1);
    expect(out.join("")).toContain("Re-run with --project <uuid>");
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  });

  it("refuses to create a project without --yes", async () => {
    const { stub } = client([]);

    await expect(executeInitCommand(options(["--role", "design"], stub))).rejects.toThrow(/--yes/);
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  });

  it("creates one when told to, naming it after the directory", async () => {
    const { stub, calls } = client([], { uuid: "p-new", name: "whatever" });

    const code = await executeInitCommand(options(["--role", "test", "--yes"], stub));

    expect(code).toBe(0);
    expect(calls).toEqual(["list_projects", "create_projects"]);
    expect(JSON.parse(await readFile(join(root, ".ai-erd/config.json"), "utf8")).project.uuid).toBe("p-new");
  });

  it("dry-run touches nothing", async () => {
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);

    await executeInitCommand(options(["--role", "development", "--dry-run"], stub));

    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
    expect(existsSync(join(root, ".ai-erd"))).toBe(false);
  });

  it("keeps the role when re-run without one, and remembers the bound project", async () => {
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "validation"], stub));

    const code = await executeInitCommand(options([], stub));

    expect(code).toBe(0);
    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers["ai-erd"].args).toContain("validation");
  });

  it("gives the repository back byte for byte on --undo", async () => {
    const originalMcp = `${JSON.stringify({ mcpServers: { sentry: { type: "http", url: "https://x" } } }, null, 2)}\n`;
    const originalAgents = "# House rules\n\nBe careful.\n";
    await writeFile(join(root, ".mcp.json"), originalMcp, "utf8");
    await writeFile(join(root, "AGENTS.md"), originalAgents, "utf8");
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));

    await executeInitCommand(options(["--undo"], stub));

    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(originalMcp);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(originalAgents);
    expect(existsSync(join(root, ".ai-erd"))).toBe(false);
    // 우리가 만든 것만 사라진다
    expect(existsSync(join(root, ".cursor/mcp.json"))).toBe(false);
  });

  it("★심볼릭 링크로 저장소 밖 파일을 고치지 않는다", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ai-erd-outside-"));
    await writeFile(join(outside, "rules.md"), "NOT OURS\n", "utf8");
    await symlink(join(outside, "rules.md"), join(root, "AGENTS.md"));
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);

    await expect(executeInitCommand(options(["--role", "development"], stub)))
      .rejects.toThrow(/symbolic link|outside the repository/);
    expect(await readFile(join(outside, "rules.md"), "utf8")).toBe("NOT OURS\n");
    await rm(outside, { recursive: true, force: true });
  });

  it("★.ai-erd 가 저장소 밖을 가리켜도 그곳 파일이 남는다", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ai-erd-outside-"));
    await writeFile(join(outside, "config.json"), "MINE\n", "utf8");
    await writeFile(join(outside, "HARNESS.md"), "MINE\n", "utf8");
    await symlink(outside, join(root, ".ai-erd"));
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);

    // ★읽기도 경계 검사를 먼저 통과한다 — 남의 파일은 «읽지도» 않는다.
    await expect(executeInitCommand(options(["--undo"], stub)))
      .rejects.toThrow(/outside the repository|symbolic link/);
    expect(await readFile(join(outside, "config.json"), "utf8")).toBe("MINE\n");

    // init 은 그 링크를 통해 쓰려다 경계에서 멈춘다.
    await expect(executeInitCommand(options(["--role", "development"], stub)))
      .rejects.toThrow(/outside the repository|symbolic link/);
    expect(await readFile(join(outside, "HARNESS.md"), "utf8")).toBe("MINE\n");
    await rm(outside, { recursive: true, force: true });
  });

  it("★남의 설정 파일 권한을 넓히지 않는다", async () => {
    const mine = `${JSON.stringify({ mcpServers: { other: { command: "x", env: { SECRET: "s" } } } }, null, 2)}\n`;
    await writeFile(join(root, ".mcp.json"), mine, { encoding: "utf8", mode: 0o600 });
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);

    await executeInitCommand(options(["--role", "development"], stub));

    // rename 은 inode 를 갈아치운다 — 권한을 안 옮기면 umask 기본값(보통 0644)이 된다.
    expect((await stat(join(root, ".mcp.json"))).mode & 0o777).toBe(0o600);
  });

  it("★--dry-run 은 원격에 프로젝트를 만들지 않는다", async () => {
    const { stub, calls } = client([], { uuid: "p-new", name: "x" });

    await expect(executeInitCommand(options(["--role", "test", "--yes", "--dry-run"], stub)))
      .rejects.toThrow(/--dry-run cannot continue/);
    expect(calls).toEqual(["list_projects"]);
  });

  it("★조회를 기다리는 사이 파일이 바뀌면 덮지 않는다", async () => {
    await writeFile(join(root, ".mcp.json"), `${JSON.stringify({ mcpServers: {} })}\n`, "utf8");
    const mine = `${JSON.stringify({ mcpServers: { other: { url: "https://x" } } }, null, 2)}\n`;
    const stub = {
      toolsCall: async () => {
        // 네트워크를 기다리는 동안 다른 사람이 같은 파일을 고쳤다.
        await writeFile(join(root, ".mcp.json"), mine, "utf8");
        return { content: [{ type: "text", text: JSON.stringify({ projects: [{ uuid: "p-1", name: "B" }] }) }] };
      },
    } as unknown as McpRpcClient;

    await expect(executeInitCommand(options(["--role", "development"], stub)))
      .rejects.toThrow(/changed while init was running/);
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(mine);
  });

  it("★기본이 아닌 endpoint 를 설정에도 싣는다", async () => {
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);

    await executeInitCommand({
      ...options(["--role", "development"], stub),
      endpoint: "https://custom.example/mcp",
    });

    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers["ai-erd"].args).toContain("--endpoint");
    expect(mcp.mcpServers["ai-erd"].args).toContain("https://custom.example/mcp");
  });

  it("★로그인 안 된 채로 부르면 «무엇을 하라»고 말한다", async () => {
    // 실물로 처음 돌려 보고 나온 것 — 새 사용자의 첫 명령이 HTTP 401 한 줄로 죽었다.
    const stub = {
      toolsCall: async () => {
        throw new McpRpcError("MCP HTTP request failed with HTTP 401.", "MCP_HTTP_ERROR", { status: 401 });
      },
    } as unknown as McpRpcClient;

    await expect(executeInitCommand(options(["--role", "development"], stub)))
      .rejects.toThrow(/ai-erd auth login --role development/);
    // 기본 주소면 --endpoint 를 덧붙이지 않는다 — 안 쓰는 플래그를 가르치지 않는다.
    await expect(executeInitCommand(options(["--role", "development"], stub)))
      .rejects.not.toThrow(/--endpoint/);
    // 아무것도 쓰지 않았다.
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  });

  it("★안내하는 로그인 명령이 «같은 서버»를 가리킨다", async () => {
    const stub = {
      toolsCall: async () => {
        throw new McpRpcError("MCP HTTP request failed with HTTP 401.", "MCP_HTTP_ERROR", { status: 401 });
      },
    } as unknown as McpRpcClient;

    await expect(executeInitCommand({
      ...options(["--role", "test"], stub),
      endpoint: "https://custom.example/mcp",
    })).rejects.toThrow(/--role test --endpoint https:\/\/custom\.example\/mcp/);
  });

  it("401 이 아닌 실패는 그대로 올린다", async () => {
    const stub = {
      toolsCall: async () => {
        throw new McpRpcError("MCP HTTP request failed with HTTP 503.", "MCP_HTTP_ERROR", { status: 503 });
      },
    } as unknown as McpRpcClient;

    await expect(executeInitCommand(options(["--role", "development"], stub)))
      .rejects.toThrow(/HTTP 503/);
  });

  it("★undo 가 우리가 만든 빈 디렉터리를 남기지 않는다", async () => {
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));
    expect(existsSync(join(root, ".cursor"))).toBe(true);

    await executeInitCommand(options(["--undo"], stub));

    expect(existsSync(join(root, ".cursor"))).toBe(false);
    expect(existsSync(join(root, ".ai-erd"))).toBe(false);
  });

  it("★config 를 고치면 undo 가 지우지 않는다 (자기 지문)", async () => {
    // 2026-09-23 독립 재리뷰 I7 — 지문을 문자열을 «만든 뒤»에 넣어서 파일에는 자기 지문이 없었다.
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));

    const configPath = join(root, ".ai-erd/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.myOwnField = "keep me";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    await executeInitCommand(options(["--undo"], stub));

    expect(existsSync(configPath)).toBe(true);
    expect(JSON.parse(await readFile(configPath, "utf8")).myOwnField).toBe("keep me");
  });

  it("손대지 않은 config 는 undo 가 정상적으로 지운다", async () => {
    // 위 보호가 «전부 남김»으로 흐르지 않는지 — 안 건드렸으면 깨끗이 사라져야 한다.
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));

    await executeInitCommand(options(["--undo"], stub));

    expect(existsSync(join(root, ".ai-erd/config.json"))).toBe(false);
  });

  it("★우리 MCP 항목을 손대면 undo 가 남긴다", async () => {
    // 2026-09-23 독립 재리뷰 I8 — 파일 전체 지문만 보면 「우리 항목을 고쳤다」를 못 본다.
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));

    const mcpPath = join(root, ".mcp.json");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
    mcp.mcpServers["ai-erd"].env = { MY_FLAG: "1" };
    await writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, "utf8");

    await executeInitCommand(options(["--undo"], stub));

    const after = JSON.parse(await readFile(mcpPath, "utf8"));
    expect(after.mcpServers["ai-erd"].env).toEqual({ MY_FLAG: "1" });
  });

  it("★우리 블록 «안에» 적은 글을 undo 가 지우지 않는다", async () => {
    await writeFile(join(root, "AGENTS.md"), "# House rules\n\nMine.\n", "utf8");
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));

    const agentsPath = join(root, "AGENTS.md");
    const withNote = await readFile(agentsPath, "utf8");
    await writeFile(agentsPath, withNote.replace("<!-- ai-erd:end -->", "MY OWN LINE\n<!-- ai-erd:end -->"), "utf8");

    await executeInitCommand(options(["--undo"], stub));

    const after = await readFile(agentsPath, "utf8");
    expect(after).toContain("MY OWN LINE");
    expect(after).toContain("Mine.");
  });

  it("★init 전부터 있던 HARNESS.md 의 «이후 편집»을 원본으로 덮지 않는다", async () => {
    await mkdir(join(root, ".ai-erd"), { recursive: true });
    await writeFile(join(root, ".ai-erd/HARNESS.md"), "my original\n", "utf8");
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));

    await writeFile(join(root, ".ai-erd/HARNESS.md"), "edited after init\n", "utf8");
    await executeInitCommand(options(["--undo"], stub));

    expect(await readFile(join(root, ".ai-erd/HARNESS.md"), "utf8")).toBe("edited after init\n");
  });

  it("★중간에 실패해도 되돌릴 «기록»은 남는다", async () => {
    // 2026-09-23 독립 재리뷰 I11 — 기록이 마지막 쓰기라, 중간 실패는 되돌릴 수 없는 상태를 남겼다.
    // 사전 검사는 통과하지만 «쓸 때» 실패하는 상황: 쓰기 권한 없는 디렉터리.
    await mkdir(join(root, ".cursor"), { recursive: true });
    await chmod(join(root, ".cursor"), 0o555);
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);

    try {
      await expect(executeInitCommand(options(["--role", "development"], stub))).rejects.toThrow();
      // ★실패했어도 기록이 먼저 디스크에 있다 — 그래야 undo 가 앞서 바꾼 것을 되돌린다.
      expect(existsSync(join(root, RECORD_FILE))).toBe(true);
    } finally {
      await chmod(join(root, ".cursor"), 0o755);
    }
  });

  it("★--undo 는 토큰을 건드리지 않는다", async () => {
    // 로컬 되돌리기가 네트워크에 기대면, 서버가 죽은 날 되돌릴 수가 없다(S1).
    const { stub } = client([]);
    let asked = 0;

    await executeInitCommand({
      ...options(["--undo"], stub),
      accessToken: async () => { asked += 1; return "t"; },
    });

    expect(asked).toBe(0);
  });

  it("★저장소에 걸린 역할을 «인증보다 먼저» 읽는다", async () => {
    // 2026-09-23 독립 재리뷰 I10 — 바깥 CLI 가 플래그만 보고 클라이언트를 먼저 만들어,
    // 저장소는 development 인데 무역할 슬롯을 뒤지다 401 로 끝났다.
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    expect(await readRepositoryRole(root)).toBeUndefined();

    await executeInitCommand(options(["--role", "test"], stub));

    expect(await readRepositoryRole(root)).toBe("test");
  });

  it("★같은 설정으로 다시 init 해도 조각 지문을 잊지 않는다", async () => {
    // 4차 독립 리뷰 I3 — 이전 기록을 베낄 때 lastWrittenFragment 만 빠져서, 내용이 같은
    // 두 번째 init 뒤에 소유권 판정이 파일 전체 지문으로 후퇴했다.
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));
    await executeInitCommand(options(["--role", "development"], stub));

    const managed = (await recordOf(root))!;
    expect(Object.keys(managed.lastWrittenFragment)).toHaveLength(3);

    // 블록 «바깥»에만 쓴 글은 보존하면서 우리 블록은 정상적으로 걷어낸다.
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, `${await readFile(agentsPath, "utf8")}\nOUTSIDE THE BLOCK\n`, "utf8");
    await executeInitCommand(options(["--undo"], stub));

    const after = await readFile(agentsPath, "utf8");
    expect(after).toContain("OUTSIDE THE BLOCK");
    expect(after).not.toContain("AI-ERD Harness");
  });

  it("★역할 추론도 저장소 경계 검사를 지난다", async () => {
    // 4차 독립 리뷰 I5 — 나중에 붙인 읽기 경로가 assertInsideRepository 없이 파일을 «한 번 읽었다».
    const outside = join(root, "..", `outside-${Date.now()}.json`);
    await writeFile(outside, JSON.stringify({ mcpServers: {} }), "utf8");
    await symlink(outside, join(root, ".mcp.json"));

    await expect(readRepositoryRole(root)).rejects.toThrow();
    await rm(outside, { force: true });
  });

  it("★칸 순서만 바뀐 것은 «편집»이 아니다", async () => {
    // 4차 독립 리뷰 S1 — 편집기로 열었다 저장만 해도 사용자 편집으로 잡혔다.
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));

    const mcpPath = join(root, ".mcp.json");
    const entry = JSON.parse(await readFile(mcpPath, "utf8")).mcpServers["ai-erd"];
    const reordered = Object.fromEntries(Object.entries(entry).reverse());
    await writeFile(mcpPath, `${JSON.stringify({ mcpServers: { "ai-erd": reordered } }, null, 2)}\n`, "utf8");

    await executeInitCommand(options(["--undo"], stub));

    expect(existsSync(mcpPath)).toBe(false);
  });

  it("★dev 기본 주소에서 막히면 안내에 env 가 실린다", async () => {
    // 4차 독립 리뷰 S2 — 안내를 그대로 치면 «운영» 슬롯에 로그인하고 같은 자리에서 또 막혔다.
    const stub = {
      toolsCall: async () => {
        throw new McpRpcError("MCP HTTP request failed with HTTP 401.", "MCP_HTTP_ERROR", { status: 401 });
      },
    } as unknown as McpRpcClient;

    await expect(executeInitCommand({
      ...options(["--role", "development"], stub),
      env: "dev" as const,
      endpoint: "https://dev.ai-erd.com/mcp",
    })).rejects.toThrow(/--role development --env dev/);
  });

  it("★init 전부터 있던 빈 디렉터리는 undo 가 남긴다", async () => {
    // 4차 독립 리뷰 S3 — 「비었으면 치운다」는 우리 것인지를 안 본다.
    await mkdir(join(root, ".cursor"), { recursive: true });
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));

    await executeInitCommand(options(["--undo"], stub));

    expect(existsSync(join(root, ".cursor"))).toBe(true);
    expect(existsSync(join(root, ".cursor/mcp.json"))).toBe(false);
    // 우리가 만든 .ai-erd 는 그대로 치운다.
    expect(existsSync(join(root, ".ai-erd"))).toBe(false);
  });

  it("★되돌리지 못한 것이 남으면 기록을 지우지 않는다", async () => {
    // 4차 독립 리뷰 I2 — 충돌을 남긴 바로 그 실행이 «원본 백업이 든» config 를 지웠다.
    await writeFile(join(root, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { "ai-erd": { command: "mine" } } }, null, 2)}\n`, "utf8");
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));

    // 사용자가 우리 항목을 손댄다 → undo 는 그것을 남긴다.
    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    mcp.mcpServers["ai-erd"].env = { MY_FLAG: "1" };
    await writeFile(join(root, ".mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
    await executeInitCommand(options(["--undo"], stub));

    // 기록이 남아 있어야, 충돌을 풀고 다시 undo 할 때 원본을 되돌릴 수 있다.
    expect(existsSync(join(root, RECORD_FILE))).toBe(true);
    const managed = (await recordOf(root))!;
    expect(managed.replacedEntries[".mcp.json"]).toEqual({ command: "mine" });
  });

  it("★이미 원본으로 돌아온 항목을 «충돌»로 세지 않는다", async () => {
    // 5차 독립 리뷰 I3 — 일부만 복구된 뒤 다시 undo 하면 끝난 항목까지 충돌로 잡혀 영영 안 끝났다.
    await writeFile(join(root, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { "ai-erd": { command: "mine" } } }, null, 2)}\n`, "utf8");
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));

    // 사용자가 손수 원본으로 되돌려 놓았다.
    await writeFile(join(root, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { "ai-erd": { command: "mine" } } }, null, 2)}\n`, "utf8");
    out.length = 0;
    await executeInitCommand(options(["--undo"], stub));

    expect(out.join("")).toContain("already back in place");
    // 끝났으므로 기록도 남지 않는다.
    expect(existsSync(join(root, ".ai-erd/config.json"))).toBe(false);
  });

  it("★기록은 «줄어서» 남는다 — 끝난 항목은 지워진다", async () => {
    await writeFile(join(root, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { "ai-erd": { command: "mine" } } }, null, 2)}\n`, "utf8");
    await writeFile(join(root, "AGENTS.md"), "# House rules\n\nMine.\n", "utf8");
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));

    // AGENTS 블록만 손대서 충돌로 남긴다 — MCP 는 정상 복구된다.
    const agents = join(root, "AGENTS.md");
    await writeFile(agents, (await readFile(agents, "utf8"))
      .replace("<!-- ai-erd:end -->", "MINE INSIDE\n<!-- ai-erd:end -->"), "utf8");
    await executeInitCommand(options(["--undo"], stub));

    const managed = (await recordOf(root))!;
    // 끝난 MCP 항목의 백업은 사라졌고, 아직 남은 AGENTS 기록만 있다.
    expect(managed.replacedEntries[".mcp.json"]).toBeUndefined();
    expect(managed.blockAdded).toContain("AGENTS.md");
    // 그리고 실제로 MCP 원본은 돌아와 있다.
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers["ai-erd"])
      .toEqual({ command: "mine" });
  });

  it("★백업을 든 파일이 사라지면 기록을 지키지 않는다", async () => {
    // 5차 독립 리뷰 I2 — 「없으니 건너뛴다」가 그 원본을 영영 버렸다.
    await writeFile(join(root, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { "ai-erd": { command: "mine" } } }, null, 2)}\n`, "utf8");
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));

    await rm(join(root, ".mcp.json"));
    out.length = 0;
    await executeInitCommand(options(["--undo"], stub));

    expect(out.join("")).toContain("the backup is kept");
    const managed = (await recordOf(root))!;
    expect(managed.replacedEntries[".mcp.json"]).toEqual({ command: "mine" });
  });

  it("★변경 없는 재실행은 파일을 바꾸지 않는다 (끝 개행이 늘지 않는다)", async () => {
    // 5차 독립 리뷰 S2 — 605 → 606 → 607 로 1바이트씩 자랐다.
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));
    const first = await readFile(join(root, "AGENTS.md"), "utf8");

    await executeInitCommand(options(["--role", "development"], stub));
    await executeInitCommand(options(["--role", "development"], stub));

    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(first);
  });

  it("leaves a user's own file inside .ai-erd alone", async () => {
    await mkdir(join(root, ".ai-erd"), { recursive: true });
    await writeFile(join(root, ".ai-erd/notes.md"), "mine\n", "utf8");
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));

    await executeInitCommand(options(["--undo"], stub));

    expect(await readFile(join(root, ".ai-erd/notes.md"), "utf8")).toBe("mine\n");
  });
});

/**
 * 2026-09-27 6차 독립 리뷰 S1 — 「누가 만들었는가」.
 *
 * ★두 차수를 같은 자리에서 틀렸다. 4차엔 「지금 없으니 우리가 만들 것」으로 기록했고(계획),
 * 5차엔 그걸 «끝난 뒤 stat» 으로 고치려 했다. 그런데 stat 은 「있다」만 말한다 — 중간에 실패한
 * 뒤 사용자가 그 디렉터리를 만들면 둘 다 그것을 우리 것으로 읽는다.
 * ⇒ 이제 진실원은 {@code mkdir(recursive)} 의 반환값 하나다. «만든 행위»가 곧 소유의 증거다.
 */
describe("★S1 디렉터리 소유는 mkdir 이 답한다", () => {
  const root = "/repo";

  it("mkdir 이 아무것도 안 만들었다고 하면 우리 것이 없다", () => {
    // 이미 있던 디렉터리 — 「있다」와 「우리가 만들었다」가 갈리는 지점이다.
    expect(createdChain(root, undefined, "/repo/.cursor")).toEqual([]);
  });

  it("mkdir 이 만든 «가장 위»부터 목표까지가 전부 우리 것이다", () => {
    // recursive 는 자기가 만든 최상위 하나만 돌려준다. 그 아래도 같이 생긴 것이다.
    expect(createdChain(root, "/repo/.a", "/repo/.a/b/c")).toEqual([".a/b/c", ".a/b", ".a"]);
    expect(createdChain(root, "/repo/.ai-erd", "/repo/.ai-erd")).toEqual([".ai-erd"]);
  });

  it("저장소 밖은 기록하지 않는다", () => {
    expect(createdChain(root, "/", "/repo")).not.toContain("..");
  });
});

describe("★S1 이미 있던 빈 디렉터리는 우리 것으로 기록되지 않는다", () => {
  let root: string;
  const out: string[] = [];
  const io = {
    stdout: { write: (text: string) => { out.push(text); return true; } },
    stderr: { write: () => true },
  } as unknown as { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ai-erd-dirs-"));
    out.length = 0;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("사용자가 먼저 만들어 둔 .cursor 는 기록에 없고, 우리가 만든 .ai-erd 는 있다", async () => {
    await mkdir(join(root, ".cursor"), { recursive: true });
    const stub = {
      toolsCall: async () => ({
        content: [{ type: "text", text: JSON.stringify({ projects: [{ uuid: "p-1", name: "Billing" }] }) }],
      }),
    } as unknown as McpRpcClient;

    const code = await executeInitCommand({
      argv: [], role: "development" as HarnessRole, client: stub,
      endpoint: "https://ai-erd.com/mcp", env: "prod" as const,
      cliVersion: "@ai-erd/mcp test", cwd: root, json: true, io,
    });

    expect(code).toBe(0);
    const managed = (await recordOf(root))!;
    expect(managed.createdDirectories).toContain(".ai-erd");
    expect(managed.createdDirectories).not.toContain(".cursor");
    // 그리고 되돌리기가 그 디렉터리를 치우려 들지 않는다.
    expect(existsSync(join(root, ".cursor"))).toBe(true);
  });
});
