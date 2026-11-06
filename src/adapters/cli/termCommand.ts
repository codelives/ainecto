import { closeSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { openTermClient, termRequest } from "../../core/term/client";
import { runDaemon, type DaemonReadiness } from "../../core/term/daemon";
import { DETACH_HINT, DetachKeyScanner } from "../../core/term/detachKey";
import { TermError } from "../../core/term/errors";
import { KEY_NAMES } from "../../core/term/keys";
import { termPaths, type TermPaths } from "../../core/term/paths";
import type { TermRequestBody } from "../../core/term/protocol";
import { waitForMatch } from "../../core/term/wait";
import { renderSuccess } from "../../core/output/render";
import { renderTable } from "../../core/output/table";
import { CLI_VERSION } from "../../core/version";
import type { CliIO } from "./ainectoCli";

/** 도움말 — 전역 도움말이 이 줄들을 싣는다. */
export const TERM_HELP_LINES: readonly string[] = [
  "  ainecto term new <name> [--cwd DIR] [-- command args…]   start a session (default: your login shell); AINECTO_TERM_SESSION=<name> inside",
  "  ainecto term ls [--json]                                  list sessions",
  "  ainecto term send <name> [--paste] [--] <text>            type text (no Enter; --paste wraps it as a bracketed paste when the app asked for it)",
  `  ainecto term key <name> <key>                             press one key: ${KEY_NAMES.join(", ")}`,
  "  ainecto term read <name> [--lines N] [--scrollback] [--json]   the screen as text",
  "  ainecto term wait <name> --match REGEX [--timeout SECONDS] [--lines N] [--scrollback]   until a screen line matches",
  `  ainecto term attach <name>                                watch and type in your terminal; detach with ${DETACH_HINT}`,
  "  ainecto term kill <name> · ainecto term kill-server",
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
      const [name, ...words] = args.positionals;
      const text = [...words, ...args.afterDashes].join(" ");
      if (!name || text.length === 0) {
        throw usage("term send <name> [--paste] [--] <text>");
      }
      const data = await onSession(paths, name, { op: "send", name, text, paste: args.flags.paste === true });
      return print(input, data, `Sent ${text.length} characters to ${name}.`);
    }
    case "key": {
      const { positionals } = parseArgs(rest, {});
      const [name, key] = positionals;
      if (!name || !key || positionals.length > 2) {
        throw usage(`term key <name> <key>   (${KEY_NAMES.join(", ")})`);
      }
      const data = await onSession(paths, name, { op: "key", name, key });
      return print(input, data, `Pressed ${key} in ${name}.`);
    }
    case "read": {
      const args = parseArgs(rest, { lines: "count", scrollback: "boolean" });
      const name = singleName(args.positionals, "term read <name> [--lines N] [--scrollback]");
      const data = await onSession(paths, name, { op: "read", name, scrollback: args.flags.scrollback === true, lines: countFlag(args.flags.lines) });
      return print(input, data, linesField(data).join("\n"));
    }
    case "wait":
      return await waitCommand(paths, rest, input);
    case "kill": {
      const name = singleName(parseArgs(rest, {}).positionals, "term kill <name>");
      const data = await onSession(paths, name, { op: "kill", name });
      return print(input, data, `Killed ${name}.`);
    }
    case "kill-server": {
      const result = await termRequest(paths, { op: "kill-server" }, { start: false });
      const data = result.daemon ? result.data : { killed: [] };
      return print(input, data, result.daemon ? "Stopped the term daemon and its sessions." : "No term daemon is running.");
    }
    case "attach":
      return await attach(paths, singleName(parseArgs(rest, {}).positionals, "term attach <name>"), input.io);
    case "daemon":
      return await daemonCommand(paths, rest);
    default:
      throw usage(`term new|ls|send|key|read|wait|attach|kill|kill-server — see ainecto --help`);
  }
}

async function newSession(paths: TermPaths, argv: string[], input: TermCommandInput): Promise<number> {
  const args = parseArgs(argv, { cwd: "string" });
  const name = singleName(args.positionals, "term new <name> [--cwd DIR] [-- command args…]");
  const tty = input.io.stdout.isTTY ? { cols: input.io.stdout.columns, rows: input.io.stdout.rows } : {};
  const result = await termRequest(paths, {
    op: "new",
    name,
    cwd: resolve(typeof args.flags.cwd === "string" ? args.flags.cwd : process.cwd()),
    command: args.afterDashes.length > 0 ? args.afterDashes : null,
    env: stringEnv(),
    ...tty,
  }, { start: true });
  const data = result.daemon ? result.data : undefined;
  return print(input, data, `Started ${name}. Attach with: ainecto term attach ${name}`);
}

async function listSessions(paths: TermPaths, argv: string[], input: TermCommandInput): Promise<number> {
  parseArgs(argv, {});
  const result = await termRequest(paths, { op: "ls" }, { start: false });
  const data = result.daemon ? result.data : { sessions: [] };
  const sessions = sessionsField(data);
  const human = sessions.length === 0
    ? "No term sessions."
    : renderTable(sessions.map((session) => ({
      name: session.name,
      pid: session.pid,
      clients: session.clients,
      size: `${session.cols}x${session.rows}`,
      cwd: session.cwd,
      command: session.command ? session.command.join(" ") : "(login shell)",
    })), { columns: ["name", "pid", "clients", "size", "cwd", "command"] }) ?? "";
  return print(input, data, human);
}

async function waitCommand(paths: TermPaths, argv: string[], input: TermCommandInput): Promise<number> {
  const args = parseArgs(argv, { match: "string", timeout: "count", lines: "count", scrollback: "boolean" });
  const name = singleName(args.positionals, "term wait <name> --match REGEX [--timeout SECONDS]");
  if (typeof args.flags.match !== "string") {
    throw usage("term wait <name> --match REGEX [--timeout SECONDS]");
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(args.flags.match);
  } catch (error) {
    throw new TermError("TERM_USAGE", `--match is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  const timeout = countFlag(args.flags.timeout);
  const result = await waitForMatch(
    paths,
    name,
    pattern,
    { scrollback: args.flags.scrollback === true, lines: countFlag(args.flags.lines) },
    timeout === undefined ? undefined : timeout * 1000,
  );
  return print(input, result, result.line);
}

/**
 * attach — 사용자 터미널을 raw 로 바꾸고 표준입력 → 세션, 세션 출력 → 표준출력(설계 2-5).
 * 처음에 화면을 지우고 직렬화 화면을 한 번 그린 뒤 원시 출력만 흘린다. 떼거나 세션이 끝나면 세션 앱이 켜 둔
 * 모드(마우스·alternate 화면 등)를 데몬이 알려 준 글자로 되돌린다.
 */
async function attach(paths: TermPaths, name: string, io: CliIO): Promise<number> {
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    throw new TermError("TERM_NOT_A_TTY", "term attach needs an interactive terminal. Use term read / term send from scripts.");
  }
  const client = await openTermClient(paths, { start: false });
  if (!client) {
    throw noSession(name);
  }
  const scanner = new DetachKeyScanner();
  let finished = false;
  let finish: (code: number, reset: string, note: string) => void = () => undefined;
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
      io.stdout.write(Buffer.from(reset, "base64"));
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
        (error: unknown) => finish(1, "", `detach failed: ${error instanceof Error ? error.message : String(error)}`),
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
  client.onClose(() => finish(1, "", "lost the connection to the term daemon"));
  try {
    await client.request({ op: "attach", name, cols: io.stdout.columns, rows: io.stdout.rows });
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

/** 내부 명령 — 클라이언트가 detached 로 띄운다. `--ready-fd` 로 준비 한 줄을 돌려준다. */
async function daemonCommand(paths: TermPaths, argv: string[]): Promise<number> {
  const args = parseArgs(argv, { "ready-fd": "count" });
  const readyFd = countFlag(args.flags["ready-fd"]);
  const ready = (readiness: DaemonReadiness): void => {
    if (readyFd === undefined) {
      process.stderr.write(`${readiness.status === "locked" ? "Another term daemon is already running." : readiness.status}\n`);
      return;
    }
    writeSync(readyFd, `${JSON.stringify(readiness)}\n`);
    closeSync(readyFd);
  };
  let code: number;
  try {
    code = await runDaemon({ paths, version: CLI_VERSION, ready });
  } catch (error) {
    ready({ status: "error", message: error instanceof Error ? error.message : String(error) });
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

function noSession(name: string): TermError {
  return new TermError("TERM_NO_SESSION", `No session named "${name}" (no term sessions are running).`);
}

function usage(text: string): TermError {
  return new TermError("TERM_USAGE", `Usage: ainecto ${text}`);
}

/** 세션이 받을 환경 — 명령을 친 셸의 환경(값이 문자열인 것만). */
function stringEnv(): Record<string, string> {
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

interface ListedSession {
  name: string;
  pid: number;
  clients: number;
  cols: number;
  rows: number;
  cwd: string;
  command: string[] | null;
}

function sessionsField(data: unknown): ListedSession[] {
  if (data && typeof data === "object" && "sessions" in data && Array.isArray(data.sessions)) {
    return data.sessions.filter(isListedSession);
  }
  return [];
}

function isListedSession(value: unknown): value is ListedSession {
  if (!value || typeof value !== "object") {
    return false;
  }
  const session = value as Record<string, unknown>;
  return typeof session.name === "string" && typeof session.pid === "number" && typeof session.cwd === "string";
}

function linesField(data: unknown): string[] {
  if (data && typeof data === "object" && "lines" in data && Array.isArray(data.lines)) {
    return data.lines.filter((line): line is string => typeof line === "string");
  }
  return [];
}

function resetField(data: unknown): string {
  return data && typeof data === "object" && "reset" in data && typeof data.reset === "string" ? data.reset : "";
}
