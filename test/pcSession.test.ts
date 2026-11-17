import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAinectoCli } from "../src/adapters/cli/ainectoCli";
import {
  npxCliCommand,
  pcAction,
  pcRunArgs,
  pcStatusView,
  pcStopDeadlineMs,
  pcVersionLabel,
  runningPcs,
} from "../src/core/pc/pcSession";
import { lastServeStop } from "../src/core/agent/log";

const pcCommand = (spec: string) => ["npx", "-y", "--package", spec, "ainecto", "pc", "run", "--env", "dev"];

describe("이 PC 연결 — 순수 함수", () => {
  it("세션 명령 — 이 판으로 고정한 npx --package 의 ainecto 실행 파일(주 이름의 기본 실행 파일은 MCP 브리지다) · 플래그 그대로", () => {
    expect(npxCliCommand(pcRunArgs({ env: "dev" }), "0.14.0")).toEqual(pcCommand("@ainecto/mcp@0.14.0"));
    expect(npxCliCommand(pcRunArgs({ endpoint: "https://x.test/mcp" }), "dev"))
      .toEqual(["npx", "-y", "--package", "@ainecto/mcp", "ainecto", "pc", "run", "--endpoint", "https://x.test/mcp"]);
  });

  it("도는 것은 이름이 아니라 «명령»(pc run)으로 찾는다 · 판은 --package 값", () => {
    const found = runningPcs([
      { name: "whatever", cwd: "/w", command: pcCommand("@ainecto/mcp@0.14.0") },
      { name: "ainecto-pc", cwd: "/x", command: null },
      { name: "shell", cwd: "/y", command: ["zsh", "-lc", "echo pc run"] },
      { name: "stand-in", cwd: "/z", command: ["/usr/bin/node", "-e", "…", "pc", "run"] },
    ]);
    expect(found).toEqual([
      { session: "whatever", cwd: "/w", packageSpec: "@ainecto/mcp@0.14.0" },
      { session: "stand-in", cwd: "/z" },
    ]);
    expect(found.map(pcVersionLabel)).toEqual(["0.14.0", "unpinned"]);
  });

  it("시작 판정 — 없음 start · 같은 판 하나 already · 옛 판·고정 안 됨·여러 개 replace · dev 끼리는 already", () => {
    const at = (spec?: string) => ({ session: "ainecto-pc", cwd: "/w", ...(spec ? { packageSpec: spec } : {}) });
    expect(pcAction([], "0.14.0")).toEqual({ kind: "start" });
    expect(pcAction([at("@ainecto/mcp@0.14.0")], "0.14.0")).toEqual({ kind: "already", pc: at("@ainecto/mcp@0.14.0") });
    expect(pcAction([at("@ainecto/mcp@0.13.1")], "0.14.0").kind).toBe("replace");
    expect(pcAction([at()], "0.14.0").kind).toBe("replace");
    expect(pcAction([at("@ainecto/mcp@0.14.0"), at("@ainecto/mcp@0.14.0")], "0.14.0").kind).toBe("replace");
    expect(pcAction([at("@ainecto/mcp")], "dev").kind).toBe("already");
  });

  it("끄기 기다림 = 기존 기한의 합(Agent 멈추기 B6×4 + 서버 close 호출 B1·원격 C10 중 큰 것) — 새 숫자 0", () => {
    expect(pcStopDeadlineMs()).toBe(5_000 * 4 + 10_000);
  });

  it("status 칸 — 연결·판·폴더 · 동의·원격 허용 · 터미널 세션(연결 세션은 뺀다) · term 못 쓰는 기기", () => {
    const sessions = [
      { name: "ainecto-pc", cwd: "/w", command: pcCommand("@ainecto/mcp@0.14.0") },
      { name: "work", cwd: "/w", command: null },
    ];
    expect(pcStatusView({ sessions, approval: { consentedAt: "t", remoteTerminal: false }, agentLog: "/h/agent.log", termProblem: undefined })).toEqual({
      connected: true, session: "ainecto-pc", folder: "/w", version: "0.14.0", log: "/h/agent.log",
      approved: true, remoteTerminal: "blocked", terminalSessions: ["work"],
    });
    expect(pcStatusView({ sessions: [], approval: undefined, agentLog: "l", termProblem: undefined }))
      .toEqual({ connected: false, approved: false, terminalSessions: [] });
    // 연결이 없으면 마지막으로 끊긴 사유 — 다른 PC 가 가져갔으면 풀어 쓴다.
    expect(pcStatusView({ sessions: [], approval: undefined, agentLog: "l", termProblem: undefined, lastStop: { at: "t", reason: "replaced" } }).lastStop)
      .toEqual({ at: "t", reason: "replaced", note: "another PC took over your AiNecto agent — run `ainecto` here to take it back" });
    expect(pcStatusView({ sessions, approval: undefined, agentLog: "l", termProblem: undefined, lastStop: { at: "t", reason: "replaced" } }).lastStop)
      .toBeUndefined();
    expect(lastServeStop([
      JSON.stringify({ ts: "a", event: "serve_stop", pid: 1, reason: "signal" }),
      JSON.stringify({ ts: "b", event: "serve_stop", pid: 2, reason: "replaced" }),
      JSON.stringify({ ts: "c", event: "serve_start", pid: 3 }),
      "{broken",
    ].join("\n"))).toEqual({ at: "b", reason: "replaced" });
    expect(lastServeStop("")).toBeUndefined();
    expect(pcStatusView({ sessions: [], approval: undefined, agentLog: "l", termProblem: "not on win32" }))
      .toEqual({ connected: false, unsupported: "not on win32" });
  });
});

describe("CLI 입구 — 인자 없음·start·agent serve", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalCwd: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ainecto-pc-"));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    originalCwd = process.cwd();
    process.chdir(home);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  const run = async (argv: string[], tty: boolean) => {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      stdout: { isTTY: tty, write: (text: string) => { out.push(text); return true; } },
      stderr: { write: (text: string) => { err.push(text); return true; } },
      stdin: { isTTY: tty, on: () => undefined, resume: () => undefined },
    } as unknown as Parameters<typeof runAinectoCli>[1];
    const code = await runAinectoCli(argv, io);
    return { code, out: out.join(""), err: err.join("") };
  };

  it("인자 없음 + 파이프(AI 에이전트·스크립트) — 도움말 그대로, 아무것도 띄우지 않는다", async () => {
    const result = await run([], false);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Usage:");
    expect(result.out).toContain("ainecto start [--env prod|dev]");
    expect(result.out).toContain("ainecto stop [--forget]");
    expect(result.out).toContain("ainecto remote on|off");
    expect(result.out).not.toContain("ainecto agent serve");
  });

  it("터미널이어도 --help·--json 이면 도움말", async () => {
    expect((await run(["--help"], true)).out).toContain("Usage:");
    expect((await run(["--json"], true)).out).toContain("Usage:");
  });

  it("agent serve 는 안내 한 줄로 끝난다(두 방식 금지)", async () => {
    const result = await run(["agent", "serve"], false);
    expect(result.code).toBe(1);
    expect(result.err).toContain("`ainecto agent serve` is now `ainecto start`");
  });

  it("start 에 모르는 인자 — 사용법", async () => {
    const result = await run(["start", "now"], false);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Usage: ainecto start");
  });
});
