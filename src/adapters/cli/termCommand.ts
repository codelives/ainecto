import { closeSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { daemonCaps, openTermClient, termRequest } from "../../core/term/client";
import { installedComputeFile, runDaemon } from "../../core/term/daemon";
import { runHolder, type DaemonReadiness } from "../../core/term/holder";
import { DETACH_HINT, DetachKeyScanner } from "../../core/term/detachKey";
import { FULL_TERMINAL_RESET } from "../../core/term/screen";
import { noSession, TermError } from "../../core/term/errors";
import { KEY_NAMES } from "../../core/term/keys";
import { isUuid, termPaths, type TermPaths } from "../../core/term/paths";
import { listedSessions, type TermRequestBody } from "../../core/term/protocol";
import { lookupTarget } from "../../core/term/target";
import { waitForMatch } from "../../core/term/wait";
import { renderSuccess } from "../../core/output/render";
import { renderTable } from "../../core/output/table";
import { CLI_VERSION } from "../../core/version";
import type { CliIO } from "./ainectoCli";
import { CliCommandError } from "./errors";

/** 도움말 — 전역 도움말이 이 줄들을 싣는다. */
export const TERM_HELP_LINES: readonly string[] = [
  "  ainecto term new <name> [--cwd DIR] [--project UUID] [-- command args…]   start a session (default: your login shell); AINECTO_TERM_SESSION=<name> inside; --project files it under that AiNecto project on the web",
  "  ainecto term ls [--json]                                  list sessions (name · uuid · kind …)",
  "  ainecto term send <uuid|name> [--paste] [--] <text>       type text (no Enter; --paste wraps it as a bracketed paste when the app asked for it)",
  `  ainecto term key <uuid|name> <key>                        press one key: ${KEY_NAMES.join(", ")}`,
  "  ainecto term read <uuid|name> [--lines N] [--scrollback] [--json]   the screen as text",
  "  ainecto term wait <uuid|name> --match REGEX [--timeout SECONDS] [--lines N] [--scrollback]   until a screen line matches",
  `  ainecto term attach <uuid|name>                           watch and type in your terminal; detach with ${DETACH_HINT}`,
  "  ainecto term kill <uuid|name> · ainecto term kill-server   (a name must match exactly one session; otherwise use its uuid)",
  "  ainecto term restore [--json]                             start again the sessions that were running when the daemon or the machine stopped",
];

interface TermCommandInput {
  argv: string[];
  json: boolean;
  io: CliIO;
}

/**
 * `ainecto term …` — 서버·로그인 없이 이 기기 안에서만 돈다. 오류는 던지면 상위(runAinectoCli)의 renderError 한 곳이 낸다.
 */
export async function executeTermCommand(input: TermCommandInput): Promise<number> {
  const [action, ...rest] = input.argv;
  const paths = termPaths();
  switch (action) {
    case "new":
      return await newSession(paths, rest, input);
    case "ls":
      return await listSessions(paths, rest, input);
    case "send": {
      const args = parseArgs(rest, { paste: "boolean" });
      const [ref, ...words] = args.positionals;
      const text = [...words, ...args.afterDashes].join(" ");
      if (!ref || text.length === 0) {
        throw usage("term send <uuid|name> [--paste] [--] <text>");
      }
      const target = await lookupTarget(paths, ref);
      const data = await onSession(paths, ref, { op: "send", ...target, text, paste: args.flags.paste === true });
      return print(input, data, `Sent ${text.length} characters to ${target.name}.`);
    }
    case "key": {
      const { positionals } = parseArgs(rest, {});
      const [ref, key] = positionals;
      if (!ref || !key || positionals.length > 2) {
        throw usage(`term key <uuid|name> <key>   (${KEY_NAMES.join(", ")})`);
      }
      const target = await lookupTarget(paths, ref);
      const data = await onSession(paths, ref, { op: "key", ...target, key });
      return print(input, data, `Pressed ${key} in ${target.name}.`);
    }
    case "read": {
      const args = parseArgs(rest, { lines: "count", scrollback: "boolean" });
      const ref = singleName(args.positionals, "term read <uuid|name> [--lines N] [--scrollback]");
      const target = await lookupTarget(paths, ref);
      const data = await onSession(paths, ref, { op: "read", ...target, scrollback: args.flags.scrollback === true, lines: countFlag(args.flags.lines) });
      return print(input, data, linesField(data).join("\n"));
    }
    case "wait":
      return await waitCommand(paths, rest, input);
    case "kill": {
      const ref = singleName(parseArgs(rest, {}).positionals, "term kill <uuid|name>");
      const target = await lookupTarget(paths, ref);
      const data = await onSession(paths, ref, { op: "kill", ...target });
      return print(input, data, `Killed ${target.name}.`);
    }
    case "kill-server": {
      // ★끌 holder 의 uuid 를 기능 묻기로 받아 싣는다(설계 3-4) — 옛 구조 데몬(첫 전환 전)은 칸 없이 그대로.
      const found = await daemonCaps(paths);
      const body: TermRequestBody = found.daemon && found.caps ? { op: "kill-server", holder: found.caps.holder } : { op: "kill-server" };
      const result = found.daemon ? await termRequest(paths, body, { start: false }) : { daemon: false as const };
      const data = result.daemon ? result.data : { killed: [] };
      return print(input, data, result.daemon ? "Stopped the term daemon and its sessions." : "No term daemon is running.");
    }
    case "restore": {
      const result = await termRequest(paths, { op: "restore", env: stringEnv() }, { start: true });
      return print(input, result.daemon ? result.data : undefined, restoreSummary(result.daemon ? result.data : undefined));
    }
    case "attach":
      return await attach(paths, singleName(parseArgs(rest, {}).positionals, "term attach <uuid|name>"), input.io);
    case "daemon":
      return await residentCommand(paths, rest, runDaemon);
    case "holder":
      // 숨은 명령(세션 유지 구조 설계 8절) — 바깥(term daemon)이 띄운다. 세션·PTY 를 쥔 holder 한 벌.
      return await residentCommand(paths, rest, runHolder);
    case "remote":
      // ★두 방식 금지 — 다리는 이 PC 연결(`ainecto`) 안에서 PC 당 하나다. 따로 띄우면 같은 PC 의 다리끼리 서로 밀어낸다.
      throw new CliCommandError("MOVED", "`ainecto term remote` is now part of the PC connection: run `ainecto` (it lists every term session "
        + "of this PC in AiNecto on the web). Allow terminals from the web with `ainecto remote on`.");
    default:
      throw usage(`term new|ls|send|key|read|wait|attach|kill|kill-server|restore — see ainecto --help`);
  }
}

async function newSession(paths: TermPaths, argv: string[], input: TermCommandInput): Promise<number> {
  const args = parseArgs(argv, { cwd: "string", project: "string" });
  const name = singleName(args.positionals, "term new <name> [--cwd DIR] [--project UUID] [-- command args…]");
  const project = typeof args.flags.project === "string" ? projectFlag(args.flags.project) : undefined;
  const tty = input.io.stdout.isTTY ? { cols: input.io.stdout.columns, rows: input.io.stdout.rows } : {};
  const result = await termRequest(paths, {
    op: "new",
    name,
    cwd: resolve(typeof args.flags.cwd === "string" ? args.flags.cwd : process.cwd()),
    command: args.afterDashes.length > 0 ? args.afterDashes : null,
    env: stringEnv(),
    ...tty,
    ...(project ? { project } : {}),
    // 사람이 만드는 세션은 종류를 찍는다 — 이름·인자가 옛 판별식(ainecto-pc + pc run)에 걸려도 PC 연결로 보지 않는다(리뷰 0.16.6 P1-4). 옛 데몬은 버린다.
    kind: "user",
  }, { start: true });
  const data = result.daemon ? result.data : undefined;
  // ★0.15.4 앞의 데몬은 project 칸을 모르고 버린다(protocol.ts) — 세션은 꼬리표 없이 뜬다. 조용히 넘기지 않고 한 줄로 알린다.
  const dropped = project !== undefined && keptProject(data) !== project;
  const started = `Started ${name}. Attach with: ainecto term attach ${name}`;
  return print(input, data, dropped
    ? `${started}\nThe running term background process is older and did not keep --project; the session has no project. `
      + "Run `ainecto term kill-server` when no session needs it, then start the session again."
    : started);
}

/** --project — AiNecto 프로젝트 UUID(웹 주소의 projects/<uuid>). 대문자도 받아 소문자로(데몬은 소문자만 받는다 — protocol.ts projectField). */
function projectFlag(value: string): string {
  const uuid = value.trim().toLowerCase();
  if (!isUuid(uuid)) {
    throw new TermError("TERM_USAGE", `--project needs an AiNecto project UUID (the part after projects/ in its web address), not "${value}".`);
  }
  return uuid;
}

async function listSessions(paths: TermPaths, argv: string[], input: TermCommandInput): Promise<number> {
  parseArgs(argv, {});
  const result = await termRequest(paths, { op: "ls" }, { start: false });
  const data = result.daemon ? result.data : { sessions: [] };
  const sessions = listedSessions(data);
  const human = sessions.length === 0
    ? "No term sessions."
    : renderTable(sessions.map((session) => ({
      name: session.name,
      // uuid·종류(세션 유지 구조 원칙 1) — 명령은 uuid 로도 겨눈다. 옛 구조 데몬이면 칸이 비어 있다.
      uuid: session.instance ?? "",
      kind: session.kind ?? "",
      label: session.label ?? "",
      pid: session.pid,
      clients: session.clients,
      size: `${session.cols}x${session.rows}`,
      cwd: session.cwd,
      command: session.command ? session.command.join(" ") : "(login shell)",
    })), { columns: ["name", "uuid", "kind", "label", "pid", "clients", "size", "cwd", "command"] }) ?? "";
  return print(input, data, human);
}

async function waitCommand(paths: TermPaths, argv: string[], input: TermCommandInput): Promise<number> {
  const args = parseArgs(argv, { match: "string", timeout: "count", lines: "count", scrollback: "boolean" });
  const ref = singleName(args.positionals, "term wait <uuid|name> --match REGEX [--timeout SECONDS]");
  if (typeof args.flags.match !== "string") {
    throw usage("term wait <uuid|name> --match REGEX [--timeout SECONDS]");
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(args.flags.match);
  } catch (error) {
    throw new TermError("TERM_USAGE", `--match is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  const timeout = countFlag(args.flags.timeout);
  // ★처음 푼 인스턴스만 본다 — 기다리는 사이 같은 이름 새 세션이 생겨도 그것을 보지 않는다(G7). 넘기기로 연결이 끊겨도 그 인스턴스로 다시 붙는다.
  const target = await lookupTarget(paths, ref);
  const result = await waitForMatch(
    paths,
    target.name,
    pattern,
    { scrollback: args.flags.scrollback === true, lines: countFlag(args.flags.lines) },
    timeout === undefined ? undefined : timeout * 1000,
    target.instance,
  );
  return print(input, result, result.line);
}

/**
 * attach — 사용자 터미널을 raw 로 바꾸고 표준입력 → 세션, 세션 출력 → 표준출력(설계 2-5).
 * 처음에 화면을 지우고 직렬화 화면을 한 번 그린 뒤 원시 출력만 흘린다. 떼거나 세션이 끝나면 세션 앱이 켜 둔
 * 모드(마우스·alternate 화면 등)를 데몬이 알려 준 글자로 되돌린다.
 */
async function attach(paths: TermPaths, ref: string, io: CliIO): Promise<number> {
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    throw new TermError("TERM_NOT_A_TTY", "term attach needs an interactive terminal. Use term read / term send from scripts.");
  }
  const target = await lookupTarget(paths, ref);
  const { name } = target;
  const client = await openTermClient(paths, { start: false });
  if (!client) {
    throw noSession(name);
  }
  const scanner = new DetachKeyScanner();
  let finished = false;
  /** reset = 데몬이 알려 준 되돌림 글자(base64). 없으면(연결이 끊김) 모든 모드를 끄는 글자. */
  let finish: (code: number, reset: string | undefined, note: string) => void = () => undefined;
  const done = new Promise<number>((resolveDone) => {
    finish = (code, reset, note) => {
      if (finished) {
        return;
      }
      finished = true;
      io.stdin.off("data", onInput);
      io.stdout.off("resize", onResize);
      io.stdin.setRawMode(false);
      io.stdin.pause();
      io.stdout.write(reset === undefined ? FULL_TERMINAL_RESET : Buffer.from(reset, "base64"));
      io.stderr.write(`\r\n[${note}]\r\n`);
      client.close();
      resolveDone(code);
    };
  });
  const onInput = (chunk: Buffer): void => {
    const scanned = scanner.scan(chunk);
    if (scanned.forward.length > 0) {
      client.stream({ op: "in", d: scanned.forward.toString("base64") });
    }
    if (scanned.detach) {
      client.request({ op: "detach" }).then(
        (data) => finish(0, resetField(data), `detached from ${name}`),
        (error: unknown) => finish(1, undefined, `detach failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  };
  const onResize = (): void => {
    client.stream({ op: "resize", cols: io.stdout.columns, rows: io.stdout.rows });
  };
  client.onEvent((event) => {
    if (event.event === "screen") {
      io.stdout.write("\x1b[H\x1b[2J");
      io.stdout.write(Buffer.from(event.d, "base64"));
    } else if (event.event === "out") {
      io.stdout.write(Buffer.from(event.d, "base64"));
    } else if (event.event === "exit") {
      finish(0, event.reset, `${name} exited (${event.signal ? `signal ${event.signal}` : `code ${event.exitCode}`})`);
    }
  });
  client.onClose(() => finish(1, undefined, "lost the connection to the term daemon"));
  try {
    await client.request({ op: "attach", ...target, cols: io.stdout.columns, rows: io.stdout.rows });
  } catch (error) {
    client.close();
    throw error;
  }
  io.stdin.setRawMode(true);
  io.stdin.resume();
  io.stdin.on("data", onInput);
  io.stdout.on("resize", onResize);
  return await done;
}

/** 내부 명령(term daemon · term holder) — 띄운 쪽이 detached 로 띄운다. `--ready-fd` 로 준비 한 줄을 돌려준다. */
async function residentCommand(paths: TermPaths, argv: string[],
  run: (options: { paths: TermPaths; version: string; ready: (readiness: DaemonReadiness) => void; compute?: string }) => Promise<number>): Promise<number> {
  const args = parseArgs(argv, { "ready-fd": "count" });
  const readyFd = countFlag(args.flags["ready-fd"]);
  let channelOpen = readyFd !== undefined;
  /** 준비 한 줄 — 채널은 한 번만 쓰고 닫는다. 띄운 쪽이 떠났으면 쓰기가 실패하고(EPIPE) 그 오류를 부른 쪽이 다룬다. */
  const ready = (readiness: DaemonReadiness): void => {
    if (readyFd === undefined) {
      process.stderr.write(`${readiness.status === "locked" ? "Another term daemon is already running." : readiness.status}\n`);
      return;
    }
    if (!channelOpen) {
      return;
    }
    channelOpen = false;
    try {
      writeSync(readyFd, `${JSON.stringify(readiness)}\n`);
    } finally {
      closeSync(readyFd);
    }
  };
  let code: number;
  try {
    const compute = installedComputeFile();
    code = await run({ paths, version: CLI_VERSION, ready, ...(compute ? { compute } : {}) });
  } catch (error) {
    try {
      ready({ status: "error", message: error instanceof Error ? error.message : String(error) });
    } catch (notifyError) {
      // 띄운 쪽이 이미 떠났다 — stderr 는 daemon.log 로 간다.
      process.stderr.write(`ainecto term daemon: could not report the start failure: ${notifyError instanceof Error ? notifyError.message : String(notifyError)}\n`);
    }
    throw error;
  }
  // PTY 소켓 등 남은 핸들이 프로세스를 붙잡지 않게 끝낸다 — 정리는 runDaemon 이 마쳤다.
  process.exit(code);
}

/** 세션이 있어야 하는 요청 — 데몬이 없으면 «그런 세션 없음». */
async function onSession(paths: TermPaths, name: string, body: TermRequestBody): Promise<unknown> {
  const result = await termRequest(paths, body, { start: false });
  if (!result.daemon) {
    throw noSession(name);
  }
  return result.data;
}

function print(input: TermCommandInput, data: unknown, human: string): number {
  input.io.stdout.write(input.json ? renderSuccess(data, { json: true }) : `${human}\n`);
  return 0;
}

function usage(text: string): TermError {
  return new TermError("TERM_USAGE", `Usage: ainecto ${text}`);
}

/** 세션이 받을 환경 — 명령을 친 셸의 환경(값이 문자열인 것만). */
export function stringEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

type FlagKind = "string" | "count" | "boolean";

interface ParsedTermArgs {
  positionals: string[];
  flags: Record<string, string | number | boolean | undefined>;
  /** `--` 뒤 — 명령·글자 그대로. */
  afterDashes: string[];
}

function parseArgs(argv: string[], spec: Record<string, FlagKind>): ParsedTermArgs {
  const result: ParsedTermArgs = { positionals: [], flags: {}, afterDashes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      result.afterDashes = argv.slice(index + 1);
      break;
    }
    if (!arg.startsWith("--")) {
      result.positionals.push(arg);
      continue;
    }
    const flag = arg.slice(2);
    const kind = spec[flag];
    if (!kind) {
      throw new TermError("TERM_USAGE", `Unknown option ${arg}. To pass it on, put it after --.`);
    }
    if (kind === "boolean") {
      result.flags[flag] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined) {
      throw new TermError("TERM_USAGE", `${arg} requires a value.`);
    }
    if (kind === "count") {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 1) {
        throw new TermError("TERM_USAGE", `${arg} must be a positive whole number.`);
      }
      result.flags[flag] = count;
    } else {
      result.flags[flag] = value;
    }
  }
  return result;
}

function singleName(positionals: string[], usageText: string): string {
  const [name] = positionals;
  if (!name || positionals.length > 1) {
    throw usage(usageText);
  }
  return name;
}

function countFlag(value: string | number | boolean | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function linesField(data: unknown): string[] {
  if (data && typeof data === "object" && "lines" in data && Array.isArray(data.lines)) {
    return data.lines.filter((line): line is string => typeof line === "string");
  }
  return [];
}

function keptProject(data: unknown): string | undefined {
  return data && typeof data === "object" && "project" in data && typeof data.project === "string" ? data.project : undefined;
}

function resetField(data: unknown): string | undefined {
  return data && typeof data === "object" && "reset" in data && typeof data.reset === "string" ? data.reset : undefined;
}

function restoreSummary(data: unknown): string {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const names = (key: string): string[] => (Array.isArray(record[key]) ? record[key].filter((item): item is string => typeof item === "string") : []);
  const failed = Array.isArray(record.failed) ? record.failed : [];
  const parts = [
    names("restored").length ? `Restored: ${names("restored").join(", ")}` : "",
    names("running").length ? `Already running: ${names("running").join(", ")}` : "",
    ...failed.map((failure: unknown) => {
      const item = failure && typeof failure === "object" ? (failure as Record<string, unknown>) : {};
      return `Could not restore ${String(item.name)}: ${String(item.message)}`;
    }),
  ].filter(Boolean);
  return parts.length ? parts.join("\n") : "Nothing to restore.";
}
