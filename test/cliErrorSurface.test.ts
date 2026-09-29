import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAinectoCli } from "../src/adapters/cli/ainectoCli";

/**
 * 2026-09-23 실물 실행에서 나온 것 — `tools list` 가 실패하면 «날것의 스택 트레이스»가
 * 터져 나왔다. 같은 실패를 `init` 은 한 줄로 냈다.
 *
 * <p>원인은 분기마다 갈린 한 단어였다: {@code return await executeInitCommand(...)} 와
 * {@code return handleTools(...)}. ★{@code try} 안에서 {@code await} 없이 promise 를
 * 반환하면 그 {@code catch} 는 실패를 «못 본다» — 거부는 호출자 쪽에서 unhandled 로 뜬다.
 *
 * <p>그래서 이 시험은 메시지 «내용»이 아니라 <b>실패가 renderError 를 지나갔는가</b>를 본다:
 * 거부되지 않고 종료 코드 1 로 «돌아오는가».
 */
describe("실패는 전부 한 곳에서 그려진다", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalFetch: typeof fetch;
  const errors: string[] = [];

  const io = {
    stdout: { write: () => true },
    stderr: { write: (text: string) => { errors.push(text); return true; } },
    stdin: { on: () => undefined, resume: () => undefined },
  } as unknown as Parameters<typeof runAinectoCli>[1];

  let originalCwd: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ai-erd-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    // ★저장소 역할 탐색(0.4.2)은 cwd 에서 위로 올라간다. 이 저장소의 조상 폴더에 사람의 설정이 있어도
    //   시험이 흔들리지 않게, 아무 설정도 없는 임시 폴더에서 돈다.
    originalCwd = process.cwd();
    process.chdir(home);
    errors.length = 0;
    originalFetch = globalThis.fetch;
    // 토큰이 없는 새 기계에서 실서버가 내는 응답 그대로.
    globalThis.fetch = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("★tools list 실패가 스택이 아니라 종료 코드로 돌아온다", async () => {
    const code = await runAinectoCli(["tools", "list", "--json"], io);

    expect(code).toBe(1);
    expect(errors.join("")).toContain("401");
  });

  it("★tools call 실패도 같은 자리를 지난다", async () => {
    const code = await runAinectoCli(["tools", "call", "list_projects", "{}", "--json"], io);

    expect(code).toBe(1);
    expect(errors.join("")).not.toBe("");
  });

  it("auth 실패도 같은 자리를 지난다", async () => {
    const code = await runAinectoCli(["auth", "nope", "--json"], io);

    expect(code).toBe(1);
    expect(errors.join("")).not.toBe("");
  });
});
