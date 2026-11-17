import { basename } from "node:path";
import { assertSessionName } from "../term/sessionName";
import type { ListedSession } from "../term/protocol";
import { bridgePackageSpec, CLI_VERSION } from "../version";

/**
 * 인자 없는 `ainecto`(대화형 터미널) — 고른 것을 ★기존 term 데몬 세션으로 백그라운드에 띄운다(KAN-738).
 * 여기는 순수 함수만: 메뉴 문구·입력 해석·«무엇이 돌고 있나» 판정·관리 세션 명령. 입출력·데몬 호출은 adapters/cli/menuCommand.ts.
 *
 * <p>★«돌고 있나»는 세션 «이름»이 아니라 세션 «명령»으로 판단한다 — 이름은 기본값일 뿐 사용자가 같은 일을 다른 이름으로
 * 띄웠어도(`term new x -- … agent serve`) 같은 것으로 본다.
 */

/** ① PC Agent 세션의 기본 이름. */
export const AGENT_SESSION_NAME = "ainecto-agent";

/** 메뉴를 띄울 때 받은 전역 플래그 — 관리 세션에 그대로 넘긴다. */
export interface LaunchFlags {
  env?: string;
  endpoint?: string;
}

function flagArgs(flags: LaunchFlags): string[] {
  return [
    ...(flags.env ? ["--env", flags.env] : []),
    ...(flags.endpoint ? ["--endpoint", flags.endpoint] : []),
  ];
}

export function agentServeArgs(flags: LaunchFlags): string[] {
  return ["agent", "serve", ...flagArgs(flags)];
}

/**
 * ② «이 PC 를 웹에 연결» — 다리 세션의 이름과 명령을 만드는 ★한 곳.
 * 지금 판의 `term remote` 는 세션 인자를 요구해서 세션마다 다리 하나다. 다음 판은 PC 당 다리 하나(`term remote`, 인자 없음 —
 * 그 PC 의 세션 전부를 웹에 올린다)로 바뀐다 — 그때 이 함수(와 {@link managedKind} 의 판정)만 바꾼다.
 */
export function bridgeLaunch(target: string, flags: LaunchFlags): { session: string; args: string[] } {
  return { session: `ainecto-remote-${target}`, args: ["term", "remote", target, ...flagArgs(flags)] };
}

/**
 * 관리 세션이 돌릴 명령 — ★이 CLI 판으로 고정한 npx({@link bridgePackageSpec}). 지금 프로세스의 경로(npx 캐시 폴더일 수 있다)에
 * 기대지 않는다. 주 이름의 기본 실행 파일은 MCP 브리지(`mcp`)라서 `--package … ainecto` 로 CLI 실행 파일을 고른다.
 */
export function npxCliCommand(args: readonly string[], version: string = CLI_VERSION): string[] {
  return ["npx", "-y", "--package", bridgePackageSpec(version), "ainecto", ...args];
}

export type ManagedSession =
  | { kind: "agent"; session: string }
  | { kind: "remote"; session: string; target: string };

/** 세션 명령에서 `agent serve` · `term remote <세션>` 을 찾는다(앞의 실행 파일·뒤의 플래그와 무관). */
export function managedKind(command: readonly string[] | null | undefined): { kind: "agent" } | { kind: "remote"; target: string } | undefined {
  if (!Array.isArray(command)) {
    return undefined;
  }
  for (let index = 0; index + 1 < command.length; index += 1) {
    if (command[index] === "agent" && command[index + 1] === "serve") {
      return { kind: "agent" };
    }
    const target = command[index + 2];
    if (command[index] === "term" && command[index + 1] === "remote" && target !== undefined) {
      return { kind: "remote", target };
    }
  }
  return undefined;
}

export function managedSessions(sessions: ReadonlyArray<Pick<ListedSession, "name" | "command">>): ManagedSession[] {
  const found: ManagedSession[] = [];
  for (const session of sessions) {
    const kind = managedKind(session.command);
    if (kind?.kind === "agent") {
      found.push({ kind: "agent", session: session.name });
    } else if (kind?.kind === "remote") {
      found.push({ kind: "remote", session: session.name, target: kind.target });
    }
  }
  return found;
}

/** 메뉴 항목 — 번호 = 순서 + 1. */
export const MENU_ITEMS = ["agent", "remote", "running", "init"] as const;
export type MenuItem = (typeof MENU_ITEMS)[number];

/** term 이 있어야 하는 항목 — Windows 등에서는 «not available here». */
export function needsTerm(item: MenuItem): boolean {
  return item !== "init";
}

const MENU_TEXT: Readonly<Record<MenuItem, string>> = {
  agent: "Connect your PC agent to AiNecto Chat (ainecto agent serve)",
  remote: "Use a terminal on this PC from AiNecto on the web (ainecto term remote)",
  running: "See what is running, or stop it",
  init: "Add AiNecto's working rules to this folder (ainecto init)",
};

export function menuLines(managed: readonly ManagedSession[], termProblem: string | undefined): string[] {
  return [
    "What should run in the background?",
    ...MENU_ITEMS.map((item, index) => {
      const marks = termProblem !== undefined && needsTerm(item) ? ["not available here"] : runningMarks(item, managed);
      return `  ${index + 1}) ${MENU_TEXT[item]}${marks.map((mark) => `   [${mark}]`).join("")}`;
    }),
  ];
}

function runningMarks(item: MenuItem, managed: readonly ManagedSession[]): string[] {
  if (item === "agent") {
    return managed.filter((entry) => entry.kind === "agent").map((entry) => `running: ${entry.session}`);
  }
  if (item === "remote") {
    const targets = managed.flatMap((entry) => (entry.kind === "remote" ? [entry.target] : []));
    return targets.length > 0 ? [`running: ${targets.join(", ")}`] : [];
  }
  return [];
}

/**
 * 번호 고르기 — «1,2»·«1 2» · 같은 번호는 한 번(처음 자리) · 빈 줄은 없음. 범위 밖·글자는 오류 문장.
 */
export function parseChoices(input: string, count: number): { choices: number[] } | { error: string } {
  const choices: number[] = [];
  for (const token of input.split(/[\s,]+/).filter(Boolean)) {
    const value = Number(token);
    if (!/^\d+$/.test(token) || value < 1 || value > count) {
      return { error: `"${token}" is not a choice — type numbers from 1 to ${count}, like 1,2.` };
    }
    if (!choices.includes(value)) {
      choices.push(value);
    }
  }
  return { choices };
}

const RESTORE_HINT = "After the PC restarts, start them again with: ainecto term restore";

/** ③ 화면 — 종류·세션·로그 자리. 번호는 «끄기» 고르기에 쓴다. */
export function runningLines(managed: readonly ManagedSession[], logs: { agent: string; remote: string }): string[] {
  if (managed.length === 0) {
    return ["Nothing from this menu is running.", RESTORE_HINT];
  }
  return [
    "Running in the background:",
    ...managed.map((entry, index) => (entry.kind === "agent"
      ? `  ${index + 1}) PC agent          session ${entry.session}   log ${logs.agent}`
      : `  ${index + 1}) Remote terminal   session ${entry.target} (shared by ${entry.session})   log ${logs.remote}`)),
    RESTORE_HINT,
  ];
}

/** ② 세션 이름 기본값 — 지금 폴더 이름(공백은 -). 세션 이름이 될 수 없으면 «shell». */
export function defaultSessionName(cwd: string): string {
  const name = basename(cwd).replace(/\s+/g, "-");
  try {
    assertSessionName(name);
    return name;
  } catch {
    // 폴더 이름이 세션 이름 규칙에 맞지 않는다(빈 이름·- 로 시작) — 기본값만 바꾼다. 사용자가 고른 이름은 데몬이 같은 규칙으로 막는다.
    return "shell";
  }
}

/** ② 실행할 명령 — 공백으로 나눈다(셸 따옴표는 해석하지 않는다). 비면 null = 로그인 셸(`term new` 기본과 같다). */
export function splitCommand(text: string): string[] | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 ? words : null;
}
