import { TermError } from "./errors";
import { isUuid } from "./paths";

/**
 * 제어 소켓 프로토콜 — ★한 곳(설계 2-3·2-4). 양방향 모두 «JSON 한 줄»이다.
 *   요청: 요청 id 가 달린 한 줄 → 같은 id 응답 한 줄(실패해도 응답은 반드시).
 *   attach·watch 뒤에는 같은 연결에 이벤트 줄(event)이 흐르고, attach 입력은 id 없는 흐름 줄(op in·resize)이다.
 * attach 의 출력·입력 바이트는 base64 로 싣는다 — 바이트 흐름과 제어 줄을 한 가지 틀로(두 방식 금지).
 */

/**
 * 요청 본문 — id 는 클라이언트가 붙인다.
 * instance(있으면) = 그 이름의 «지금» 세션 인스턴스와 같을 때만 적용한다 — 다르면 SESSION_REPLACED(설계 terminal-e2e §14-6 4).
 * 원격 다리는 웹 명령마다 봉인 본문의 인스턴스를 싣는다. 로컬 `term` 명령은 싣지 않는다(이름만).
 */
export type TermRequestBody =
  /** project = 프로젝트 꼬리표(KAN-1238, {@link isUuid}) — 세션 수명 동안 그대로, 매니페스트·ls 에 남는다. 옛 데몬은 버린다. */
  | { op: "new"; name: string; cwd: string; command: string[] | null; env: Record<string, string>; cols?: number; rows?: number;
      project?: string; input?: "none" }
  | { op: "ls" }
  | { op: "send"; name: string; text: string; paste: boolean; instance?: string }
  | { op: "key"; name: string; key: string; instance?: string }
  | { op: "read"; name: string; scrollback: boolean; lines?: number }
  | { op: "kill"; name: string; instance?: string }
  | { op: "kill-server" }
  | { op: "restore"; env: Record<string, string> }
  | { op: "attach"; name: string; cols: number; rows: number }
  | { op: "detach" }
  | { op: "watch"; name: string }
  /**
   * 붙지 않은 쪽(원격 웹 패널 — 원격 다리)이 세션 크기를 정한다. ★attach 흐름의 `resize`(id 없는 줄)와 이름을 나눈다 — 옛 데몬은
   * id 붙은 `resize` 를 흐름 줄로 읽어 답하지 않는다(10초 뒤 연결이 끊김). 모르는 op 면 옛 데몬이 연결을 바로 끊어 빨리 안다.
   */
  | { op: "set-size"; name: string; cols: number; rows: number; instance?: string }
  /** 보이는 이름 — 데몬 이름(세션 열쇠·AINECTO_TERM_SESSION)은 그대로(KAN-738 결재 «가»). 매니페스트에 남아 restore 가 되살린다. */
  | { op: "label"; name: string; label: string; instance?: string }
  /** 이 연결에 세션 목록 변화(생김·끝·label)를 {@code sessions} 이벤트로 알린다 — 원격 다리가 목록을 올릴 때를 안다. */
  | { op: "watch-sessions" }
  /** Windows 만 — 데몬 증명. 답은 `{proof}`(ipc.ts helloProof). 클라이언트는 이 답을 확인하기 전에 다른 요청을 보내지 않는다. */
  | { op: "hello"; nonce: string };

export type TermRequest = TermRequestBody & { id: string };

/** attach 중 id 없이 흐르는 입력 — 응답이 없고 로그에 내용이 남지 않는다. */
export type TermStreamInput =
  | { op: "in"; d: string }
  | { op: "resize"; cols: number; rows: number };

export type TermClientMessage = TermRequest | TermStreamInput;

export interface TermErrorBody {
  code: string;
  message: string;
}

export type TermResponse =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: TermErrorBody };

export type TermEvent =
  /** attach 첫 화면 — 직렬화한 VT 글자(base64). 이 뒤의 out 은 이 화면 «다음» 출력이다. */
  | { event: "screen"; d: string }
  | { event: "out"; d: string }
  /** watch — 화면이 바뀌었다(다음 read 전까지 한 번만 온다). */
  | { event: "changed" }
  /** watch-sessions — 세션 목록이 바뀌었다(생김·끝·label). 무엇이 바뀌었는지는 ls 로 본다. */
  | { event: "sessions" }
  /** 세션이 끝났다. reset = 사용자 터미널에 남은 모드를 되돌리는 글자(base64). */
  | { event: "exit"; exitCode: number; signal: number; reset: string };

/** 데몬이 끝나는 중이라 받지 않은 요청의 오류 코드 — 클라이언트는 다음 데몬으로 다시 보낸다(설계 2-1). */
export const RETRY_CODE = "TERM_DAEMON_RETRY";

export function encodeLine(message: TermClientMessage | TermResponse | TermEvent): string {
  return `${JSON.stringify(message)}\n`;
}

/** 덩어리로 들어오는 바이트를 줄로 자른다. ★`\n`(0x0a)은 UTF-8 여러 바이트 글자 안에 나오지 않아 바이트로 잘라도 안전하다. */
export class LineDecoder {
  private pending: Buffer[] = [];

  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let rest = chunk;
    let newline = rest.indexOf(0x0a);
    while (newline !== -1) {
      this.pending.push(rest.subarray(0, newline));
      lines.push(Buffer.concat(this.pending).toString("utf8"));
      this.pending = [];
      rest = rest.subarray(newline + 1);
      newline = rest.indexOf(0x0a);
    }
    if (rest.length > 0) {
      this.pending.push(rest);
    }
    return lines;
  }
}

export class TermProtocolError extends TermError {
  constructor(message: string) {
    super("TERM_BAD_REQUEST", message);
  }
}

/** 데몬이 받은 한 줄을 검사한다 — 같은 OS 사용자만 붙지만 모양은 믿지 않는다. */
export function parseClientMessage(line: string): TermClientMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new TermProtocolError("Not a JSON line.");
  }
  const record = asRecord(value);
  const op = stringField(record, "op");
  if (op === "in") {
    return { op, d: stringField(record, "d") };
  }
  if (op === "resize") {
    return { op, cols: sizeField(record, "cols"), rows: sizeField(record, "rows") };
  }
  const id = stringField(record, "id");
  switch (op) {
    case "new":
      return {
        id,
        op,
        name: stringField(record, "name"),
        cwd: stringField(record, "cwd"),
        command: record.command === null ? null : stringArrayField(record, "command"),
        env: stringMapField(record, "env"),
        cols: optionalSize(record, "cols"),
        rows: optionalSize(record, "rows"),
        ...(record.project === undefined ? {} : { project: projectField(record, "project") }),
        ...(record.input === undefined ? {} : { input: noInputField(record, "input") }),
      };
    case "ls":
    case "kill-server":
    case "detach":
    case "watch-sessions":
      return { id, op };
    case "label": {
      const label = stringField(record, "label");
      if (label.length === 0) {
        throw new TermProtocolError(`"label" must not be empty.`);
      }
      return { id, op, name: stringField(record, "name"), label, ...optionalInstance(record) };
    }
    case "send":
      return { id, op, name: stringField(record, "name"), text: stringField(record, "text"), paste: record.paste === true, ...optionalInstance(record) };
    case "key":
      return { id, op, name: stringField(record, "name"), key: stringField(record, "key"), ...optionalInstance(record) };
    case "read":
      return { id, op, name: stringField(record, "name"), scrollback: record.scrollback === true, lines: optionalSize(record, "lines") };
    case "kill":
      return { id, op, name: stringField(record, "name"), ...optionalInstance(record) };
    case "watch":
      return { id, op, name: stringField(record, "name") };
    case "restore":
      return { id, op, env: stringMapField(record, "env") };
    case "hello":
      return { id, op, nonce: stringField(record, "nonce") };
    case "attach":
      return { id, op, name: stringField(record, "name"), cols: sizeField(record, "cols"), rows: sizeField(record, "rows") };
    case "set-size":
      return { id, op, name: stringField(record, "name"), cols: sizeField(record, "cols"), rows: sizeField(record, "rows"), ...optionalInstance(record) };
    default:
      throw new TermProtocolError(`Unknown op "${op}".`);
  }
}

/** 클라이언트가 받은 한 줄 — 응답이거나 이벤트. */
export function parseDaemonMessage(line: string): TermResponse | TermEvent {
  const record = asRecord(JSON.parse(line));
  if (typeof record.event === "string") {
    switch (record.event) {
      case "screen":
      case "out":
        return { event: record.event, d: stringField(record, "d") };
      case "changed":
        return { event: "changed" };
      case "sessions":
        return { event: "sessions" };
      case "exit":
        return {
          event: "exit",
          exitCode: typeof record.exitCode === "number" ? record.exitCode : 0,
          signal: typeof record.signal === "number" ? record.signal : 0,
          reset: stringField(record, "reset"),
        };
      default:
        throw new TermProtocolError(`Unknown event "${record.event}".`);
    }
  }
  const id = stringField(record, "id");
  if (record.ok === true) {
    return { id, ok: true, data: record.data };
  }
  const error = asRecord(record.error);
  return { id, ok: false, error: { code: stringField(error, "code"), message: stringField(error, "message") } };
}

/** `ls` 응답의 세션 한 줄(SessionInfo 의 선 위 모양). */
export interface ListedSession {
  name: string;
  pid: number;
  clients: number;
  cols: number;
  rows: number;
  cwd: string;
  command: string[] | null;
  /** 보이는 이름 — 없으면 칸 없음. */
  label?: string;
  /** 프로젝트 꼬리표 — 꼬리표 없이 만들었거나 옛 데몬이면 칸 없음. */
  project?: string;
  /** 마지막 출력 시각(ISO) — 아직 출력이 없거나 옛 데몬이면 칸 없음. */
  lastOutputAt?: string;
  /** 세션 인스턴스 id(무작위) — 옛 데몬이면 칸 없음. */
  instance?: string;
}

/** `ls` 응답 → 세션 목록 — 모양이 맞지 않는 줄은 뺀다. */
export function listedSessions(data: unknown): ListedSession[] {
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
  return typeof session.name === "string" && typeof session.pid === "number" && typeof session.cwd === "string"
    && typeof session.cols === "number" && typeof session.rows === "number";
}

/** `set-size` 응답 → 적용된 크기. 모양이 틀리면 undefined. */
export function appliedSize(data: unknown): { cols: number; rows: number } | undefined {
  if (data && typeof data === "object" && "cols" in data && "rows" in data
    && typeof data.cols === "number" && typeof data.rows === "number") {
    return { cols: data.cols, rows: data.rows };
  }
  return undefined;
}

/** `read` 응답의 화면 모드 — 옛 데몬이면 칸이 없어 undefined. */
export function readModes(data: unknown): { altScreen: boolean; appCursor: boolean; bracketedPaste: boolean } | undefined {
  if (!data || typeof data !== "object" || !("modes" in data)) return undefined;
  const modes = data.modes;
  if (!modes || typeof modes !== "object") return undefined;
  const altScreen = "altScreen" in modes ? modes.altScreen : undefined;
  const appCursor = "appCursor" in modes ? modes.appCursor : undefined;
  const bracketedPaste = "bracketedPaste" in modes ? modes.bracketedPaste : undefined;
  return typeof altScreen === "boolean" && typeof appCursor === "boolean" && typeof bracketedPaste === "boolean"
    ? { altScreen, appCursor, bracketedPaste }
    : undefined;
}

/** `read`·`new` 응답의 세션 인스턴스 id — 옛 데몬이면 칸이 없어 undefined. */
export function sessionInstance(data: unknown): string | undefined {
  return data && typeof data === "object" && "instance" in data && typeof data.instance === "string" && data.instance !== ""
    ? data.instance
    : undefined;
}

/** `read` 응답 → 화면 줄. 줄이 없으면 데몬이 계약을 어긴 것이다. */
export function readLines(data: unknown): string[] {
  if (data && typeof data === "object" && "lines" in data && Array.isArray(data.lines)) {
    return data.lines.filter((line): line is string => typeof line === "string");
  }
  throw new TermError("TERM_BAD_RESPONSE", "The term daemon answered read without lines.");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TermProtocolError("Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new TermProtocolError(`"${key}" must be a string.`);
  }
  return value;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((item): item is string => typeof item === "string")) {
    throw new TermProtocolError(`"${key}" must be a non-empty string array.`);
  }
  return value;
}

function stringMapField(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = asRecord(record[key]);
  const output: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === "string") {
      output[name] = item;
    }
  }
  return output;
}

function sizeField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TermProtocolError(`"${key}" must be a positive integer.`);
  }
  return value;
}

function projectField(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key);
  if (!isUuid(value)) {
    throw new TermProtocolError(`"${key}" must be a lowercase UUID.`);
  }
  return value;
}

/** 입력 없음 표지 — "none" 만 싣는다(없으면 입력을 받는다, launch.ts LaunchInput). */
function noInputField(record: Record<string, unknown>, key: string): "none" {
  if (record[key] !== "none") {
    throw new TermProtocolError(`"${key}" must be "none" when present.`);
  }
  return "none";
}

/** 인스턴스 칸 — 없으면 칸 없음(이름만), 있으면 빈 글이 아닌 문자열. */
function optionalInstance(record: Record<string, unknown>): { instance?: string } {
  if (record.instance === undefined) return {};
  const instance = stringField(record, "instance");
  if (instance === "") {
    throw new TermProtocolError(`"instance" must not be empty.`);
  }
  return { instance };
}

function optionalSize(record: Record<string, unknown>, key: string): number | undefined {
  return record[key] === undefined ? undefined : sizeField(record, key);
}
