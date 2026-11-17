import { describe, expect, it } from "vitest";
import { runAinectoCli } from "../src/adapters/cli/ainectoCli";
import {
  AGENT_SESSION_NAME,
  agentServeArgs,
  defaultSessionName,
  managedSessions,
  menuLines,
  npxCliCommand,
  parseChoices,
  remoteSessionName,
  runningLines,
  splitCommand,
  termRemoteArgs,
} from "../src/core/launcher/launcher";

describe("인자 없는 ainecto — 순수 함수", () => {
  it("번호 고르기 — «1,2»·«1 2»·중복은 한 번 · 범위 밖·글자는 오류 · 빈 줄은 없음", () => {
    expect(parseChoices("1,2", 4)).toEqual({ choices: [1, 2] });
    expect(parseChoices(" 3  1 ,1 ", 4)).toEqual({ choices: [3, 1] });
    expect(parseChoices("", 4)).toEqual({ choices: [] });
    expect(parseChoices("5", 4)).toEqual({ error: "\"5\" is not a choice — type numbers from 1 to 4, like 1,2." });
    expect(parseChoices("a", 4)).toEqual({ error: "\"a\" is not a choice — type numbers from 1 to 4, like 1,2." });
  });

  it("관리 세션 명령 — 이 판으로 고정한 npx --package 의 ainecto 실행 파일(주 이름의 기본 실행 파일은 MCP 브리지다)", () => {
    expect(npxCliCommand(["agent", "serve"], "0.14.0")).toEqual(["npx", "-y", "--package", "@ainecto/mcp@0.14.0", "ainecto", "agent", "serve"]);
    // 번들 밖 실행(dev)은 판을 고정하지 않는다 — bridgePackageSpec 과 같은 규칙.
    expect(npxCliCommand(["agent", "serve"], "dev")).toEqual(["npx", "-y", "--package", "@ainecto/mcp", "ainecto", "agent", "serve"]);
  });

  it("받은 --env·--endpoint 는 그대로 넘긴다", () => {
    expect(agentServeArgs({})).toEqual(["agent", "serve"]);
    expect(agentServeArgs({ env: "dev" })).toEqual(["agent", "serve", "--env", "dev"]);
    expect(termRemoteArgs("work", { endpoint: "https://x.test/mcp" })).toEqual(["term", "remote", "work", "--endpoint", "https://x.test/mcp"]);
  });

  it("도는 것은 이름이 아니라 «명령»으로 찾는다 — 실행 파일 앞부분(npx·대역)과 무관", () => {
    const found = managedSessions([
      { name: "anything", command: ["npx", "-y", "--package", "@ainecto/mcp@1.0.0", "ainecto", "agent", "serve", "--env", "dev"] },
      { name: "ainecto-agent", command: null },
      { name: "b", command: ["/usr/bin/node", "stand-in.js", "term", "remote", "work"] },
      { name: "work", command: ["claude"] },
      { name: "c", command: ["echo", "agent"] },
      { name: "d", command: ["x", "term", "remote"] },
    ]);
    expect(found).toEqual([
      { kind: "agent", session: "anything" },
      { kind: "remote", session: "b", target: "work" },
    ]);
  });

  it("메뉴 — 도는 것에 «running» · term 을 못 쓰는 기기는 1~3 을 «not available»", () => {
    const running = menuLines([{ kind: "agent", session: AGENT_SESSION_NAME }, { kind: "remote", session: remoteSessionName("work"), target: "work" }], undefined);
    expect(running.join("\n")).toBe([
      "What should run in the background?",
      "  1) Connect your PC agent to AiNecto Chat (ainecto agent serve)   [running: ainecto-agent]",
      "  2) Use a terminal on this PC from AiNecto on the web (ainecto term remote)   [running: work]",
      "  3) See what is running, or stop it",
      "  4) Add AiNecto's working rules to this folder (ainecto init)",
    ].join("\n"));
    const windows = menuLines([], "ainecto term is not supported on win32 yet (macOS and Linux only).");
    expect(windows[1]).toContain("[not available here]");
    expect(windows[3]).toContain("[not available here]");
    expect(windows[4]).not.toContain("[not available here]");
  });

  it("도는 것 표 — 종류·세션·로그 자리 · 재부팅 안내", () => {
    const lines = runningLines([{ kind: "agent", session: "ainecto-agent" }, { kind: "remote", session: "ainecto-remote-work", target: "work" }],
      { agent: "/h/.ainecto/agent/agent.log", remote: "/h/.ainecto/term/remote.log" });
    expect(lines).toEqual([
      "Running in the background:",
      "  1) PC agent          session ainecto-agent   log /h/.ainecto/agent/agent.log",
      "  2) Remote terminal   session work (shared by ainecto-remote-work)   log /h/.ainecto/term/remote.log",
      "After the PC restarts, start them again with: ainecto term restore",
    ]);
    expect(runningLines([], { agent: "a", remote: "r" })).toEqual([
      "Nothing from this menu is running.",
      "After the PC restarts, start them again with: ainecto term restore",
    ]);
  });

  it("세션 이름 기본값 = 폴더 이름(공백은 -) · 명령 = 공백으로 나눔, 비면 로그인 셸(null)", () => {
    expect(defaultSessionName("/Users/me/my project")).toBe("my-project");
    expect(defaultSessionName("/")).toBe("shell");
    expect(defaultSessionName("/x/-dash")).toBe("shell");
    expect(splitCommand("  claude   --resume ")).toEqual(["claude", "--resume"]);
    expect(splitCommand("   ")).toBeNull();
  });
});

describe("인자 없는 ainecto — 대화형이 아니면 지금처럼 도움말", () => {
  const run = async (argv: string[], tty: boolean) => {
    const out: string[] = [];
    const io = {
      stdout: { isTTY: tty, write: (text: string) => { out.push(text); return true; } },
      stderr: { write: () => true },
      stdin: { isTTY: tty, on: () => undefined, resume: () => undefined },
    } as unknown as Parameters<typeof runAinectoCli>[1];
    const code = await runAinectoCli(argv, io);
    return { code, text: out.join("") };
  };

  it("파이프(AI 에이전트·스크립트) — 도움말", async () => {
    const result = await run([], false);
    expect(result.code).toBe(0);
    expect(result.text).toContain("Usage:");
    expect(result.text).toContain("ainecto term remote <name>");
  });

  it("터미널이어도 --help·--json 이면 도움말", async () => {
    expect((await run(["--help"], true)).text).toContain("Usage:");
    expect((await run(["--json"], true)).text).toContain("Usage:");
  });

  it("도움말 맨 위에 «인자 없이 치면 메뉴» 한 줄", async () => {
    expect((await run([], false)).text).toContain("with no arguments in a terminal: pick what to run in the background");
  });
});
