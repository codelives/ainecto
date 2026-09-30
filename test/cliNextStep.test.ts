import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAinectoCli } from "../src/adapters/cli/ainectoCli";

/**
 * 2026-09-29 Codex 실측 — «ai-erd cli 설치해줘»에 전역 설치 → `ai-erd --version`(Unknown command) →
 * `ai-erd auth status --json`(authenticated) 를 보고 «설치 완료»로 닫았다. init 도 역할 질문도 없었다.
 * 에이전트가 읽는 곳은 README 가 아니라 이 출력들이라, 여기에 다음 단계가 있어야 한다.
 */
describe("설치 직후 에이전트가 보는 출력", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalCwd: string;
  const out: string[] = [];

  const io = {
    stdout: { write: (text: string) => { out.push(text); return true; } },
    stderr: { write: () => true },
    stdin: { on: () => undefined, resume: () => undefined },
  } as unknown as Parameters<typeof runAinectoCli>[1];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ai-erd-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    originalCwd = process.cwd();
    process.chdir(home);
    out.length = 0;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it.each([["--version"], ["-v"], ["version"]])("%s 는 버전을 답한다", async (arg) => {
    expect(await runAinectoCli([arg, "--json"], io)).toBe(0);
    expect(JSON.parse(out.join("")).data.version).toBeTypeOf("string");
  });

  it("역할 없는 저장소의 auth status --json 은 다음 단계(init, 역할은 사용자에게)를 싣는다", async () => {
    const repo = join(home, "repo");
    await mkdir(repo);
    process.chdir(repo);
    expect(await runAinectoCli(["auth", "status", "--json"], io)).toBe(0);
    const data = JSON.parse(out.join("")).data as Record<string, unknown>;
    // ★맨 앞 칸이 setup — 에이전트가 authenticated 보다 먼저 본다.
    expect(Object.keys(data)[0]).toBe("setup");
    expect(data.setup).toBe("incomplete");
    const next = data.next as string;
    expect(next).toContain("ai-erd init --role <role>");
    expect(next).toContain("never pick one yourself");
    expect(next).toContain("even if they only asked to install, update, or sign in");
  });

  it("역할이 있는 저장소에서는 다음 단계를 싣지 않는다", async () => {
    const repo = join(home, "repo");
    await mkdir(repo);
    await writeFile(join(repo, ".mcp.json"), JSON.stringify({
      mcpServers: { "ai-erd": { command: "npx", args: ["-y", "@ai-erd/mcp", "--role", "design"] } },
    }));
    process.chdir(repo);
    expect(await runAinectoCli(["auth", "status", "--json"], io)).toBe(0);
    expect(JSON.parse(out.join("")).data.next).toBeUndefined();
    expect(JSON.parse(out.join("")).data.setup).toBeUndefined();
  });
});
