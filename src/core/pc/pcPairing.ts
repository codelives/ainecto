import { browserNameOf } from "./pcKeys";
import {
  assertSigningPublicKey,
  browserKeyIdOf,
  pairCodeInput,
  E2eError,
  importSigningKey,
  macEquals,
  NONCE_SEED_BYTES,
  pairCodes,
  pairCommitment,
  pairDoneInput,
  pairTranscript,
  publicJwkFromRaw,
  publicRawFromJwk,
  randomBytes,
  registerKeys,
  registerOfferMac,
  registerRevealMac,
  signBytes,
  type EcPrivateJwk,
  type EcPublicJwk,
} from "../term/e2e";

/**
 * PC 쪽 첫 짝짓기 한 번(설계 terminal-e2e §11-1 · §12) — 약속값 → 브라우저 제안 → 드러내기 → 코드 A 보이기 → 코드 B 한 번 받기 → 비교
 * → (맞으면) 브라우저 핀 → done 서명 보내기. 서버 중계는 {@link PairTransport} 로 주입한다(운영 = pcPairRelay.createPairRelay).
 * ★시도는 한 번: 난수 한 쌍 · 코드 입력 한 번. 틀리거나 기한이 지나면 끝 — 다시 하려면 사람이 `ainecto pair` 를 다시 실행한다.
 * 확인 방식은 {@link PairCheck} 로 주입한다 — codes(사람이 코드 A·B 를 비교 · `ainecto pair`) / secret(자동 등록 — 주소로 넘긴 S 로 키를 건
 * macB·macP, 설계 auto-register-0.15.2 §1). commit·T·done 서명·핀 검사는 두 방식이 같다.
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
  /** 자동 등록 브라우저의 macB(32바이트) — 수동(코드) 브라우저는 싣지 않는다. */
  macB?: Uint8Array;
  /** 이 시도의 id — 브라우저가 아니라 중계(pair/open)가 준 값. macB 가 묶는다. */
  attemptId: string;
}

/** 서버 중계 — 기한·중단은 signal 로 받고, 중단되면 거절(reject)한다. 중복 메시지가 오면 거절한다(그 시도는 끝). */
export interface PairTransport {
  /** 1단계 약속값을 올리고 2단계 브라우저 제안을 기다린다. */
  offer(commit: Uint8Array, signal: AbortSignal): Promise<BrowserOffer>;
  /** 3단계 — PC 공개키·nP 를 드러낸다(브라우저가 약속값과 대조한다). secret 방식이면 macP 를 함께 싣는다. */
  reveal(pcPublicRaw: Uint8Array, nP: Uint8Array, signal: AbortSignal, macP?: Uint8Array): Promise<void>;
  /** 코드 B 가 맞고 핀한 뒤 — done 서명을 보낸다(브라우저는 이것을 검증한 뒤에만 PC 핀을 저장한다). */
  done(signature: Uint8Array, signal: AbortSignal): Promise<void>;
  /** 짝짓지 못하고 끝났다(틀림·기한·취소·오류) — 브라우저에 알린다(최선 — 던지지 않는다). done 을 보냈으면 아무것도 안 한다. */
  abort(reason: "code-mismatch" | "timeout" | "cancelled" | "error"): Promise<void>;
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

/** 확인 방식 — codes: 사람이 코드 A·B 를 비교한다 / secret: 주소로 넘긴 일회용 비밀 S(32바이트)로 macB 를 검증하고 macP 를 단다. */
export type PairCheck = { kind: "codes"; prompt: PairPrompt } | { kind: "secret"; secret: Uint8Array };

export type PairOutcome =
  /** doneError 가 있으면 PC 에는 핀했지만 done(secret 이면 reveal 부터)을 못 보냈다(브라우저는 PC 핀을 저장하지 않는다) — 그 사유. */
  | { kind: "paired"; browser: MatchedBrowser; doneError: string | undefined }
  /** codes: 코드 B 불일치 · secret: macB 가 없거나 맞지 않음. 중계 abort 사유도 이 이름이다. */
  | { kind: "code-mismatch" }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export async function runPairing(input: {
  /** 대화 기록에 들어가는 userId(UUID 소문자) — 서버 주소는 넣지 않는다(§12-4). */
  userId: string;
  pcId: string;
  pcKey: EcPrivateJwk;
  transport: PairTransport;
  check: PairCheck;
  /** 확인이 맞았을 때 — 브라우저 키를 핀한다(pc-keys.json). 던지면 done(secret 이면 reveal 부터)을 보내지 않는다. */
  pin: (browser: MatchedBrowser) => Promise<void>;
  /** 기한 — 운영은 {@link PAIR_WAIT_MS}. */
  waitMs: number;
  /** 사람이 건너뛴다(Ctrl+C) — 끝나면 cancelled. */
  cancel?: AbortSignal;
  /** nP — 시험만 바꾼다. */
  random?: () => Uint8Array;
}): Promise<PairOutcome> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), input.waitMs);
  let cancelled = false;
  const onCancel = (): void => {
    cancelled = true;
    deadline.abort();
  };
  input.cancel?.addEventListener("abort", onCancel, { once: true });
  if (input.cancel?.aborted) onCancel();
  const { signal } = deadline;
  const relayed = async <T>(step: () => Promise<T>): Promise<T | "timeout"> => {
    try {
      return await step();
    } catch (error) {
      if (signal.aborted) return "timeout";
      throw error;
    }
  };
  let outcome: PairOutcome | undefined;
  try {
    outcome = await pairOnce();
    if (cancelled && outcome.kind === "timeout") outcome = { kind: "cancelled" };
    return outcome;
  } finally {
    clearTimeout(timer);
    input.cancel?.removeEventListener("abort", onCancel);
    if (outcome?.kind !== "paired") await input.transport.abort(outcome?.kind ?? "error");
  }

  async function pairOnce(): Promise<PairOutcome> {
    const pcPublicRaw = publicRawFromJwk(input.pcKey);
    const nP = (input.random ?? (() => randomBytes(NONCE_SEED_BYTES)))();
    const commit = await pairCommitment(pcPublicRaw, nP);
    const { check } = input;
    if (check.kind === "codes") {
      check.prompt.show(`Waiting up to ${Math.round(input.waitMs / 60_000)} min for a browser — in AiNecto on the web, open Terminal, `
        + "pick this PC and start the browser registration there.");
    }
    const offer = await relayed(() => input.transport.offer(commit, signal));
    if (offer === "timeout") return { kind: "timeout" };
    // ★중계된 값 — 모양을 먼저 본다(곡선 위 점 · keyId = 공개키 지문, §13-3). 이름은 화면에 찍기 전에 다듬는다(개행·제어 문자 제거).
    const publicJwk = publicJwkFromRaw(offer.publicRaw);
    await assertSigningPublicKey(publicJwk);
    if (offer.keyId !== await browserKeyIdOf(offer.publicRaw)) {
      throw new E2eError("E2E_BAD_INPUT", "The browser's key id is not the fingerprint of its key — browser registration aborted.");
    }
    const browser: MatchedBrowser = { keyId: offer.keyId, publicJwk, name: browserNameOf(offer.name) };
    const transcript = (): Promise<Uint8Array> =>
      pairTranscript({ userId: input.userId, pcId: input.pcId, pcPublicRaw, browserPublicRaw: offer.publicRaw, nP, nB: offer.nB });
    if (check.kind === "secret") {
      // ★S 를 아는 브라우저가 이 시도(attemptId·commit)에 이 키·이름을 냈는가 — 맞을 때만 핀하고 드러낸다(macB 없는 옛 브라우저는 거절).
      const keys = await registerKeys(check.secret);
      const expected = await registerOfferMac(keys.browser, { userId: input.userId, pcId: input.pcId, attemptId: offer.attemptId, commit,
        browserPublicRaw: offer.publicRaw, keyId: offer.keyId, nB: offer.nB, name: offer.name });
      if (!offer.macB || !macEquals(offer.macB, expected)) return { kind: "code-mismatch" };
      const t = await transcript();
      await input.pin(browser);
      const macP = await registerRevealMac(keys.pc, { transcript: t, attemptId: offer.attemptId });
      return await finish(browser, t, () => input.transport.reveal(pcPublicRaw, nP, signal, macP));
    }
    if ((await relayed(() => input.transport.reveal(pcPublicRaw, nP, signal))) === "timeout") return { kind: "timeout" };
    const t = await transcript();
    const codes = await pairCodes(t);
    check.prompt.show(`A browser asked to be registered: ${browser.name}`);
    check.prompt.show(`Type this code in the browser: ${codes.a}`);
    const answer = await check.prompt.ask("Then type the code the browser shows (one try): ", signal);
    if (signal.aborted) return { kind: "timeout" };
    const typed = pairCodeInput(answer);
    if (typed.kind === "empty") return { kind: "cancelled" };
    // 6자리가 아닌 입력도 한 번으로 센다(§13-3).
    if (typed.kind !== "code" || typed.code !== codes.b) return { kind: "code-mismatch" };
    await input.pin(browser);
    return await finish(browser, t);
  }

  /** 핀한 뒤 — (secret 이면 reveal 먼저) done 서명을 보낸다. 못 보내면 doneError. */
  async function finish(browser: MatchedBrowser, transcript: Uint8Array, before?: () => Promise<void>): Promise<PairOutcome> {
    const signature = await signBytes(await importSigningKey(input.pcKey), pairDoneInput(transcript));
    let doneError: string | undefined;
    try {
      await before?.();
      await input.transport.done(signature, signal);
    } catch (error) {
      doneError = signal.aborted ? "timed out" : error instanceof Error ? error.message : String(error);
    }
    return { kind: "paired", browser, doneError };
  }
}
