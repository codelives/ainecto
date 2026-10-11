import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeInitCommand } from "../src/adapters/cli/initCommand";
import { findRepositoryRole, readConfigRole } from "../src/core/harness/repositoryRole";
import { documentContractProblem, AGENT_NOTE_KEY, renderAgentNote } from "../src/core/harness/harnessDoc";
import { resolveRole } from "../src/core/harness/role";
import { PACKAGE_NAME } from "../src/core/version";
import type { McpRpcClient } from "../src/core/mcp/rpcClient";

/**
 * ★0.4.x(이름 ai-erd)가 이미 init 한 저장소를 0.5.0(이름 ainecto)이 «자기 것»으로 알아보는가.
 *
 * <p>픽스처는 손으로 만든 모양이 아니다 — 그 판의 실제 {@code executeInitCommand}(0.4.6 = 4fb8cee)가
 * 가짜 서버를 상대로 쓴 파일을 그대로 떠 왔다(test/fixtures/legacy-0.4.6-init.json). 우리가 짐작한 옛 모양에
 * 맞춰 새 코드를 시험하면, 짐작이 틀린 만큼 시험도 같이 틀린다.
 */
const FIXTURE = JSON.parse(readFileSync(join(__dirname, "fixtures/legacy-0.4.6-init.json"), "utf8")) as {
  legacy046: { before: Record<string, string>; after: Record<string, string> };
  oldAfterNew: { files: Record<string, string> };
};

describe("0.4.x 저장소 호환 (실제 파일)", () => {
  let root: string;
  const out: string[] = [];
  const io = {
    stdout: { write: (text: string) => { out.push(text); return true; } },
    stderr: { write: () => true },
  } as unknown as { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream };
  const stub = {
    toolsCall: async () => ({ content: [{ type: "text", text: JSON.stringify({ projects: [{ uuid: "p-1", name: "Billing" }] }) }] }),
  } as unknown as McpRpcClient;

  function options(argv: string[], role?: "development" | "design") {
    return {
      argv, role, client: stub, endpoint: "https://ainecto.com/mcp", env: "prod" as const,
      cliVersion: `${PACKAGE_NAME} test`, cwd: root, json: true, io,
      fetchImpl: (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
    };
  }

  async function materialize(files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content, "utf8");
    }
  }

  const read = (path: string) => readFile(join(root, path), "utf8");
  const servers = async (path: string) => JSON.parse(await read(path)).mcpServers as Record<string, { args: string[] }>;
  const count = (text: string, needle: string) => text.split(needle).length - 1;
  const lastResult = () => JSON.parse(out[out.length - 1]!).data;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ainecto-legacy-"));
    await mkdir(join(root, ".git"));
    out.length = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("셸 명령은 옛 키(\"ai-erd\")의 역할을 저장소 역할로 읽는다", async () => {
    await materialize(FIXTURE.legacy046.after);
    const found = await findRepositoryRole(root, join(root, "..", "no-such-home"));
    expect(found).toMatchObject({ kind: "role", role: "development" });
  });

  it("★재init 은 새 이름으로 옮겨 쓰고 옛 항목을 하나도 남기지 않는다", async () => {
    await materialize(FIXTURE.legacy046.after);

    expect(await executeInitCommand(options([], "development"))).toBe(0);

    // MCP 설정: 옛 키는 새 키로 «교체» — 둘이 나란히 남으면 한 세션이 두 서버를 본다.
    for (const path of [".mcp.json", ".cursor/mcp.json"]) {
      const entries = await servers(path);
      expect(entries["ainecto"]!.args).toEqual(["-y", "@ainecto/mcp", "--role", "development"]);
      expect(entries["ai-erd"]).toBeUndefined();
    }
    expect((await servers(".mcp.json"))["other"]).toEqual({ command: "other-server" });

    // 마커: 옛 블록 자리에 새 블록 하나. ★펜스 안의 옛 마커 «예제»(남의 글)는 그대로다.
    const agents = await read("AGENTS.md");
    expect(count(agents, "<!-- ainecto:begin -->")).toBe(1);
    expect(count(agents, "<!-- ai-erd:begin -->")).toBe(1);
    expect(agents).toContain("```\n<!-- ai-erd:begin -->\nexample\n<!-- ai-erd:end -->\n```");
    expect(agents).toContain(".ainecto/HARNESS.md");
    const claude = await read("CLAUDE.md");
    expect(count(claude, "<!-- ainecto:begin -->")).toBe(1);
    expect(claude).not.toContain("<!-- ai-erd:begin -->");

    // 폴더: .ai-erd/ 는 사라지고 .ainecto/ 에 모인다(0.4.6 이 만든 폴더라 빈 폴더도 치운다).
    expect(existsSync(join(root, ".ai-erd"))).toBe(false);
    for (const name of ["HARNESS.md", "config.json", "init-record.json"]) {
      expect(existsSync(join(root, ".ainecto", name))).toBe(true);
    }
    const record = JSON.parse(await read(".ainecto/init-record.json"));
    expect(record.kind).toBe("ainecto/init-record");
    expect(Object.keys(record.files)).toEqual(expect.arrayContaining([".ainecto/HARNESS.md", ".ainecto/config.json"]));
    expect(Object.keys(record.files).some((path: string) => path.startsWith(".ai-erd"))).toBe(false);
    expect(record.createdDirectories).toEqual(expect.arrayContaining([".ainecto", ".cursor"]));
    expect(record.createdDirectories).not.toContain(".ai-erd");
    // ★0.4.6 init «전»의 원본을 이어받았다 — 옮기면서 «원래 있던 것»이 우리 블록으로 바뀌면 안 된다.
    expect(record.files["AGENTS.md"].original).toEqual({ at: "absent" });
    expect(record.files["AGENTS.md"].foreignBlocks).toEqual(["<!-- ai-erd:begin -->\nexample\n<!-- ai-erd:end -->"]);

    const result = lastResult();
    expect(result.removed).toEqual([".ai-erd/HARNESS.md", ".ai-erd/config.json", ".ai-erd/init-record.json"]);
    expect(await findRepositoryRole(root, join(root, "..", "no-such-home"))).toMatchObject({ role: "development" });

    // 변경 없는 재실행은 아무것도 안 바꾼다(옮긴 뒤에도 같은 규칙).
    out.length = 0;
    expect(await executeInitCommand(options([], "development"))).toBe(0);
    expect(lastResult().written).toEqual([]);
    expect(lastResult().removed).toBeUndefined();
  });

  it("★옮긴 뒤 --undo 는 0.4.6 init «전» 저장소로 되돌린다", async () => {
    await materialize(FIXTURE.legacy046.after);
    await executeInitCommand(options([], "design"));

    expect(await executeInitCommand(options(["--undo"]))).toBe(0);

    await expectPreInitRepository();
  });

  it("★재init 없이 바로 --undo 해도 0.4.6 init «전» 저장소로 되돌린다", async () => {
    await materialize(FIXTURE.legacy046.after);

    expect(await executeInitCommand(options(["--undo"]))).toBe(0);

    await expectPreInitRepository();
  });

  async function expectPreInitRepository() {
    for (const [path, content] of Object.entries(FIXTURE.legacy046.before)) {
      expect(await read(path)).toBe(content);
    }
    for (const gone of [".ai-erd", ".ainecto", ".cursor"]) {
      expect(existsSync(join(root, gone))).toBe(false);
    }
  }

  it("--dry-run 은 옮길 것을 보여 주기만 하고 한 바이트도 바꾸지 않는다", async () => {
    await materialize(FIXTURE.legacy046.after);

    expect(await executeInitCommand(options(["--dry-run"], "development"))).toBe(0);

    for (const [path, content] of Object.entries(FIXTURE.legacy046.after)) {
      expect(await read(path)).toBe(content);
    }
    expect(existsSync(join(root, ".ainecto"))).toBe(false);
    const result = lastResult();
    expect(result.written).toEqual(expect.arrayContaining(["created .ainecto/init-record.json"]));
    expect(result.removed).toEqual(expect.arrayContaining([".ai-erd/init-record.json"]));
  });

  it("옛 기록이 없는 .ai-erd/ 는 우리 것이라는 근거가 없다 — 옮기지 않고 알린다", async () => {
    await materialize({ ".ai-erd/HARNESS.md": "someone's notes\n" });

    expect(await executeInitCommand(options([], "development"))).toBe(0);

    expect(await read(".ai-erd/HARNESS.md")).toBe("someone's notes\n");
    expect(lastResult().notes.join("\n")).toContain(".ai-erd/ was left in place");
  });

  it("★옛 CLI(0.4.6)가 새 CLI 뒤에 init 한 저장소: 셸 명령도 init 도 멈춘다 — 고르지 않는다", async () => {
    // 실측(픽스처): 0.4.6 은 "ainecto" 옆에 "ai-erd" 항목을, 새 블록 옆에 옛 블록을, .ainecto/ 옆에 .ai-erd/ 를 더한다.
    await materialize(FIXTURE.oldAfterNew.files);
    const before = Object.fromEntries(await Promise.all(
      Object.keys(FIXTURE.oldAfterNew.files).map(async (path) => [path, await read(path)] as const),
    ));

    const found = await findRepositoryRole(root, join(root, "..", "no-such-home"));
    expect(found.kind).toBe("conflict");
    await expect(executeInitCommand(options([], "development")))
      .rejects.toThrow(/Both \.ai-erd\/ and \.ainecto\/[\s\S]*npx -y -p @ai-erd\/mcp@0\.4\.6 ai-erd init --undo/);
    for (const [path, content] of Object.entries(before)) {
      expect(await read(path)).toBe(content);
    }
  });
});

describe("이름 호환 — 순수 판정", () => {
  const bridge = (pkg: string, role: string) => ({ command: "npx", args: ["-y", pkg, "--role", role] });

  it("한 설정 파일에 두 이름의 브리지가 다른 역할이면 «역할을 모른다»로 멈춘다", () => {
    const content = JSON.stringify({ mcpServers: { ainecto: bridge("@ainecto/mcp", "test"), "ai-erd": bridge("@ai-erd/mcp", "design") } });
    expect(readConfigRole(".mcp.json", content)).toMatchObject({ kind: "problem" });
    const same = JSON.stringify({ mcpServers: { ainecto: bridge("@ainecto/mcp", "test"), "ai-erd": bridge("@ai-erd/mcp", "test") } });
    expect(readConfigRole(".mcp.json", same)).toEqual({ kind: "role", role: "test" });
  });

  it("AINECTO_ROLE 이 먼저, 옛 AI_ERD_ROLE 도 읽는다 — 어느 이름에서 왔는지 함께 돌려준다", () => {
    expect(resolveRole({ envVars: { AI_ERD_ROLE: "design" } }))
      .toEqual({ role: "design", source: "env", envVar: "AI_ERD_ROLE" });
    expect(resolveRole({ envVars: { AINECTO_ROLE: "test", AI_ERD_ROLE: "design" } }))
      .toEqual({ role: "test", source: "env", envVar: "AINECTO_ROLE" });
  });

  it("서버 AGENT_NOTE 가 옛 마커를 실어도 받고, 저장소에는 새 마커로 쓴다", () => {
    // 서버 검증기는 아직 옛 마커를 요구한다(옛 CLI 도 같은 본문을 받는다).
    const serverBody = "<!-- ai-erd:begin -->\nRead {{harnessDocPath}} via {{serverName}}.\n<!-- ai-erd:end -->";
    expect(documentContractProblem(AGENT_NOTE_KEY, serverBody)).toBeUndefined();
    expect(renderAgentNote(serverBody))
      .toBe("<!-- ainecto:begin -->\nRead .ainecto/HARNESS.md via ainecto.\n<!-- ainecto:end -->");
  });
});

describe("패키지 이름 SSOT", () => {
  const root = join(__dirname, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));

  it("package.json·server.json·코드가 같은 주 이름과 버전을 쓴다", () => {
    expect(pkg.name).toBe(PACKAGE_NAME);
    expect(server.packages[0].identifier).toBe(PACKAGE_NAME);
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
    expect(server.name).toBe(pkg.mcpName);
  });

  it("명령 ainecto 와 별칭 ai-erd 는 같은 실행 파일이고, 브리지 bin 은 범위 뗀 주 이름(mcp)이다", () => {
    expect(pkg.bin.ainecto).toBe(pkg.bin["ai-erd"]);
    expect(pkg.bin[PACKAGE_NAME.split("/")[1]!]).toBe("dist/bin/mcp.js");
  });
});
