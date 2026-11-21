import { createHash } from "node:crypto";
import type { PairedBrowser } from "../pc/pcKeys";
import {
  channelTranscript,
  deriveChannelSecrets,
  E2eError,
  generateEphemeral,
  helloSignatureInput,
  importMessageKey,
  importSigningKey,
  MAX_MESSAGES_PER_KEY,
  NONCE_SEED_BYTES,
  openMessage,
  PUBLIC_KEY_BYTES,
  publicRawFromJwk,
  randomBytes,
  sealMessage,
  SIGNATURE_BYTES,
  signBytes,
  verifyBytes,
  type EcPrivateJwk,
  type ReceiveState,
} from "./e2e";

type CryptoKey = Awaited<ReturnType<typeof importMessageKey>>;

/**
 * PC 쪽 E2E 채널 장부 — 다리(remote.ts)가 hello·cmd 를 여기로 넘기고, 화면·답을 여기서 봉인한다. HTTP·데몬 I/O 0.
 * 정본: 설계 terminal-e2e §14(구현 계약) · §14-8(A1~A7) > §13 > §12 > §11.
 *
 * <pre>
 * hello    고정 핀(pc-keys.json)의 브라우저 키로 서명 검증 → 새 임시 키 eP·nP′ → welcome{eP, nP, sig = PC 키로 H 서명}
 *          핀 없음·서명 틀림·모양 틀림 = PAIRING_REQUIRED · 미확정 후보 PC·계정당 4(C-E8) 넘으면 HANDSHAKE_LIMIT · 같은 channelId 는 무시(교체 없음)
 * confirm  웹→PC 의 n=0 · 복호돼야만 채널 활성(§11-2) · 30초(C-E8) 지나 온 것은 HANDSHAKE_EXPIRED · 활성 8(C-E5) 넘으면 CHANNEL_LIMIT
 * cmd      n 이 정확히 직전 + 1 일 때만(결번·되감기 = CHANNEL_OUT_OF_ORDER) · 직전에 실행한 n 과 같은 암호문 재도착은 «확인만»(실행 없음)
 *          AAD = 선 위 kind·session·opId·projectUuid(A3) · 복호한 본문의 값과 다시 대조 — 어긋나거나 태그가 틀리면 DECRYPT_FAILED
 * 봉인     PC→웹(frame·answer) 번호는 채널마다 하나 — 봉인 «전에» 동기로 배정(같은 번호 두 번 없음) · 2^32(C-E4)에 닿으면 MESSAGE_LIMIT
 * 실행 확인  executedThrough = 이 연결에서 데몬 실행이 연속으로 확인된 마지막 웹→PC 번호(confirm 0 · 성공한 input·key·resize · 답한 CRUD — A6)
 * </pre>
 */

/** C-E8(Ryan 11-21 승인) — 미확정 handshake(confirm 을 아직 못 받은 hello)를 버리는 시간. */
export const HANDSHAKE_TTL_MS = 30_000;
/** C-E8(Ryan 11-21 승인) — PC·계정당 동시에 받는 미확정 handshake 수. */
export const HANDSHAKE_MAX = 4;
/** C-E5(Ryan 11-21 승인) — PC·계정당 활성 채널 수. 서버가 먼저 세고 PC 도 다시 센다(이중 거절). */
export const ACTIVE_CHANNEL_MAX = 8;

/** 채널 닫기 사유 — 바깥(서버)으로 나가는 것은 이 허용 목록뿐(A7). */
export const CLOSE_REASONS = [
  "PAIRING_REQUIRED", "CHANNEL_OUT_OF_ORDER", "DECRYPT_FAILED", "HANDSHAKE_EXPIRED", "HANDSHAKE_LIMIT",
  "CHANNEL_LIMIT", "MESSAGE_LIMIT", "SESSION_REPLACED", "COMMAND_FAILED", "REMOTE_OFF",
] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

/** CRUD 답의 바깥 코드 — 허용 목록(A7). 그 밖 데몬 코드는 모두 TERM_FAILED(자세한 사유는 봉인 답의 detail 에만). */
const ANSWER_CODES = ["TERM_NO_SESSION", "TERM_SESSION_EXISTS", "TERM_BAD_REQUEST", "SESSION_REPLACED", "REMOTE_OFF"] as const;
export type AnswerCode = (typeof ANSWER_CODES)[number] | "TERM_FAILED";

/** 데몬·다리 오류 코드 → 바깥 코드(순수). */
export function answerCodeOf(code: string): AnswerCode {
  return (ANSWER_CODES as readonly string[]).includes(code) ? code as AnswerCode : "TERM_FAILED";
}

export const COMMAND_KINDS = ["confirm", "input", "key", "resize", "create", "kill", "label"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/** poll 의 cmd 항목(A3) — 봉인 밖 평문 칸. kind·session·opId·projectUuid 는 AAD 칸이고, requestId 는 서버 상관 id(봉인 밖). */
export interface WireCommand {
  channelId: string;
  n: number;
  c: string;
  kind: CommandKind;
  session?: string;
  opId?: string;
  projectUuid?: string;
  requestId?: string;
}

/** 복호·대조를 마친 웹→PC 명령(§14-3 봉인 본문). 실행 값은 여기서만 읽는다(§12-2). */
export type ChannelCommand =
  | { kind: "confirm" }
  | { kind: "input"; session: string; instance: string; bytes: Buffer }
  | { kind: "key"; session: string; instance: string; key: string }
  | { kind: "resize"; session: string; instance: string; cols: number; rows: number }
  | { kind: "create"; opId: string; name: string; projectUuid?: string; cwd?: string; command?: string }
  | { kind: "kill"; opId: string; session: string; instance: string }
  | { kind: "label"; opId: string; session: string; instance: string; label: string };

/** hello 를 검증할 신뢰 — 다리가 hello 마다 pc-keys.json 에서 다시 읽는다(§6). */
export interface HelloTrust {
  /** 대화 기록의 userId(소문자 UUID — e2e.transcriptUserId). */
  userId: string;
  pcKey: EcPrivateJwk;
  browsers: readonly PairedBrowser[];
}

/** 채널의 브라우저 — 로그·알림용(이름은 짝짓기 때 PC 가 저장한 것). */
export interface ChannelBrowser {
  keyId: string;
  name: string;
}

export type HelloOutcome =
  | { type: "welcome"; welcome: { eP: string; nP: string; sig: string }; browser: ChannelBrowser }
  | { type: "refuse" }
  | { type: "close"; reason: CloseReason }
  /** 이미 아는 channelId — 기존 채널을 바꾸지 않는다(§11-2). */
  | { type: "ignored" };

export type ReceiveOutcome =
  | { type: "confirmed"; browser: ChannelBrowser }
  | { type: "command"; command: Exclude<ChannelCommand, { kind: "confirm" }>; browser: ChannelBrowser }
  /** 직전에 실행한 번호 + 같은 암호문 — 확인만(실행하지 않는다, §12-1·§13-3). */
  | { type: "duplicate" }
  /** 채널을 닫는다 — 장부에서는 이미 지웠다. 다리가 서버에 알린다. */
  | { type: "close"; reason: CloseReason }
  /** 모르는 채널(이미 닫음·만료 뒤 정리됨) — 실행하지 않는다. */
  | { type: "unknown" };

/** 봉인 실패 — 그 채널을 이 사유로 닫는다. */
export class ChannelSealError extends Error {
  constructor(readonly reason: CloseReason | "CHANNEL_GONE", message: string) {
    super(message);
  }
}

interface ChannelState {
  channelId: string;
  browser: ChannelBrowser;
  connId: Uint8Array;
  b2p: CryptoKey;
  p2b: CryptoKey;
  receive: ReceiveState;
  /** PC→웹 다음 번호. */
  sendNext: number;
  active: boolean;
  /** 미확정일 때만 — 이 시각(ms)이 지나면 버린다. */
  expiresAt: number;
  /** 연속 실행 확인 지점 — 활성 전에는 -1. */
  executedThrough: number;
  /** 마지막으로 받아들인 웹→PC 번호와 그 암호문의 SHA-256 — 같은 번호·같은 암호문 재도착 판정. */
  last: { n: number; digest: string } | undefined;
}

export class ChannelBook {
  private readonly channels = new Map<string, ChannelState>();

  constructor(
    private readonly pcId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 장부에 있나(미확정 포함). */
  has(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  isActive(channelId: string): boolean {
    return this.channels.get(channelId)?.active === true;
  }

  activeIds(): string[] {
    return [...this.channels.values()].filter((channel) => channel.active).map((channel) => channel.channelId);
  }

  browserOf(channelId: string): ChannelBrowser | undefined {
    return this.channels.get(channelId)?.browser;
  }

  /** 활성 채널의 연속 실행 확인 지점 — 없으면 undefined. */
  executedThrough(channelId: string): number | undefined {
    const channel = this.channels.get(channelId);
    return channel?.active ? channel.executedThrough : undefined;
  }

  /** 웹→PC n 번 실행이 확인됐다 — 연속일 때만 오른다(건너뛰지 않는다, §14-6 1). 올랐으면 true. */
  executed(channelId: string, n: number): boolean {
    const channel = this.channels.get(channelId);
    if (!channel?.active || n !== channel.executedThrough + 1) return false;
    channel.executedThrough = n;
    return true;
  }

  /** 채널을 장부에서 지운다(닫힘·웹 닫음·키 폐기). 있었으면 true. */
  drop(channelId: string): boolean {
    return this.channels.delete(channelId);
  }

  /** 모두 지운다(원격 끔·링크 다시 열기) — 지운 id 들. */
  dropAll(): string[] {
    const ids = [...this.channels.keys()];
    this.channels.clear();
    return ids;
  }

  /** 기한(C-E8)이 지난 미확정 handshake 를 지운다 — 지운 id 들(다리가 HANDSHAKE_EXPIRED 로 닫는다). */
  expired(): string[] {
    const now = this.now();
    const ids = [...this.channels.values()].filter((channel) => !channel.active && now >= channel.expiresAt).map((channel) => channel.channelId);
    for (const id of ids) this.channels.delete(id);
    return ids;
  }

  /** hello 하나(§11-2·§13-4·A4). 신뢰가 없으면(짝짓지 않음·계정 모름) PAIRING_REQUIRED. */
  async hello(channelId: string, raw: unknown, trust: HelloTrust | undefined): Promise<HelloOutcome> {
    if (this.channels.has(channelId)) return { type: "ignored" };
    const hello = wireHello(raw);
    if (!trust || !hello) return { type: "refuse" };
    const browser = trust.browsers.find((item) => item.keyId === hello.browserKeyId);
    if (!browser) return { type: "refuse" };
    const fields = { userId: trust.userId, pcId: this.pcId, channel: hello.channel, browserKeyId: hello.browserKeyId, eB: hello.eB, nB: hello.nB };
    if (!(await verifyBytes(browser.publicJwk, hello.sig, helloSignatureInput(fields)))) return { type: "refuse" };
    // ★서명이 고정 핀으로 검증된 후보만 센다(§13-4).
    const now = this.now();
    const pending = [...this.channels.values()].filter((channel) => !channel.active && now < channel.expiresAt).length;
    if (pending >= HANDSHAKE_MAX) return { type: "close", reason: "HANDSHAKE_LIMIT" };
    const ephemeral = await generateEphemeral();
    const nP = randomBytes(NONCE_SEED_BYTES);
    const transcript = await channelTranscript({
      hello: fields,
      pcPublicRaw: publicRawFromJwk(trust.pcKey),
      browserPublicRaw: publicRawFromJwk(browser.publicJwk),
      eP: ephemeral.publicRaw,
      nP,
    });
    let secrets: Awaited<ReturnType<typeof deriveChannelSecrets>>;
    try {
      secrets = await deriveChannelSecrets({ own: ephemeral.privateKey, peerPublicRaw: hello.eB, transcript });
    } catch (error) {
      if (error instanceof E2eError) return { type: "refuse" };   // eB 가 곡선 위 점이 아님
      throw error;
    }
    const sig = await signBytes(await importSigningKey(trust.pcKey), transcript);
    const channelBrowser = { keyId: browser.keyId, name: browser.name };
    this.channels.set(channelId, {
      channelId,
      browser: channelBrowser,
      connId: secrets.connId,
      b2p: await importMessageKey(secrets.browserToPc),
      p2b: await importMessageKey(secrets.pcToBrowser),
      receive: { order: "exact", next: 0 },
      sendNext: 0,
      active: false,
      expiresAt: now + HANDSHAKE_TTL_MS,
      executedThrough: -1,
      last: undefined,
    });
    return { type: "welcome", welcome: { eP: b64u(ephemeral.publicRaw), nP: b64u(nP), sig: b64u(sig) }, browser: channelBrowser };
  }

  /** 웹→PC 명령 하나(§14-3). 닫는 결과면 장부에서 이미 지웠다. */
  async receive(wire: WireCommand): Promise<ReceiveOutcome> {
    const channel = this.channels.get(wire.channelId);
    if (!channel) return { type: "unknown" };
    const close = (reason: CloseReason): ReceiveOutcome => {
      this.channels.delete(wire.channelId);
      return { type: "close", reason };
    };
    if (!channel.active && this.now() >= channel.expiresAt) return close("HANDSHAKE_EXPIRED");
    const digest = createHash("sha256").update(wire.c, "utf8").digest("hex");
    if (channel.last && wire.n === channel.last.n && digest === channel.last.digest) return { type: "duplicate" };
    if (wire.n >= MAX_MESSAGES_PER_KEY) return close("MESSAGE_LIMIT");
    if (wire.n !== channel.receive.next) return close("CHANNEL_OUT_OF_ORDER");
    // n=0 은 confirm 이고 confirm 은 n=0 뿐이다.
    if ((wire.kind === "confirm") !== (wire.n === 0)) return close("CHANNEL_OUT_OF_ORDER");
    const ciphertext = fromB64u(wire.c);
    if (!ciphertext) return close("DECRYPT_FAILED");
    let opened: { plaintext: Uint8Array; state: ReceiveState };
    try {
      opened = await openMessage(channel.b2p, {
        type: wire.kind,
        connId: channel.connId,
        pcId: this.pcId,
        session: wire.session ?? "",
        operationId: wire.opId ?? "",
        projectUuid: wire.projectUuid ?? "",
        counter: wire.n,
      }, ciphertext, channel.receive);
    } catch {
      return close("DECRYPT_FAILED");
    }
    const command = sealedCommand(wire, opened.plaintext);
    if (!command) return close("DECRYPT_FAILED");
    channel.receive = opened.state;
    channel.last = { n: wire.n, digest };
    if (command.kind !== "confirm") return { type: "command", command, browser: channel.browser };
    if (this.activeIds().length >= ACTIVE_CHANNEL_MAX) return close("CHANNEL_LIMIT");
    channel.active = true;
    channel.executedThrough = 0;
    return { type: "confirmed", browser: channel.browser };
  }

  /**
   * PC→웹 봉인(frame·answer — A3 AAD). 번호는 await 전에 배정한다. 활성 채널이 아니면 CHANNEL_GONE, 번호가 다 됐으면 MESSAGE_LIMIT.
   * c = base64url(AES-GCM 암호문 ‖ 태그).
   */
  async seal(channelId: string, header: { kind: "frame" | "answer"; session: string; opId?: string; projectUuid?: string },
    body: Record<string, unknown>): Promise<{ n: number; c: string }> {
    const channel = this.channels.get(channelId);
    if (!channel?.active) throw new ChannelSealError("CHANNEL_GONE", `channel ${channelId} is not open`);
    const n = channel.sendNext;
    if (n >= MAX_MESSAGES_PER_KEY) throw new ChannelSealError("MESSAGE_LIMIT", `channel ${channelId} used up its message numbers`);
    channel.sendNext = n + 1;
    const sealed = await sealMessage(channel.p2b, {
      type: header.kind,
      connId: channel.connId,
      pcId: this.pcId,
      session: header.session,
      operationId: header.opId ?? "",
      projectUuid: header.projectUuid ?? "",
      counter: n,
    }, new TextEncoder().encode(JSON.stringify(body)));
    return { n, c: b64u(sealed) };
  }
}

// ── 선 위 모양(순수) ─────────────────────────────────────────────

/** hello(A4) `{channel, eB, nB, browserKeyId, sig}` — 길이까지 맞아야 한다. 아니면 undefined. */
function wireHello(raw: unknown): { channel: string; eB: Uint8Array; nB: Uint8Array; browserKeyId: string; sig: Uint8Array } | undefined {
  const value = record(raw);
  const channel = text(value?.channel);
  const browserKeyId = text(value?.browserKeyId);
  const eB = fromB64u(value?.eB, PUBLIC_KEY_BYTES);
  const nB = fromB64u(value?.nB, NONCE_SEED_BYTES);
  const sig = fromB64u(value?.sig, SIGNATURE_BYTES);
  return channel && browserKeyId && eB && nB && sig ? { channel, eB, nB, browserKeyId, sig } : undefined;
}

/** poll 의 cmd 항목 → {@link WireCommand}(순수). 모양이 틀리면 undefined. */
export function wireCommand(raw: unknown): WireCommand | undefined {
  const value = record(raw);
  const channelId = text(value?.channelId);
  const n = value?.n;
  const c = text(value?.c);
  const kind = value?.kind;
  if (!value || !channelId || typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || !c
    || typeof kind !== "string" || !(COMMAND_KINDS as readonly string[]).includes(kind)) {
    return undefined;
  }
  const optional = (key: "session" | "opId" | "projectUuid" | "requestId"): Record<string, string> => {
    const item = text(value[key]);
    return item ? { [key]: item } : {};
  };
  return { channelId, n, c, kind: kind as CommandKind, ...optional("session"), ...optional("opId"), ...optional("projectUuid"),
    ...optional("requestId") };
}

/**
 * 복호한 본문 → 명령(순수). ★선 위 AAD 칸(session·opId·projectUuid)이 본문의 값과 같아야 한다(§11-2 · A3) — 다르면 undefined.
 * 종류는 AAD 로 인증되므로 본문에 다시 싣지 않는다. 본문의 다른 칸은 무시한다.
 */
export function sealedCommand(wire: WireCommand, plaintext: Uint8Array): ChannelCommand | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    return undefined;
  }
  const body = record(parsed);
  if (!body) return undefined;
  const session = text(body.session);
  const instance = text(body.instance);
  const opId = text(body.opId);
  /** 세션을 겨누는 명령 — 바깥 session 이 본문과 같고, 바깥 opId·projectUuid 는 본문과 같다(없으면 없음). */
  const targets = (withOp: boolean): boolean => session !== undefined && instance !== undefined && wire.session === session
    && wire.opId === (withOp ? opId : undefined) && (!withOp || opId !== undefined) && wire.projectUuid === undefined;
  switch (wire.kind) {
    case "confirm":
      return wire.session === undefined && wire.opId === undefined && wire.projectUuid === undefined ? { kind: "confirm" } : undefined;
    case "input": {
      const d = body.d;
      return targets(false) && typeof d === "string" && /^[A-Za-z0-9+/_-]*={0,2}$/.test(d)
        ? { kind: "input", session: session!, instance: instance!, bytes: Buffer.from(d, "base64") }
        : undefined;
    }
    case "key": {
      const key = text(body.key);
      return targets(false) && key ? { kind: "key", session: session!, instance: instance!, key } : undefined;
    }
    case "resize": {
      const { cols, rows } = body;
      return targets(false) && isSize(cols) && isSize(rows) ? { kind: "resize", session: session!, instance: instance!, cols, rows } : undefined;
    }
    case "create": {
      const name = text(body.name);
      const projectUuid = text(body.projectUuid);
      const cwd = text(body.cwd);
      const command = body.command;
      if (!name || !opId || wire.session !== name || wire.opId !== opId || wire.projectUuid !== projectUuid) return undefined;
      if (command !== undefined && typeof command !== "string") return undefined;
      return { kind: "create", opId, name, ...(projectUuid ? { projectUuid } : {}), ...(cwd ? { cwd } : {}),
        ...(typeof command === "string" ? { command } : {}) };
    }
    case "kill":
      return targets(true) ? { kind: "kill", opId: opId!, session: session!, instance: instance! } : undefined;
    case "label": {
      const label = text(body.label);
      return targets(true) && label ? { kind: "label", opId: opId!, session: session!, instance: instance!, label } : undefined;
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** base64url(패딩 없음)만 — 길이를 주면 그 길이일 때만. 아니면 undefined. */
function fromB64u(value: unknown, length?: number): Uint8Array | undefined {
  if (typeof value !== "string" || value === "" || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const bytes = new Uint8Array(Buffer.from(value, "base64url"));
  return length === undefined || bytes.length === length ? bytes : undefined;
}
