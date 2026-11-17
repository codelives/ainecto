import { createInterface } from "node:readline";
import {
  AGENT_SESSION_NAME,
  agentServeArgs,
  bridgeLaunch,
  defaultSessionName,
  managedSessions,
  MENU_ITEMS,
  menuLines,
  needsTerm,
  parseChoices,
  runningLines,
  splitCommand,
  type LaunchFlags,
  type ManagedSession,
  type MenuItem,
} from "../../core/launcher/launcher";
import { lastLine, type CommandRunner } from "../../core/setup/commandRunner";
import type { DoctorCheck } from "../../core/setup/doctorChecks";
import { termRequest } from "../../core/term/client";
import type { TermPaths } from "../../core/term/paths";
import { listedSessions, type ListedSession, type TermRequestBody } from "../../core/term/protocol";
import type { CliIO } from "./ainectoCli";

/**
 * 인자 없는 `ainecto`(stdin·stdout 이 터미널일 때만) — 점검 → 메뉴 → 고른 것을 ★기존 term 데몬 세션으로 띄운다(KAN-738).
 * 창을 닫아도 데몬이 세션을 들고 있다. 판단·문구는 core/launcher/launcher.ts 의 순수 함수, 여기는 입출력과 데몬 요청만.
 */
export interface MenuInput {
  io: CliIO;
  paths: TermPaths;
  /** 세션을 띄울 폴더 — serve 가 이 폴더의 .ainecto/agent.local 을 읽는다. */
  cwd: string;
  /** 세션이 받을 환경 — `term new` 와 같다(이 셸의 환경). */
  sessionEnv: Record<string, string>;
  /** 첫 줄 — CLI 판 · 서버 주소. */
  header: string;
  flags?: LaunchFlags;
  /** ★관리 세션 명령을 만드는 곳은 이것 하나 — 운영은 npxCliCommand, 시험은 대역 명령. */
  managedCommand: (args: string[]) => string[];
  /** 관리 세션 명령의 첫 실행(판 확인) — npx 캐시를 한 번 채운다. */
  runner: CommandRunner;
  /** term 을 못 쓰는 기기면 그 이유(daemonLock.termRuntimeProblem). */
  termProblem: string | undefined;
  agentLog: string;
  /** status·doctor 와 같은 수집·판정. */
  checkMachine: () => Promise<DoctorCheck[]>;
  /** `ainecto setup` 그대로. */
  setup: () => Promise<number>;
  /** `ainecto init` 그대로. */
  init: () => Promise<number>;
}

export async function runMenu(input: MenuInput): Promise<number> {
  const out = (line = ""): void => {
    input.io.stdout.write(`${line}\n`);
  };
  const rl = createInterface({ input: input.io.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question: string): Promise<string | undefined> => {
    input.io.stdout.write(question);
    const next = await lines.next();
    return next.done ? undefined : next.value;
  };
  const flags = input.flags ?? {};
  /** 관리 세션 명령은 메뉴 한 번에 한 번 미리 돌려 본다 — 같은 npx 패키지를 두 세션이 동시에 처음 받으면 한쪽이 설치 경합으로 죽는다. */
  let prepared = false;

  const prepare = async (): Promise<void> => {
    if (prepared) {
      return;
    }
    out("Getting the AiNecto CLI ready for background sessions…");
    const [command, ...args] = input.managedCommand(["--version"]);
    if (!command) {
      throw new Error("The background command is empty.");
    }
    const result = await input.runner(command, args);
    if (result.missing || result.exitCode !== 0) {
      throw new Error(`\`${[command, ...args].join(" ")}\` failed${result.missing ? ` (${command} is not on PATH)` : ""}: `
        + `${lastLine(result.stderr) ?? lastLine(result.stdout) ?? `exit ${result.exitCode}`}`);
    }
    prepared = true;
  };

  const request = async (body: TermRequestBody, start: boolean): Promise<unknown> => {
    const result = await termRequest(input.paths, body, { start });
    return result.daemon ? result.data : undefined;
  };
  const listed = async (): Promise<ListedSession[]> => (input.termProblem === undefined ? listedSessions(await request({ op: "ls" }, false)) : []);
  const size = (): { cols?: number; rows?: number } => (input.io.stdout.isTTY ? { cols: input.io.stdout.columns, rows: input.io.stdout.rows } : {});
  const newSession = async (name: string, command: string[] | null): Promise<void> => {
    await request({ op: "new", name, cwd: input.cwd, command, env: input.sessionEnv, ...size() }, true);
  };

  const startAgent = async (): Promise<void> => {
    const running = managedSessions(await listed()).find((entry) => entry.kind === "agent");
    if (running) {
      out(`Your PC agent is already running in session ${running.session}.`);
      return;
    }
    await prepare();
    await newSession(AGENT_SESSION_NAME, input.managedCommand(agentServeArgs(flags)));
    out(`Started your PC agent in session ${AGENT_SESSION_NAME}. Log: ${input.agentLog} · watch it: ainecto term attach ${AGENT_SESSION_NAME}`);
  };

  /** ② 앞 단계 — 세션 만들기(`term new` 와 같다: 이름·명령을 묻는다). 만든 세션 이름, 못 만들었으면 undefined. */
  const createSession = async (): Promise<string | undefined> => {
    const fallback = defaultSessionName(input.cwd);
    const name = (await ask(`Session name [${fallback}]: `))?.trim() || fallback;
    const command = splitCommand((await ask("Command to run in it [your login shell]: ")) ?? "");
    if ((await listed()).some((session) => session.name === name)) {
      out(`A session named ${name} already exists. Pick another name, or share it yourself: ainecto term remote ${name}`);
      return undefined;
    }
    await newSession(name, command);
    out(`Started session ${name}. Here: ainecto term attach ${name}`);
    return name;
  };

  /**
   * ② 뒤 단계 — 이 PC 를 웹에 연결(다리 켜기). 이미 있으면 «실행 중». 다리의 이름·명령은 {@link bridgeLaunch} 한 곳이 정한다
   * (지금 판은 세션마다 다리, 다음 판은 PC 당 하나 — 그때도 이 함수의 «이미 있나» 판정은 managedSessions 가 한다).
   */
  const connectToWeb = async (target: string): Promise<void> => {
    const running = managedSessions(await listed()).find((entry) => entry.kind === "remote" && entry.target === target);
    if (running) {
      out(`${target} is already shared on AiNecto (session ${running.session}).`);
      return;
    }
    await prepare();
    const bridge = bridgeLaunch(target, flags);
    await newSession(bridge.session, input.managedCommand(bridge.args));
    out(`Shared ${target} on AiNecto (session ${bridge.session}). Open the remote terminal in AiNecto to use it. Log: ${input.paths.remoteLog}`);
  };

  const startRemote = async (): Promise<void> => {
    const name = await createSession();
    if (name !== undefined) {
      await connectToWeb(name);
    }
  };

  /** 끄기 = Ctrl+C — serve·remote 는 SIGINT 에 서버에 끝을 알리고 스스로 끝난다(term kill 의 SIGHUP 은 그 처리를 건너뛴다). */
  const stop = async (entry: ManagedSession): Promise<void> => {
    await request({ op: "key", name: entry.session, key: "ctrl-c" }, false);
    if (entry.kind === "agent") {
      out(`Stopping your PC agent (session ${entry.session}).`);
      return;
    }
    if ((await listed()).some((session) => session.name === entry.target)) {
      await request({ op: "kill", name: entry.target }, false);
    }
    out(`Stopped sharing ${entry.target} and ended that session.`);
  };

  const showRunning = async (): Promise<void> => {
    const managed = managedSessions(await listed());
    for (const line of runningLines(managed, { agent: input.agentLog, remote: input.paths.remoteLog })) {
      out(line);
    }
    if (managed.length === 0) {
      return;
    }
    const picked = parseChoices((await ask("Stop which? (numbers like 1,2; Enter to go back): ")) ?? "", managed.length);
    if ("error" in picked) {
      out(picked.error);
      return;
    }
    for (const index of picked.choices) {
      const entry = managed[index - 1];
      if (entry) {
        await attempt(`stop ${entry.session}`, () => stop(entry));
      }
    }
  };

  const attempt = async (what: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      out(`Could not ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const run = async (item: MenuItem): Promise<void> => {
    if (needsTerm(item) && input.termProblem !== undefined) {
      out(input.termProblem);
      return;
    }
    switch (item) {
      case "agent":
        return attempt("start your PC agent", startAgent);
      case "remote":
        return attempt("start the remote terminal", startRemote);
      case "running":
        return attempt("list what is running", showRunning);
      case "init":
        return attempt("set up this folder", input.init);
    }
  };

  try {
    out(input.header);
    out("Checking sign-in and connections…");
    const checks = await input.checkMachine();
    const problems = checks.filter((check) => check.level !== "ok");
    for (const check of problems) {
      out(`  ${check.level === "fail" ? "✗" : "!"} ${check.item}: ${check.detail}${check.fix ? ` — fix: ${check.fix}` : ""}`);
    }
    if (problems.length === 0) {
      out("Signed in, and everything is connected.");
    }
    if (checks.some((check) => check.item === "sign-in" && check.level === "fail")) {
      const answer = ((await ask("Sign in and connect your coding agents now (ainecto setup)? [Y/n]: ")) ?? "n").trim().toLowerCase();
      if (answer !== "" && answer !== "y" && answer !== "yes") {
        out("Run `ainecto setup` when you are ready, then `ainecto` again.");
        return 0;
      }
      const code = await input.setup();
      if (code !== 0) {
        return code;
      }
    }
    for (;;) {
      out();
      let sessions: ListedSession[] = [];
      try {
        sessions = await listed();
      } catch (error) {
        // 메뉴는 보여 준다 — «실행 중» 표시만 빠진다는 것을 알린다.
        out(`Could not read the background sessions: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const line of menuLines(managedSessions(sessions), input.termProblem)) {
        out(line);
      }
      const answer = await ask("Choose numbers (like 1,2), or press Enter to quit: ");
      if (answer === undefined || answer.trim() === "" || answer.trim().toLowerCase() === "q") {
        out("Background sessions keep running after you close this window.");
        return 0;
      }
      const picked = parseChoices(answer, MENU_ITEMS.length);
      if ("error" in picked) {
        out(picked.error);
        continue;
      }
      for (const index of picked.choices) {
        const item = MENU_ITEMS[index - 1];
        if (item) {
          await run(item);
        }
      }
    }
  } finally {
    rl.close();
  }
}
