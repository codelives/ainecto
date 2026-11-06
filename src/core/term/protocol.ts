import { TermError } from "./errors";

/**
 * 제어 소켓 프로토콜 — ★한 곳(설계 2-3·2-4). 양방향 모두 «JSON 한 줄»이다.
 *   요청: 요청 id 가 달린 한 줄 → 같은 id 응답 한 줄(실패해도 응답은 반드시).
 *   attach·watch 뒤에는 같은 연결에 이벤트 줄(event)이 흐르고, attach 입력은 id 없는 흐름 줄(op in·resize)이다.
 * attach 의 출력·입력 바이트는 base64 로 싣는다 — 바이트 흐름과 제어 줄을 한 가지 틀로(두 방식 금지).
 */

/** 요청 본문 — id 는 클라이언트가 붙인다. */
export type TermRequestBody =
  | { op: "new"; name: string; cwd: string; command: string[] | null; env: Record<string, string>; cols?: number; rows?: number }
  | { op: "ls" }
  | { op: "send"; name: string; text: string; paste: boolean }
  | { op: "key"; name: string; key: string }
  | { op: "read"; name: string; scrollback: boolean; lines?: number }
  | { op: "kill"; name: string }
  | { op: "kill-server" }
  | { op: "restore"; env: Record<string, string> }
  | { op: "attach"; name: string; cols: number; rows: number }
  | { op: "detach" }
  | { op: "watch"; name: string };

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
      };
    case "ls":
    case "kill-server":
    case "detach":
      return { id, op };
    case "send":
      return { id, op, name: stringField(record, "name"), text: stringField(record, "text"), paste: record.paste === true };
    case "key":
      return { id, op, name: stringField(record, "name"), key: stringField(record, "key") };
    case "read":
      return { id, op, name: stringField(record, "name"), scrollback: record.scrollback === true, lines: optionalSize(record, "lines") };
    case "kill":
    case "watch":
      return { id, op, name: stringField(record, "name") };
    case "restore":
      return { id, op, env: stringMapField(record, "env") };
    case "attach":
      return { id, op, name: stringField(record, "name"), cols: sizeField(record, "cols"), rows: sizeField(record, "rows") };
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

function optionalSize(record: Record<string, unknown>, key: string): number | undefined {
  return record[key] === undefined ? undefined : sizeField(record, key);
}
