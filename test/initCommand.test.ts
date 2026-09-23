import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeInitCommand, readRepositoryRole } from "../src/adapters/cli/initCommand";
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
      expect(existsSync(join(root, ".ai-erd/config.json"))).toBe(true);
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

  it("leaves a user's own file inside .ai-erd alone", async () => {
    await mkdir(join(root, ".ai-erd"), { recursive: true });
    await writeFile(join(root, ".ai-erd/notes.md"), "mine\n", "utf8");
    const { stub } = client([{ uuid: "p-1", name: "Billing" }]);
    await executeInitCommand(options(["--role", "development"], stub));

    await executeInitCommand(options(["--undo"], stub));

    expect(await readFile(join(root, ".ai-erd/notes.md"), "utf8")).toBe("mine\n");
  });
});
