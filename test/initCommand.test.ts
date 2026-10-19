import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createdChain, executeInitCommand } from "../src/adapters/cli/initCommand";
import { findGitRoot } from "../src/core/harness/repositoryFiles";
import { readRecord } from "../src/core/harness/initPlan";

const RECORD_FILE = ".ainecto/init-record.json";

/**
 * 되돌리기 기록. ★«기록 파일»에서 읽는다 — 7차 독립 리뷰 뒤에 기록을 config 에서 자기 파일로
 * 내보냈다. 한 파일에 주인이 둘이라 「이 칸이 누구 것인가」를 매번 판정해야 했고, 그 판정이
 * 네 차수 연속 샜다.
 */
async function recordOf(root: string) {
  const state = readRecord(await readFile(join(root, RECORD_FILE), "utf8"));
  return state.state === "valid" ? state.record : undefined;
}

import type { InitCommandOptions } from "../src/adapters/cli/initCommand";

/** 서버 문서 응답 — 계약을 지킨 본문 한 벌(DOC 은 {{endpoint}} 만). */
function serverDocuments(): typeof fetch {
  return (async () => new Response(JSON.stringify({
    documents: {
      "HARNESS.DOC": { body: "SERVER DOC for {{endpoint}}\n", version: "HARNESS.DOC@r11" },
      "HARNESS.AGENT_NOTE": {
        body: "<!-- ainecto:begin -->\nSERVER NOTE {{harnessDocPath}} {{serverName}}\n<!-- ainecto:end -->",
        version: "HARNESS.AGENT_NOTE@r4",
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

/**
 * 계획이 아니라 «실제로 디스크에 무엇이 생기는가»를 본다.
 * 네트워크는 안 탄다 — 토큰이 없으면 문서를 받지 않고, 받을 때는 가짜 fetch 를 준다.
 */
describe("ainecto init (files on disk)", () => {
  let root: string;
  const out: string[] = [];

  const io = {
    stdout: { write: (text: string) => { out.push(text); return true; } },
    stderr: { write: () => true },
  } as unknown as { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream };

  function options(argv: string[]): InitCommandOptions {
    return {
      argv,
      endpoint: "https://ainecto.com/mcp",
      env: "prod" as const,
      cliVersion: "@ainecto/mcp test",
      cwd: root,
      json: true,
      io,
    };
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ainecto-init-"));
    out.length = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("--mcp: wires a fresh repository without a role, pinned bridge, config v2 with no project", async () => {
    const code = await executeInitCommand(options(["--mcp"]));

    expect(code).toBe(0);
    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    // (번들 밖 실행이라 판을 모른다 → 고정하지 않는다. 고정 규칙은 harness.test 가 본다.)
    expect(mcp.mcpServers["ainecto"].args).toEqual(["-y", "@ainecto/mcp"]);
    const config = JSON.parse(await readFile(join(root, ".ainecto/config.json"), "utf8"));
    expect(config.version).toBe(2);
    expect(config).not.toHaveProperty("project");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain("AiNecto Harness");
    expect(existsSync(join(root, ".cursor/mcp.json"))).toBe(true);
  });

  it("★--mcp 가 없으면 MCP 설정 파일을 쓰지 않는다 — 규칙 파일만", async () => {
    const code = await executeInitCommand(options([]));

    expect(code).toBe(0);
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
    expect(existsSync(join(root, ".cursor/mcp.json"))).toBe(false);
    expect(existsSync(join(root, ".ainecto/HARNESS.md"))).toBe(true);
    const result = JSON.parse(out.join("")) as { data: { next: string[] } };
    expect(result.data.next.join("\n")).toContain("ainecto setup");
  });

  it("★옛 플래그(--role 은 전역, --project·--project-name·--yes)는 멈추지 않고 «무시했다» 한 줄", async () => {
    const errors: string[] = [];
    const code = await executeInitCommand({
      ...options(["--project", "p-1", "--project-name", "Billing", "--yes"]),
      io: { stdout: io.stdout, stderr: { write: (text: string) => { errors.push(text); return true; } } } as never,
    });

    expect(code).toBe(0);
    expect(errors.join("")).toMatch(/^Ignored --project, --project-name, --yes: init no longer asks for a role or a project/);
  });

  it("★옛 저장소 이행 — init 재실행 하나로 --role 이 걷히고, 우리가 썼던 config 의 project 칸이 사라진다", async () => {
    // 0.7.x 가 쓴 모양을 그대로 만든다: 기록 + config v1(project) + --role 실린 브리지.
    const v07 = await import("../src/core/harness/initPlan");
    const files = new Map<string, string | undefined>();
    const old = v07.planInit({
      env: "prod", endpoint: "https://ainecto.com/mcp", cliVersion: "@ainecto/mcp 0.7.0", mcp: true, files,
    });
    for (const write of old.writes) {
      await mkdir(join(root, write.path, ".."), { recursive: true });
      await writeFile(join(root, write.path), write.content, "utf8");
    }
    // 0.7.x 의 흔적: --role 과 project 칸(기록에도 «우리가 썼다»로 남아 있다).
    const mcpPath = join(root, ".mcp.json");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
    mcp.mcpServers.ainecto.args = ["-y", "@ainecto/mcp", "--role", "development"];
    await writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
    const configPath = join(root, ".ainecto/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.version = 1;
    config.project = { uuid: "p-1", name: "Billing" };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const recordPath = join(root, RECORD_FILE);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const entryContract = record.files[".mcp.json"];
    entryContract.written = { at: "json", value: mcp.mcpServers.ainecto };
    const configContract = record.files[".ainecto/config.json"];
    configContract.written = { at: "text", text: `${JSON.stringify(config, null, 2)}\n` };
    configContract.writtenFields.version = 1;
    configContract.writtenFields.project = config.project;
    configContract.originalFields.project = { at: "absent" };
    // 0.7.x 의 apply 가 적었을 «우리가 만든 디렉터리».
    record.createdDirectories = [".ainecto", ".cursor"];
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    // ★--mcp 없이 — 우리 브리지 항목이 있으므로 갱신된다.
    expect(await executeInitCommand(options([]))).toBe(0);

    expect(JSON.parse(await readFile(mcpPath, "utf8")).mcpServers.ainecto.args).toEqual(["-y", "@ainecto/mcp"]);
    const after = JSON.parse(await readFile(configPath, "utf8"));
    expect(after.version).toBe(2);
    expect(after).not.toHaveProperty("project");
    // 그리고 되돌리기는 여전히 저장소를 init 전으로 돌린다.
    await executeInitCommand(options(["--undo"]));
    expect(existsSync(mcpPath)).toBe(false);
    expect(existsSync(join(root, ".ainecto"))).toBe(false);
  });

  it("★옛 project 칸을 사용자가 고쳤으면 남기고 알린다", async () => {
    await executeInitCommand(options(["--mcp"]));
    const configPath = join(root, ".ainecto/config.json");
    const recordPath = join(root, RECORD_FILE);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    // 기록상 우리는 p-1 을 썼는데, 사용자가 p-2 로 바꿔 두었다.
    const ours = { uuid: "p-1", name: "Billing" };
    const contract = record.files[".ainecto/config.json"];
    contract.writtenFields.project = ours;
    contract.originalFields.project = { at: "absent" };
    contract.written = { at: "text", text: `${JSON.stringify({ ...config, project: ours }, null, 2)}\n` };
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    config.project = { uuid: "p-2", name: "Mine" };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    out.length = 0;

    expect(await executeInitCommand(options(["--mcp"]))).toBe(0);

    expect(JSON.parse(await readFile(configPath, "utf8")).project).toEqual({ uuid: "p-2", name: "Mine" });
    expect(out.join("")).toContain("you changed project");
  });

  it("dry-run touches nothing", async () => {
    await executeInitCommand(options(["--mcp", "--dry-run"]));

    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
    expect(existsSync(join(root, ".ainecto"))).toBe(false);
  });

  it("gives the repository back byte for byte on --undo", async () => {
    const originalMcp = `${JSON.stringify({ mcpServers: { sentry: { type: "http", url: "https://x" } } }, null, 2)}\n`;
    const originalAgents = "# House rules\n\nBe careful.\n";
    await writeFile(join(root, ".mcp.json"), originalMcp, "utf8");
    await writeFile(join(root, "AGENTS.md"), originalAgents, "utf8");
    await executeInitCommand(options(["--mcp"]));

    await executeInitCommand(options(["--undo"]));

    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(originalMcp);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(originalAgents);
    expect(existsSync(join(root, ".ainecto"))).toBe(false);
    // 우리가 만든 것만 사라진다
    expect(existsSync(join(root, ".cursor/mcp.json"))).toBe(false);
  });

  it("★심볼릭 링크로 저장소 밖 파일을 고치지 않는다", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ainecto-outside-"));
    await writeFile(join(outside, "rules.md"), "NOT OURS\n", "utf8");
    await symlink(join(outside, "rules.md"), join(root, "AGENTS.md"));

    await expect(executeInitCommand(options(["--mcp"])))
      .rejects.toThrow(/symbolic link|outside the repository/);
    expect(await readFile(join(outside, "rules.md"), "utf8")).toBe("NOT OURS\n");
    await rm(outside, { recursive: true, force: true });
  });

  it("★.ainecto 가 저장소 밖을 가리켜도 그곳 파일이 남는다", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ainecto-outside-"));
    await writeFile(join(outside, "config.json"), "MINE\n", "utf8");
    await writeFile(join(outside, "HARNESS.md"), "MINE\n", "utf8");
    await symlink(outside, join(root, ".ainecto"));

    // ★읽기도 경계 검사를 먼저 통과한다 — 남의 파일은 «읽지도» 않는다.
    await expect(executeInitCommand(options(["--undo"])))
      .rejects.toThrow(/outside the repository|symbolic link/);
    expect(await readFile(join(outside, "config.json"), "utf8")).toBe("MINE\n");

    // init 은 그 링크를 통해 쓰려다 경계에서 멈춘다.
    await expect(executeInitCommand(options(["--mcp"])))
      .rejects.toThrow(/outside the repository|symbolic link/);
    expect(await readFile(join(outside, "HARNESS.md"), "utf8")).toBe("MINE\n");
    await rm(outside, { recursive: true, force: true });
  });

  it("★남의 설정 파일 권한을 넓히지 않는다", async () => {
    const mine = `${JSON.stringify({ mcpServers: { other: { command: "x", env: { SECRET: "s" } } } }, null, 2)}\n`;
    await writeFile(join(root, ".mcp.json"), mine, { encoding: "utf8", mode: 0o600 });

    await executeInitCommand(options(["--mcp"]));

    // rename 은 inode 를 갈아치운다 — 권한을 안 옮기면 umask 기본값(보통 0644)이 된다.
    expect((await stat(join(root, ".mcp.json"))).mode & 0o777).toBe(0o600);
  });

  it("★문서를 받는 사이 파일이 바뀌면 덮지 않는다", async () => {
    await writeFile(join(root, ".mcp.json"), `${JSON.stringify({ mcpServers: {} })}\n`, "utf8");
    const mine = `${JSON.stringify({ mcpServers: { other: { url: "https://x" } } }, null, 2)}\n`;
    const documents = serverDocuments();
    const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      // 네트워크를 기다리는 동안 다른 사람이 같은 파일을 고쳤다.
      await writeFile(join(root, ".mcp.json"), mine, "utf8");
      return documents(...args);
    }) as typeof fetch;

    await expect(executeInitCommand({ ...options(["--mcp"]), accessToken: async () => "t", fetchImpl }))
      .rejects.toThrow(/changed while init was running/);
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(mine);
  });

  it("★기본이 아닌 endpoint 를 설정에도 싣는다", async () => {

    await executeInitCommand({
      ...options(["--mcp"]),
      endpoint: "https://custom.example/mcp",
    });

    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers["ainecto"].args).toContain("--endpoint");
    expect(mcp.mcpServers["ainecto"].args).toContain("https://custom.example/mcp");
  });

  it("★undo 가 우리가 만든 빈 디렉터리를 남기지 않는다", async () => {
    await executeInitCommand(options(["--mcp"]));
    expect(existsSync(join(root, ".cursor"))).toBe(true);

    await executeInitCommand(options(["--undo"]));

    expect(existsSync(join(root, ".cursor"))).toBe(false);
    expect(existsSync(join(root, ".ainecto"))).toBe(false);
  });

  it("★config 를 고치면 undo 가 지우지 않는다 (자기 지문)", async () => {
    // 2026-09-23 독립 재리뷰 I7 — 지문을 문자열을 «만든 뒤»에 넣어서 파일에는 자기 지문이 없었다.
    await executeInitCommand(options(["--mcp"]));

    const configPath = join(root, ".ainecto/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.myOwnField = "keep me";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    await executeInitCommand(options(["--undo"]));

    expect(existsSync(configPath)).toBe(true);
    expect(JSON.parse(await readFile(configPath, "utf8")).myOwnField).toBe("keep me");
  });

  it("손대지 않은 config 는 undo 가 정상적으로 지운다", async () => {
    // 위 보호가 «전부 남김»으로 흐르지 않는지 — 안 건드렸으면 깨끗이 사라져야 한다.
    await executeInitCommand(options(["--mcp"]));

    await executeInitCommand(options(["--undo"]));

    expect(existsSync(join(root, ".ainecto/config.json"))).toBe(false);
  });

  it("★우리 MCP 항목을 손대면 undo 가 남긴다", async () => {
    // 2026-09-23 독립 재리뷰 I8 — 파일 전체 지문만 보면 「우리 항목을 고쳤다」를 못 본다.
    await executeInitCommand(options(["--mcp"]));

    const mcpPath = join(root, ".mcp.json");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
    mcp.mcpServers["ainecto"].env = { MY_FLAG: "1" };
    await writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, "utf8");

    await executeInitCommand(options(["--undo"]));

    const after = JSON.parse(await readFile(mcpPath, "utf8"));
    expect(after.mcpServers["ainecto"].env).toEqual({ MY_FLAG: "1" });
  });

  it("★우리 블록 «안에» 적은 글을 undo 가 지우지 않는다", async () => {
    await writeFile(join(root, "AGENTS.md"), "# House rules\n\nMine.\n", "utf8");
    await executeInitCommand(options(["--mcp"]));

    const agentsPath = join(root, "AGENTS.md");
    const withNote = await readFile(agentsPath, "utf8");
    await writeFile(agentsPath, withNote.replace("<!-- ainecto:end -->", "MY OWN LINE\n<!-- ainecto:end -->"), "utf8");

    await executeInitCommand(options(["--undo"]));

    const after = await readFile(agentsPath, "utf8");
    expect(after).toContain("MY OWN LINE");
    expect(after).toContain("Mine.");
  });

  it("★init 전부터 있던 HARNESS.md 의 «이후 편집»을 원본으로 덮지 않는다", async () => {
    await mkdir(join(root, ".ainecto"), { recursive: true });
    await writeFile(join(root, ".ainecto/HARNESS.md"), "my original\n", "utf8");
    await executeInitCommand(options(["--mcp"]));

    await writeFile(join(root, ".ainecto/HARNESS.md"), "edited after init\n", "utf8");
    await executeInitCommand(options(["--undo"]));

    expect(await readFile(join(root, ".ainecto/HARNESS.md"), "utf8")).toBe("edited after init\n");
  });

  it("★중간에 실패해도 되돌릴 «기록»은 남는다", async () => {
    // 2026-09-23 독립 재리뷰 I11 — 기록이 마지막 쓰기라, 중간 실패는 되돌릴 수 없는 상태를 남겼다.
    // 사전 검사는 통과하지만 «쓸 때» 실패하는 상황: 쓰기 권한 없는 디렉터리.
    await mkdir(join(root, ".cursor"), { recursive: true });
    await chmod(join(root, ".cursor"), 0o555);

    try {
      await expect(executeInitCommand(options(["--mcp"]))).rejects.toThrow();
      // ★실패했어도 기록이 먼저 디스크에 있다 — 그래야 undo 가 앞서 바꾼 것을 되돌린다.
      expect(existsSync(join(root, RECORD_FILE))).toBe(true);
    } finally {
      await chmod(join(root, ".cursor"), 0o755);
    }
  });

  it("★--undo 는 토큰을 건드리지 않는다", async () => {
    // 로컬 되돌리기가 네트워크에 기대면, 서버가 죽은 날 되돌릴 수가 없다(S1).
    let asked = 0;

    await executeInitCommand({
      ...options(["--undo"]),
      accessToken: async () => { asked += 1; return "t"; },
    });

    expect(asked).toBe(0);
  });

  it("★같은 설정으로 다시 init 해도 조각 지문을 잊지 않는다", async () => {
    // 4차 독립 리뷰 I3 — 이전 기록을 베낄 때 lastWrittenFragment 만 빠져서, 내용이 같은
    // 두 번째 init 뒤에 소유권 판정이 파일 전체 지문으로 후퇴했다.
    await executeInitCommand(options(["--mcp"]));
    await executeInitCommand(options(["--mcp"]));

    const record = (await recordOf(root))!;
    // ★조각을 소유한 세 파일이 «전부» 기록에 남아 있다 — 재실행이 그것을 잊지 않는다.
    //
    // ⚠<b>여기서 한 번 시험을 약화시켰다</b>(9차 독립 리뷰 B3). 옛 검사
    // {@code Object.keys(lastWrittenFragment).toHaveLength(3)} 를 «기록을 읽는 위치만 바꾼»
    // 검사로 옮긴다면서 {@code record.files[path]?.written.at !== "absent"} 로 바꿨는데,
    // 계약이 통째로 없으면 {@code undefined !== "absent"} 라서 <b>그대로 통과했다</b> —
    // 실제로는 undo 뒤에 우리가 만든 MCP 파일이 남아 있었다.
    // ⇒ 없는 것을 «없다»고 말하게 한다: 계약이 있는지, scope 가 무엇인지, 무엇을 들고 있는지.
    for (const [path, scope, at] of [
      [".mcp.json", "entry", "json"],
      [".cursor/mcp.json", "entry", "json"],
      ["AGENTS.md", "block", "text"],
    ] as const) {
      const contract = record.files[path];
      expect(contract, `${path} 의 복구 계약이 기록에 있어야 한다`).toBeDefined();
      expect(contract!.scope).toBe(scope);
      expect(contract!.written.at).toBe(at);
      expect(contract!.createdByUs).toBe(true);
    }
    // 조각을 소유한 파일은 «정확히» 그 둘이다 — 더도 덜도 아니다.
    expect(Object.entries(record.files)
      .filter(([, contract]) => contract.scope === "entry").map(([path]) => path).sort())
      .toEqual([".cursor/mcp.json", ".mcp.json"]);

    // 블록 «바깥»에만 쓴 글은 보존하면서 우리 블록은 정상적으로 걷어낸다.
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, `${await readFile(agentsPath, "utf8")}\nOUTSIDE THE BLOCK\n`, "utf8");
    await executeInitCommand(options(["--undo"]));

    const after = await readFile(agentsPath, "utf8");
    expect(after).toContain("OUTSIDE THE BLOCK");
    expect(after).not.toContain("AiNecto Harness");
    // ★우리가 만든 MCP 파일 «둘»이 실제로 사라졌는지 디스크에서 본다. 약화된 검사가 놓친 것이다.
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
    expect(existsSync(join(root, ".cursor/mcp.json"))).toBe(false);
  });

  it("★B7 손상된 기록이면 «원격을 건드리기 전에» 멈춘다", async () => {
    // 9차 1차 리뷰 B7 — 프로젝트가 0개인 저장소에서 원격에 프로젝트를 «만든 뒤»
    // 「아무것도 바꾸지 않았다」는 예외가 났다. 로컬 쓰기 0 과 부수효과 0 은 다른 사실이다.
    await mkdir(join(root, ".ainecto"), { recursive: true });
    await writeFile(join(root, ".ainecto/init-record.json"), "{ not json", "utf8");
    const remote: string[] = [];

    await expect(executeInitCommand({
      ...options(["--mcp"]),
      accessToken: async () => { remote.push("token"); return "t"; },
      login: async () => { remote.push("login"); },
    })).rejects.toThrow(/not valid JSON/);

    // ★원격으로 가는 일이 «하나도» 없어야 한다 — 토큰 조회도, 로그인도.
    expect(remote).toEqual([]);
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
    // 손상된 기록은 그대로 둔다 — 그 안에 못 읽은 백업이 있을 수 있다.
    expect(await readFile(join(root, ".ainecto/init-record.json"), "utf8")).toBe("{ not json");
  });

  it("★B7 다른 판의 기록이면 그것도 원격 전에 멈춘다", async () => {
    await mkdir(join(root, ".ainecto"), { recursive: true });
    await writeFile(join(root, ".ainecto/init-record.json"), `${JSON.stringify({
      kind: "ainecto/init-record",
      version: 999,
      files: {},
    }, null, 2)}\n`, "utf8");
    const remote: string[] = [];

    await expect(executeInitCommand({
      ...options(["--mcp"]),
      login: async () => { remote.push("login"); },
    })).rejects.toThrow(/another version of this CLI/);

    expect(remote).toEqual([]);
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  });

  it("★저장소 경계 검사가 로그인보다 먼저다", async () => {
    // 4차 독립 리뷰 I5 — 읽기 경로가 assertInsideRepository 없이 파일을 «한 번 읽었다».
    const outside = join(root, "..", `outside-${Date.now()}.json`);
    await writeFile(outside, JSON.stringify({ mcpServers: {} }), "utf8");
    await symlink(outside, join(root, ".mcp.json"));

    let signedIn = 0;
    await expect(executeInitCommand({ ...options(["--mcp"]), login: async () => { signedIn += 1; } }))
      .rejects.toThrow();
    expect(signedIn).toBe(0);
    await rm(outside, { force: true });
  });

  it("★칸 순서만 바뀐 것은 «편집»이 아니다", async () => {
    // 4차 독립 리뷰 S1 — 편집기로 열었다 저장만 해도 사용자 편집으로 잡혔다.
    await executeInitCommand(options(["--mcp"]));

    const mcpPath = join(root, ".mcp.json");
    const entry = JSON.parse(await readFile(mcpPath, "utf8")).mcpServers["ainecto"];
    const reordered = Object.fromEntries(Object.entries(entry).reverse());
    await writeFile(mcpPath, `${JSON.stringify({ mcpServers: { "ainecto": reordered } }, null, 2)}\n`, "utf8");

    await executeInitCommand(options(["--undo"]));

    expect(existsSync(mcpPath)).toBe(false);
  });

  it("★dev 기본 주소에서 로그인이 없으면 안내에 env 가 실린다", async () => {
    // 4차 독립 리뷰 S2 — 안내를 그대로 치면 «운영» 슬롯에 로그인하고 같은 자리에서 또 막혔다.
    const errors: string[] = [];
    await executeInitCommand({
      ...options(["--dry-run"]),
      env: "dev" as const,
      endpoint: "https://dev.ainecto.com/mcp",
      accessToken: async () => undefined,
      io: { stdout: io.stdout, stderr: { write: (text: string) => { errors.push(text); return true; } } } as never,
    });
    expect(errors.join("")).toContain("ainecto auth login --env dev");
  });

  it("★init 전부터 있던 빈 디렉터리는 undo 가 남긴다", async () => {
    // 4차 독립 리뷰 S3 — 「비었으면 치운다」는 우리 것인지를 안 본다.
    await mkdir(join(root, ".cursor"), { recursive: true });
    await executeInitCommand(options(["--mcp"]));

    await executeInitCommand(options(["--undo"]));

    expect(existsSync(join(root, ".cursor"))).toBe(true);
    expect(existsSync(join(root, ".cursor/mcp.json"))).toBe(false);
    // 우리가 만든 .ainecto 는 그대로 치운다.
    expect(existsSync(join(root, ".ainecto"))).toBe(false);
  });

  it("★되돌리지 못한 것이 남으면 기록을 지우지 않는다", async () => {
    // 4차 독립 리뷰 I2 — 충돌을 남긴 바로 그 실행이 «원본 백업이 든» config 를 지웠다.
    await writeFile(join(root, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { "ainecto": { command: "mine" } } }, null, 2)}\n`, "utf8");
    await executeInitCommand(options(["--mcp"]));

    // 사용자가 우리 항목을 손댄다 → undo 는 그것을 남긴다.
    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    mcp.mcpServers["ainecto"].env = { MY_FLAG: "1" };
    await writeFile(join(root, ".mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
    await executeInitCommand(options(["--undo"]));

    // 기록이 남아 있어야, 충돌을 풀고 다시 undo 할 때 원본을 되돌릴 수 있다.
    expect(existsSync(join(root, RECORD_FILE))).toBe(true);
    const record = (await recordOf(root))!;
    expect(record.files[".mcp.json"]?.original).toEqual({ at: "json", value: { command: "mine" } });
  });

  it("★이미 원본으로 돌아온 항목을 «충돌»로 세지 않는다", async () => {
    // 5차 독립 리뷰 I3 — 일부만 복구된 뒤 다시 undo 하면 끝난 항목까지 충돌로 잡혀 영영 안 끝났다.
    await writeFile(join(root, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { "ainecto": { command: "mine" } } }, null, 2)}\n`, "utf8");
    await executeInitCommand(options(["--mcp"]));

    // 사용자가 손수 원본으로 되돌려 놓았다.
    await writeFile(join(root, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { "ainecto": { command: "mine" } } }, null, 2)}\n`, "utf8");
    out.length = 0;
    await executeInitCommand(options(["--undo"]));

    expect(out.join("")).toContain("already back in place");
    // 끝났으므로 기록도 남지 않는다.
    expect(existsSync(join(root, ".ainecto/config.json"))).toBe(false);
  });

  it("★기록은 «줄어서» 남는다 — 끝난 항목은 지워진다", async () => {
    await writeFile(join(root, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { "ainecto": { command: "mine" } } }, null, 2)}\n`, "utf8");
    await writeFile(join(root, "AGENTS.md"), "# House rules\n\nMine.\n", "utf8");
    await executeInitCommand(options(["--mcp"]));

    // AGENTS 블록만 손대서 충돌로 남긴다 — MCP 는 정상 복구된다.
    const agents = join(root, "AGENTS.md");
    await writeFile(agents, (await readFile(agents, "utf8"))
      .replace("<!-- ainecto:end -->", "MINE INSIDE\n<!-- ainecto:end -->"), "utf8");
    await executeInitCommand(options(["--undo"]));

    const record = (await recordOf(root))!;
    // 끝난 MCP 항목의 계약은 사라졌고, 아직 남은 AGENTS 계약만 있다.
    expect(record.files[".mcp.json"]).toBeUndefined();
    expect(record.files["AGENTS.md"]?.scope).toBe("block");
    // 그리고 실제로 MCP 원본은 돌아와 있다.
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers["ainecto"])
      .toEqual({ command: "mine" });
  });

  it("★백업을 든 파일이 사라지면 기록을 지키지 않는다", async () => {
    // 5차 독립 리뷰 I2 — 「없으니 건너뛴다」가 그 원본을 영영 버렸다.
    await writeFile(join(root, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { "ainecto": { command: "mine" } } }, null, 2)}\n`, "utf8");
    await executeInitCommand(options(["--mcp"]));

    await rm(join(root, ".mcp.json"));
    out.length = 0;
    await executeInitCommand(options(["--undo"]));

    expect(out.join("")).toContain("the backup is kept");
    const record = (await recordOf(root))!;
    expect(record.files[".mcp.json"]?.original).toEqual({ at: "json", value: { command: "mine" } });
  });

  it("★변경 없는 재실행은 파일을 바꾸지 않는다 (끝 개행이 늘지 않는다)", async () => {
    // 5차 독립 리뷰 S2 — 605 → 606 → 607 로 1바이트씩 자랐다.
    await executeInitCommand(options(["--mcp"]));
    const first = await readFile(join(root, "AGENTS.md"), "utf8");

    await executeInitCommand(options(["--mcp"]));
    await executeInitCommand(options(["--mcp"]));

    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(first);
  });

  // ── 1단계: 비대화형 경로(설계 §21-1) ─────────────────────────────────────────

  function withLogin(argv: string[], token: string | undefined) {
    const events: string[] = [];
    const errors: string[] = [];
    let current = token;
    return {
      events,
      errors,
      opts: {
        ...options(argv),
        io: {
          stdout: io.stdout,
          stderr: { write: (text: string) => { errors.push(text); return true; } },
        } as unknown as { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream },
        accessToken: async () => current,
        login: async () => { events.push("login"); current = "fresh"; },
        fetchImpl: (async (...args: Parameters<typeof fetch>) => {
          events.push(`documents with ${current}`);
          return serverDocuments()(...args);
        }) as typeof fetch,
      },
    };
  }

  it("★토큰이 없으면 문서를 받기 «전에» 로그인하고 이어서 진행한다 — 서버 판을 쓴다", async () => {
    const { opts, events, errors } = withLogin(["--mcp"], undefined);

    const code = await executeInitCommand(opts);

    expect(code).toBe(0);
    expect(events).toEqual(["login", "documents with fresh"]);
    expect(errors.join("")).toContain("Signed in.");
    expect(await readFile(join(root, ".ainecto/HARNESS.md"), "utf8")).toBe("SERVER DOC for https://ainecto.com/mcp\n");
  });

  it("토큰이 있으면 로그인하지 않는다", async () => {
    const { opts, events } = withLogin([], "stored");

    expect(await executeInitCommand(opts)).toBe(0);
    expect(events).toEqual(["documents with stored"]);
  });

  it("★--dry-run 도 서버 문서를 받는다 — 계획이 실제 실행과 같다(요구서 8장 P1)", async () => {
    const dry = withLogin(["--dry-run"], "stored");
    expect(await executeInitCommand(dry.opts)).toBe(0);
    const planned = JSON.parse(out.join("")) as { data: { written: string[]; notes: string[] } };
    out.length = 0;

    const real = withLogin([], "stored");
    expect(await executeInitCommand(real.opts)).toBe(0);
    const done = JSON.parse(out.join("")) as { data: { written: string[]; notes: string[] } };

    expect(dry.events).toEqual(["documents with stored"]);
    expect(planned.data.written).toEqual(done.data.written);
    expect(planned.data.notes.join("\n")).not.toContain("package's default");
  });

  it("★--dry-run 은 브라우저를 띄우지 않는다 — 로그인이 없으면 패키지 기본값 기준임을 «파일별로» 적는다", async () => {
    const { opts, events, errors } = withLogin(["--dry-run"], undefined);

    expect(await executeInitCommand(opts)).toBe(0);
    expect(events).toEqual([]);
    expect(errors.join("")).toContain("ainecto auth login");
    const notes = (JSON.parse(out.join("")) as { data: { notes: string[] } }).data.notes.join("\n");
    expect(notes).toContain(".ainecto/HARNESS.md: written from this package's default HARNESS.DOC");
    expect(notes).toContain("AGENTS.md / CLAUDE.md: written from this package's default HARNESS.AGENT_NOTE");
    expect(notes).toContain("the real run may write the server's version instead");
  });

  it("★결과의 다음 할 일 — 역할·재시작·Codex 프로필 안내가 없다", async () => {
    await executeInitCommand(options(["--mcp"]));

    const result = JSON.parse(out.join("")) as { data: { next: string[] } };
    const next = result.data.next.join("\n");
    expect(next).toContain(".ainecto/HARNESS.md");
    expect(next).toContain("permissions");
    expect(next).not.toMatch(/--role|codex -p|role/i);
  });

  it("★git 저장소의 하위 폴더에서는 멈춘다 (init·undo 모두)", async () => {
    await mkdir(join(root, ".git"));
    const sub = join(root, "packages", "api");
    await mkdir(sub, { recursive: true });

    await expect(executeInitCommand({ ...options(["--mcp"]), cwd: sub }))
      .rejects.toThrow(new RegExp(`cd ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await expect(executeInitCommand({ ...options(["--undo"]), cwd: sub }))
      .rejects.toThrow(/not at its root/);
    expect(existsSync(join(sub, ".mcp.json"))).toBe(false);
  });

  it("★.git 이 «파일»(worktree)이어도 루트로 알아본다", async () => {
    await writeFile(join(root, ".git"), "gitdir: /somewhere/else\n", "utf8");

    expect(await executeInitCommand(options(["--mcp"]))).toBe(0);
    const result = JSON.parse(out.join("")) as { data: { notes: string[] } };
    expect(result.data.notes.join("\n")).not.toContain("not inside a git repository");
    expect(await findGitRoot(join(root, "deeper"))).toBe(root);
  });

  it("git 저장소가 아니면 그 자리에서 진행하고 그 사실을 적는다", async () => {

    expect(await executeInitCommand(options(["--mcp"]))).toBe(0);
    const result = JSON.parse(out.join("")) as { data: { notes: string[] } };
    expect(result.data.notes.join("\n")).toContain("not inside a git repository");
    // undo 도 같은 note 를 쓴다 — «init 이 설정했다»가 아니라 «이 폴더를 기준으로 삼았다».
    out.length = 0;
    await executeInitCommand(options(["--undo"]));
    const undone = JSON.parse(out.join("")) as { data: { notes: string[] } };
    expect(undone.data.notes.join("\n")).toContain("this folder was used as the repository root");
    expect(undone.data.notes.join("\n")).not.toContain("init set up");
  });

  it("leaves a user's own file inside .ainecto alone", async () => {
    await mkdir(join(root, ".ainecto"), { recursive: true });
    await writeFile(join(root, ".ainecto/notes.md"), "mine\n", "utf8");
    await executeInitCommand(options(["--mcp"]));

    await executeInitCommand(options(["--undo"]));

    expect(await readFile(join(root, ".ainecto/notes.md"), "utf8")).toBe("mine\n");
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
    expect(createdChain(root, "/repo/.ainecto", "/repo/.ainecto")).toEqual([".ainecto"]);
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
    root = await mkdtemp(join(tmpdir(), "ainecto-dirs-"));
    out.length = 0;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("사용자가 먼저 만들어 둔 .cursor 는 기록에 없고, 우리가 만든 .ainecto 는 있다", async () => {
    await mkdir(join(root, ".cursor"), { recursive: true });
    const code = await executeInitCommand({
      argv: ["--mcp"],
      endpoint: "https://ainecto.com/mcp", env: "prod" as const,
      cliVersion: "@ainecto/mcp test", cwd: root, json: true, io,
    });

    expect(code).toBe(0);
    const record = (await recordOf(root))!;
    expect(record.createdDirectories).toContain(".ainecto");
    expect(record.createdDirectories).not.toContain(".cursor");
    // 그리고 되돌리기가 그 디렉터리를 치우려 들지 않는다.
    expect(existsSync(join(root, ".cursor"))).toBe(true);
  });
});
