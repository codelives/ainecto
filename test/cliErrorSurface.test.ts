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
    home = await mkdtemp(join(tmpdir(), "ainecto-home-"));
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

  /** 서버가 도구 안 거절을 HTTP 4xx 로 보낼 때의 본문 — McpController 는 JSON-RPC 403 을 HTTP 403 으로 낸다(2026-11-04 운영 실측). */
  const rpcError = (code: number, message: string, data: Record<string, unknown>) =>
    JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message, data } });

  it.each([
    [403, rpcError(403, "Only a team plan can share outside the team.", {
      code: "GRANT_NOT_ALLOWED", reason: "TEAM_REQUIRED",
      messages: { ko: "팀 요금제에서만 팀 밖으로 공유할 수 있습니다.", en: "Only a team plan can share outside the team." },
    }), "GRANT_NOT_ALLOWED: Only a team plan can share outside the team."],
    [400, rpcError(400, "Invalid OpenAPI spec: paths is required", { code: "OPENAPI_SPEC_INVALID" }),
      "OPENAPI_SPEC_INVALID: Invalid OpenAPI spec: paths is required"],
  ])("★tools call 의 HTTP %i 도구 오류 — 본문의 코드와 거절 문장을 그대로 보여 준다", async (status, body, line) => {
    globalThis.fetch = vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

    const code = await runAinectoCli(["tools", "call", "update_projects", "{}"], io);

    expect(code).toBe(1);
    expect(errors.join("")).toBe(`Error: ${line}\n`);
  });

  it("★--json 이면 서버의 오류 봉투(messages{ko,en} 포함)가 details 에 그대로 실린다", async () => {
    const body = rpcError(403, "No access.", { code: "PROJECT_PERMISSION_DENIED", messages: { ko: "권한이 없습니다.", en: "No access." } });
    globalThis.fetch = vi.fn(async () => new Response(body, { status: 403 })) as unknown as typeof fetch;

    const code = await runAinectoCli(["tools", "call", "update_projects", "{}", "--json"], io);

    expect(code).toBe(1);
    expect(JSON.parse(errors.join(""))).toMatchObject({
      ok: false,
      error: {
        code: "MCP_ERROR",
        message: "PROJECT_PERMISSION_DENIED: No access.",
        details: { code: 403, data: { code: "PROJECT_PERMISSION_DENIED", messages: { ko: "권한이 없습니다." } } },
      },
    });
  });

  it("본문이 JSON-RPC 오류가 아니면 지금처럼 상태 코드만", async () => {
    globalThis.fetch = vi.fn(async () => new Response("<html>forbidden</html>", { status: 403 })) as unknown as typeof fetch;

    const code = await runAinectoCli(["tools", "call", "update_projects", "{}"], io);

    expect(code).toBe(1);
    expect(errors.join("")).toBe("Error: MCP HTTP request failed with HTTP 403.\n");
  });

  it("auth 실패도 같은 자리를 지난다", async () => {
    const code = await runAinectoCli(["auth", "nope", "--json"], io);

    expect(code).toBe(1);
    expect(errors.join("")).not.toBe("");
  });
});
