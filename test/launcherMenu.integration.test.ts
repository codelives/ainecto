import { PassThrough } from "node:stream";
import { runMenu, type MenuInput } from "../src/adapters/cli/menuCommand";
import { systemCommandRunner } from "../src/core/setup/commandRunner";
import { termPaths } from "../src/core/term/paths";
import { LONG, ok, rig, sessions, until, useTermRig } from "./termRig";

/**
 * 인자 없는 `ainecto` 메뉴 — 실 데몬·실 PTY. 관리 세션 명령만 대역(아래 STAND_IN)으로 바꾼다: 서버·로그인·npx 없이
 * «agent serve»·«term remote» 처럼 Ctrl+C 를 받으면 끝나는 프로세스. 판 확인(--version)은 바로 0 으로 끝난다.
 * 메뉴는 이 시험 프로세스 안에서 돈다 — 데몬은 리그의 진짜 CLI 가 먼저 띄운다(메뉴가 띄우면 vitest 를 띄운다).
 */
const STAND_IN = "if (process.argv.includes('--version')) process.exit(0);"
  + "process.on('SIGINT', () => process.exit(0)); setInterval(() => undefined, 1000);";

useTermRig();

function harness(overrides: Partial<MenuInput> = {}) {
  const stdin = new PassThrough();
  let out = "";
  const sink = { isTTY: true, columns: 100, rows: 30, write: (text: string) => { out += text; return true; } };
  const setups: number[] = [];
  const env = Object.fromEntries(Object.entries(rig.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const input: MenuInput = {
    io: { stdin: stdin as unknown as NodeJS.ReadStream, stdout: sink as unknown as NodeJS.WriteStream, stderr: sink as unknown as NodeJS.WriteStream },
    paths: termPaths(rig.home),
    cwd: rig.home,
    sessionEnv: env,
    header: "AiNecto CLI test · https://example.test/mcp",
    managedCommand: (args) => [process.execPath, "-e", STAND_IN, ...args],
    runner: systemCommandRunner({ cwd: rig.home, env: rig.env }),
    termProblem: undefined,
    agentLog: `${rig.home}/.ainecto/agent/agent.log`,
    checkMachine: async () => [{ item: "sign-in", level: "ok", detail: "signed in" }],
    setup: async () => { setups.push(1); return 0; },
    init: async () => 0,
    ...overrides,
  };
  const count = (text: string): number => out.split(text).length - 1;
  return {
    input,
    setups,
    output: () => out,
    type: (line: string) => stdin.write(`${line}\n`),
    end: () => stdin.end(),
    /** 출력에 text 가 n 번째로 나올 때까지. */
    waitFor: (text: string, n = 1) => until(() => count(text) >= n, `«${text}» ×${n}\n--- output ---\n${out}`),
  };
}

describe("인자 없는 ainecto — 메뉴로 백그라운드 실행", () => {
  beforeEach(async () => {
    // 데몬을 리그의 CLI 로 띄워 둔다(관리 대상이 아닌 세션 하나 — 메뉴가 세지 않아야 한다).
    await ok("term", "new", "warm", "--", "sleep", "600");
  });

  it("2 → 이름·명령 → 사용자 세션 + 다리 세션 · 3 → 도는 것에 보이고 끄면 둘 다 없다", async () => {
    const menu = harness();
    const done = runMenu(menu.input);
    await menu.waitFor("Choose");
    menu.type("2");
    await menu.waitFor("Session name");
    menu.type("work");
    await menu.waitFor("Command to run");
    menu.type("sleep 600");
    await menu.waitFor("Choose", 2);
    expect(menu.output()).toContain("Started session work.");
    expect(menu.output()).toContain("Shared work on AiNecto (session ainecto-remote-work).");

    const listed = await sessions();
    expect(listed.find((s) => s.name === "work")?.command).toEqual(["sleep", "600"]);
    expect(listed.find((s) => s.name === "work")?.cwd).toBe(rig.home);
    expect(listed.find((s) => s.name === "ainecto-remote-work")?.command?.slice(-3)).toEqual(["term", "remote", "work"]);
    expect(menu.output()).toContain("[running: work]");

    menu.type("3");
    await menu.waitFor("Stop which?");
    expect(menu.output()).toContain("  1) Remote terminal   session work (shared by ainecto-remote-work)");
    expect(menu.output()).not.toContain("warm (");
    menu.type("1");
    await until(async () => (await sessions()).every((s) => s.name !== "work" && s.name !== "ainecto-remote-work"), "remote sessions gone");
    expect((await sessions()).map((s) => s.name)).toEqual(["warm"]);
    // 다리는 Ctrl+C 로 스스로 끝났다(신호 없이) — 재부팅 뒤 restore 가 되살리지 않는다.
    const manifest = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(`${rig.home}/.ainecto/term/sessions.json`, "utf8"))) as { sessions: { name: string }[] };
    expect(manifest.sessions.map((s) => s.name)).toEqual(["warm"]);

    await menu.waitFor("Choose", 3);
    menu.type("");
    expect(await done).toBe(0);
  }, LONG);

  it("1 → agent serve 세션 · 다시 1 → «already running» · 3 에 보인다", async () => {
    const menu = harness();
    const done = runMenu(menu.input);
    await menu.waitFor("Choose");
    menu.type("1");
    await menu.waitFor("Choose", 2);
    expect(menu.output()).toContain("Started your PC agent in session ainecto-agent.");
    const agent = (await sessions()).find((s) => s.name === "ainecto-agent");
    expect(agent?.command?.slice(-2)).toEqual(["agent", "serve"]);
    expect(menu.output()).toContain("[running: ainecto-agent]");

    menu.type("1,3");
    await menu.waitFor("Stop which?");
    expect(menu.output()).toContain("Your PC agent is already running in session ainecto-agent.");
    expect(menu.output()).toContain("  1) PC agent          session ainecto-agent");
    menu.type("");
    await menu.waitFor("Choose", 3);
    menu.end();
    expect(await done).toBe(0);
    expect((await sessions()).map((s) => s.name).sort()).toEqual(["ainecto-agent", "warm"]);
  }, LONG);

  it("로그인 전이면 setup 부터 묻는다 — 거절하면 메뉴 없이 끝", async () => {
    const menu = harness({ checkMachine: async () => [{ item: "sign-in", level: "fail", detail: "not signed in to https://example.test/mcp", fix: "ainecto setup" }] });
    const done = runMenu(menu.input);
    await menu.waitFor("Sign in and connect your coding agents now");
    menu.type("n");
    expect(await done).toBe(0);
    expect(menu.setups).toEqual([]);
    expect(menu.output()).not.toContain("Choose");
  }, LONG);

  it("term 을 못 쓰는 기기 — 1 은 이유를 말하고 아무것도 띄우지 않는다", async () => {
    const menu = harness({ termProblem: "ainecto term is not supported on win32 yet (macOS and Linux only)." });
    const done = runMenu(menu.input);
    await menu.waitFor("Choose");
    menu.type("1");
    await menu.waitFor("Choose", 2);
    expect(menu.output()).toContain("ainecto term is not supported on win32 yet");
    menu.end();
    expect(await done).toBe(0);
    expect((await sessions()).map((s) => s.name)).toEqual(["warm"]);
  }, LONG);
});
