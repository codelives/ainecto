import type { TokenProvider } from "../auth/oauth";
import { createPcHttp, type PcHttp } from "../http/pcHttp";
import type { DaemonLog } from "../term/daemonLog";
import { NONCE_SEED_BYTES, PUBLIC_KEY_BYTES } from "../term/e2e";
import type { RemoteLogRecord } from "../term/remote";
import { CALL_TIMEOUT_MS } from "../term/remoteLimits";
import type { BrowserOffer, PairTransport } from "./pcPairing";

/**
 * 짝짓기 서버 중계(설계 terminal-e2e §14-1 · A5) — PC 쪽 `/mcp/term/pc/pair/{open,send,poll}`. 서버는 메시지를 모른다(크기 상한만).
 *   open {pcId}             → {attemptId} — (사용자, pcId)당 하나 · 새 open 은 앞 시도를 끝낸다
 *   send {attemptId, msg}   → 202 — msg = commit{commit} · reveal{publicKey, nP} · done{signature} · abort{reason}
 *   poll {attemptId}        → 붙잡기 → {msgs:[…]} · 끝났으면 {closed:true} — 브라우저 쪽 msg 는 offer{publicKey, keyId, nB, name} · abort{reason}
 * 바이너리는 모두 base64url(패딩 없음). 서버 호출은 공용 입구(pcHttp) — 요청 1줄 + 응답 1줄(remote.log, op = pair/…). 메시지 내용은 남기지 않는다.
 * ★시도는 한 번(§11-1): 브라우저 제안이 둘 오거나 모르는 메시지가 오면 그 시도를 끝낸다(PAIR_DUPLICATE·PAIR_BAD_MESSAGE).
 */

type PairOp = "pair/open" | "pair/send" | "pair/poll";

/** 중계가 시도를 끝냈다 — code 는 `ainecto pair` 가 그대로 오류 코드로 쓴다. */
export class PairRelayError extends Error {
  constructor(
    readonly code: "PAIR_CLOSED" | "PAIR_DUPLICATE" | "PAIR_BAD_MESSAGE" | "PAIR_RELAY_BAD_RESPONSE",
    message: string,
  ) {
    super(message);
  }
}

export function createPairRelay(input: {
  endpoint: string;
  tokenProvider: TokenProvider;
  log: DaemonLog<RemoteLogRecord>;
  pcId: string;
  /** poll 을 붙잡는 시간의 위쪽 끝 — 짝짓기 기한(C-E1)을 넘지 않는다. 기한·중단은 각 호출의 signal 이 끊는다. */
  holdMs: number;
  fetchImpl?: typeof fetch;
}): PairTransport {
  const http: PcHttp<PairOp> = createPcHttp<PairOp, RemoteLogRecord>({
    endpoint: input.endpoint,
    path: "term/pc",
    tokenProvider: input.tokenProvider,
    timeoutMs: CALL_TIMEOUT_MS,
    sessionHeader: "X-Remote-Token",
    fetchImpl: input.fetchImpl,
    logging: {
      log: input.log,
      request: ({ callId, op, bytes }) => ({ event: "remote_call", callId, op, bytes }),
      response: ({ callId, op, ms }, outcome) => ({
        event: "remote_call_response",
        callId,
        op,
        ...(outcome.ok ? { ok: true, status: outcome.status, ...(Array.isArray(outcome.body.msgs) ? { commands: outcome.body.msgs.length } : {}),
          ...(outcome.body.closed === true ? { state: "CLOSED" } : {}) } : outcome),
        ms,
      }),
    },
  });
  let attemptId: string | undefined;
  let finished = false;
  const send = async (msg: Record<string, unknown>, signal?: AbortSignal): Promise<void> => {
    if (!attemptId) throw new PairRelayError("PAIR_RELAY_BAD_RESPONSE", "The pairing was not opened.");
    await http.call("pair/send", { attemptId, msg }, signal ? { signal } : undefined);
  };
  return {
    async offer(commit, signal) {
      const opened = await http.call("pair/open", { pcId: input.pcId }, { signal });
      if (typeof opened.attemptId !== "string" || opened.attemptId === "") {
        throw new PairRelayError("PAIR_RELAY_BAD_RESPONSE", "AiNecto answered pair/open without an attemptId.");
      }
      attemptId = opened.attemptId;
      await send({ type: "commit", commit: b64u(commit) }, signal);
      for (;;) {
        const answer = await http.call("pair/poll", { attemptId }, { holdMs: input.holdMs, signal });
        if (answer.closed === true) {
          finished = true;
          throw new PairRelayError("PAIR_CLOSED", "The pairing ended on AiNecto (the browser cancelled it, or it expired).");
        }
        const offer = offerOf(Array.isArray(answer.msgs) ? answer.msgs : []);
        if (offer === "abort") {
          finished = true;
          throw new PairRelayError("PAIR_CLOSED", "The browser cancelled the pairing.");
        }
        if (offer) return offer;
      }
    },
    async reveal(pcPublicRaw, nP, signal) {
      await send({ type: "reveal", publicKey: b64u(pcPublicRaw), nP: b64u(nP) }, signal);
    },
    async done(signature, signal) {
      await send({ type: "done", signature: b64u(signature) }, signal);
      finished = true;
    },
    async abort(reason) {
      if (!attemptId || finished) return;
      finished = true;
      try {
        await send({ type: "abort", reason });
      } catch {
        // 응답 줄은 공용 입구가 남겼다 — 서버는 기한(C-E1)·새 open 으로 시도를 닫는다.
      }
    },
  };
}

/**
 * 한 번의 poll 에 온 브라우저 메시지 → 제안(순수). 비면 undefined(다시 poll) · abort 면 "abort".
 * 제안이 둘이거나 모르는 종류·모양이면 그 시도를 끝낸다(던짐).
 */
export function offerOf(msgs: readonly unknown[]): BrowserOffer | "abort" | undefined {
  if (msgs.length === 0) return undefined;
  const items = msgs.map((msg) => (msg && typeof msg === "object" ? msg as Record<string, unknown> : {}));
  if (items.some((item) => item.type === "abort")) return "abort";
  if (items.length > 1) {
    throw new PairRelayError("PAIR_DUPLICATE", "More than one pairing request arrived — this try was ended. Run `ainecto pair` again.");
  }
  const [item] = items;
  const publicRaw = fromB64u(item?.publicKey, PUBLIC_KEY_BYTES);
  const nB = fromB64u(item?.nB, NONCE_SEED_BYTES);
  if (item?.type !== "offer" || !publicRaw || !nB || typeof item.keyId !== "string" || typeof item.name !== "string") {
    throw new PairRelayError("PAIR_BAD_MESSAGE", "AiNecto relayed a pairing message this CLI does not understand — this try was ended.");
  }
  return { keyId: item.keyId, publicRaw, nB, name: item.name };
}

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromB64u(value: unknown, length: number): Uint8Array | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const bytes = new Uint8Array(Buffer.from(value, "base64url"));
  return bytes.length === length ? bytes : undefined;
}
