import { browserNameOf } from "./pcKeys";
import {
  assertSigningPublicKey,
  E2eError,
  importSigningKey,
  NONCE_SEED_BYTES,
  pairCodes,
  pairCommitment,
  pairDoneInput,
  pairTranscript,
  PAIR_CODE_DIGITS,
  publicJwkFromRaw,
  publicRawFromJwk,
  randomBytes,
  signBytes,
  type EcPrivateJwk,
  type EcPublicJwk,
} from "../term/e2e";

/**
 * PC 쪽 첫 짝짓기 한 번(설계 terminal-e2e r2 §11-1) — 약속값 → 브라우저 제안 → 드러내기 → 코드 A 보이기 → 코드 B 한 번 받기 → 비교
 * → (맞으면) 브라우저 핀 → done 서명 보내기. 서버 중계는 {@link PairTransport} 로 주입한다(실제 왕복은 c2).
 * ★시도는 한 번: 난수 한 쌍 · 코드 입력 한 번. 틀리거나 기한이 지나면 끝 — 다시 하려면 사람이 `ainecto pair` 를 다시 실행한다.
 */

/** 짝짓기 한 번의 기한 — 브라우저 요청을 기다리고 코드를 치는 것까지(설계 §9 C-E1 승인: 5분). */
export const PAIR_WAIT_MS = 5 * 60_000;

/** 2단계 — 브라우저가 보낸 것(서버가 중계 — 믿지 않는다. 코드 비교로만 믿는다). */
export interface BrowserOffer {
  keyId: string;
  /** 브라우저 서명 키 공개키(비압축 점 65바이트). */
  publicRaw: Uint8Array;
  /** 브라우저 무작위 32바이트. */
  nB: Uint8Array;
  /** 브라우저가 붙인 이름(기본은 UA 에서) — 찍고 저장하기 전에 다듬는다. */
  name: string;
}

/** 서버 중계 — 기한·중단은 signal 로 받고, 중단되면 거절(reject)한다. 중복 메시지가 오면 거절한다(그 시도는 끝). */
export interface PairTransport {
  /** 1단계 약속값을 올리고 2단계 브라우저 제안을 기다린다. */
  offer(commit: Uint8Array, signal: AbortSignal): Promise<BrowserOffer>;
  /** 3단계 — PC 공개키·nP 를 드러낸다(브라우저가 약속값과 대조한다). */
  reveal(pcPublicRaw: Uint8Array, nP: Uint8Array, signal: AbortSignal): Promise<void>;
  /** 코드 B 가 맞고 핀한 뒤 — done 서명을 보낸다(브라우저는 이것을 검증한 뒤에만 PC 핀을 저장한다). */
  done(signature: Uint8Array, signal: AbortSignal): Promise<void>;
}

/** 사람과 주고받기 — ask 는 한 줄을 돌려주고, 입력이 끝났거나 중단되면 빈 문자열. */
export interface PairPrompt {
  show(line: string): void;
  ask(question: string, signal: AbortSignal): Promise<string>;
}

/** 코드 B 가 맞았을 때 핀할 브라우저. */
export interface MatchedBrowser {
  keyId: string;
  publicJwk: EcPublicJwk;
  name: string;
}

export type PairOutcome =
  /** doneError 가 있으면 PC 에는 핀했지만 done 을 못 보냈다(브라우저는 PC 핀을 저장하지 않는다) — 그 사유. */
  | { kind: "paired"; browser: MatchedBrowser; doneError: string | undefined }
  | { kind: "code-mismatch" }
  | { kind: "timeout" }
  | { kind: "cancelled" };

/** 사람이 친 코드 → 숫자 6자리(공백·하이픈은 뺀다). 아니면 undefined. */
function typedCode(raw: string): string | undefined {
  const digits = raw.replace(/[\s-]/g, "");
  return new RegExp(`^\\d{${PAIR_CODE_DIGITS}}$`).test(digits) ? digits : undefined;
}

export async function runPairing(input: {
  accountKey: string;
  pcId: string;
  pcKey: EcPrivateJwk;
  transport: PairTransport;
  prompt: PairPrompt;
  /** 코드 B 가 맞았을 때 — 브라우저 키를 핀한다(pc-keys.json). 던지면 done 을 보내지 않는다. */
  pin: (browser: MatchedBrowser) => Promise<void>;
  /** 기한 — 운영은 {@link PAIR_WAIT_MS}. */
  waitMs: number;
  /** nP — 시험만 바꾼다. */
  random?: () => Uint8Array;
}): Promise<PairOutcome> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), input.waitMs);
  const { signal } = deadline;
  const relayed = async <T>(step: () => Promise<T>): Promise<T | "timeout"> => {
    try {
      return await step();
    } catch (error) {
      if (signal.aborted) return "timeout";
      throw error;
    }
  };
  try {
    const pcPublicRaw = publicRawFromJwk(input.pcKey);
    const nP = (input.random ?? (() => randomBytes(NONCE_SEED_BYTES)))();
    const commit = await pairCommitment(pcPublicRaw, nP);
    input.prompt.show(`Waiting up to ${Math.round(input.waitMs / 60_000)} min for a browser — in AiNecto on the web, open Terminal, `
      + "pick this PC and choose «Pair with this PC».");
    const offer = await relayed(() => input.transport.offer(commit, signal));
    if (offer === "timeout") return { kind: "timeout" };
    // ★중계된 값 — 모양을 먼저 본다(곡선 위 점 · keyId 모양). 이름은 화면에 찍기 전에 다듬는다(개행·제어 문자 제거).
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(offer.keyId)) {
      throw new E2eError("E2E_BAD_INPUT", "The browser's key id is malformed — pairing aborted.");
    }
    const publicJwk = publicJwkFromRaw(offer.publicRaw);
    await assertSigningPublicKey(publicJwk);
    const name = browserNameOf(offer.name);
    if ((await relayed(() => input.transport.reveal(pcPublicRaw, nP, signal))) === "timeout") return { kind: "timeout" };
    const transcript = await pairTranscript({ accountKey: input.accountKey, pcId: input.pcId, pcPublicRaw, browserPublicRaw: offer.publicRaw, nP, nB: offer.nB });
    const codes = await pairCodes(transcript);
    input.prompt.show(`A browser asked to pair: ${name}`);
    input.prompt.show(`Type this code in the browser: ${codes.a}`);
    const answer = await input.prompt.ask("Then type the code the browser shows (one try): ", signal);
    if (signal.aborted) return { kind: "timeout" };
    if (answer.trim() === "") return { kind: "cancelled" };
    if (typedCode(answer) !== codes.b) return { kind: "code-mismatch" };
    const browser: MatchedBrowser = { keyId: offer.keyId, publicJwk, name };
    await input.pin(browser);
    const signature = await signBytes(await importSigningKey(input.pcKey), pairDoneInput(transcript));
    let doneError: string | undefined;
    try {
      await input.transport.done(signature, signal);
    } catch (error) {
      doneError = signal.aborted ? "timed out" : error instanceof Error ? error.message : String(error);
    }
    return { kind: "paired", browser, doneError };
  } finally {
    clearTimeout(timer);
  }
}
