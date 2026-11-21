import { webcrypto } from "node:crypto";

/**
 * 원격 터미널 종단 간 암호화(E2E)의 순수 암호 한 벌 — I/O 0 · 새 의존성 0(`node:crypto` 의 WebCrypto 만).
 * 설계: `_workspace/design/terminal-e2e/README.md` r3 §12 > §11(확정 계약 — §4 와 다르면 §12·§11). 이 파일이 정한 세부는 §12-6.
 *
 * ★브라우저(ainecto-front `src/lib/e2e`)가 아래 바이트를 **한 바이트도 다르지 않게** 다시 만든다.
 *   묶음은 `test/fixtures/e2e-vectors.v1.json`(front 와 같은 파일)이 지킨다 — 여기를 바꾸면 그 벡터가 깨져야 한다.
 *
 * ── 바이트 규칙(v1) ─────────────────────────────────────────────
 * - `enc(f1, f2, …)` = 칸마다 u16be(길이) ‖ 바이트 를 이어 붙인다. 문자열은 UTF-8. 칸 하나는 65535바이트 이하.
 * - 공개키(장기 ECDSA·임시 ECDH 모두)는 SEC1 비압축 점 65바이트 = 0x04 ‖ X(32) ‖ Y(32) — WebCrypto `exportKey("raw")` 그대로.
 * - 무작위 nP·nB·nP′ 는 32바이트. userId = UUID 소문자 36자 — 서버 주소는 넣지 않는다(§12-4: CLI·front 의 주소 표기가 달라도 같은 바이트).
 * - 서명 = ECDSA P-256 / SHA-256, IEEE-P1363(r ‖ s, 64바이트) — WebCrypto `sign` 그대로(DER 아님).
 * - u64be(n) = 8바이트 big-endian. enc 안에 넣을 때도 다른 칸처럼 u16be(8) 이 앞에 붙는다.
 *
 * 짝짓기(§11-1)
 * - commit = SHA-256(pcPub(65) ‖ nP(32))                          — 두 칸 길이가 고정이라 enc 없이 그대로 잇는다.
 * - T      = SHA-256(enc("ainecto-pair-v1", userId, pcId, pcPub, browserPub, nP, nB))
 * - 코드 X(X = A·B) : K = HKDF-Expand(PRK = T, info = "ainecto-pair-code-A" | "ainecto-pair-code-B", L = 32)
 *                     = HMAC-SHA256(key = T, info ‖ 0x01)   (RFC 5869 §2.3, L ≤ 32 라 한 블록)
 *                     K 를 앞에서부터 4바이트씩 u32be 로 읽어 v < 4294000000 인 첫 v → (v mod 10^6) 6자리 0 채움.
 *                     8개 모두 넘으면 그 시도는 실패(E2E_PAIR_CODE_UNAVAILABLE).
 * - done   = PC 키 서명(enc("ainecto-pair-v1/done", T)) — 브라우저는 이것을 임시 PC 키로 검증한 뒤에만 PC 핀을 저장한다.
 *
 * 채널(§11-2)
 * - hello 서명 입력(브라우저 키) = enc("ainecto-e2e-v1", "browser", "hello", userId, pcId, 채널, 브라우저 키 id, eB, nB)
 * - H = SHA-256(enc("ainecto-e2e-v1", userId, pcId, 채널, 브라우저 키 id, pcPub, browserPub, eB, nB, eP, nP′))
 * - welcome 서명 입력(PC 키) = H 32바이트 그대로.
 * - Z = ECDH(자기 임시 비공개, 상대 임시 공개) 의 x 좌표 32바이트(WebCrypto `deriveBits(…, 256)`).
 * - HKDF-SHA256(IKM = Z, salt = H):
 *     웹→PC 키 info "ainecto-e2e-v1 b2p" 32바이트 · PC→웹 키 info "ainecto-e2e-v1 p2b" 32바이트 · 연결 id info "ainecto-e2e-v1 conn-id" 16바이트
 *
 * 메시지(AES-256-GCM, 태그 128비트 — 암호문 뒤에 붙는다, WebCrypto 그대로)
 * - 카운터: 방향 키마다 하나(모든 종류 공유) · 0 부터 1씩(웹→PC 의 0 = confirm) · 2^32 개까지(0 ‥ 2^32−1) — 닿으면 새 hello.
 * - nonce(12바이트) = 0x00000000 ‖ u64be(카운터)
 * - AAD = enc("ainecto-e2e-v1", 종류, 연결 id(16), pcId, 세션 이름, 연산 ID | "", projectUuid | "", u64be(카운터))
 *         연산 ID = 브라우저가 봉인 전에 정한 UUID v4(만들기·끝내기·이름 — §12-2). 서버의 상관 id 가 아니다.
 * - 받기: 웹→PC 는 정확히 직전 + 1(첫 값 0), PC→웹 은 직전보다 크기만 하면(첫 값 0 이상). 태그가 맞은 뒤에만 상태를 넘긴다.
 */

const subtle = webcrypto.subtle;
type CryptoKey = webcrypto.CryptoKey;

const VERSION = "ainecto-e2e-v1";
const PAIR_LABEL = "ainecto-pair-v1";
const PAIR_DONE_LABEL = "ainecto-pair-v1/done";
const PAIR_CODE_INFO = { a: "ainecto-pair-code-A", b: "ainecto-pair-code-B" } as const;
const KEY_INFO = { browserToPc: "ainecto-e2e-v1 b2p", pcToBrowser: "ainecto-e2e-v1 p2b", connId: "ainecto-e2e-v1 conn-id" } as const;
/** 10^6 의 배수 중 2^32 보다 작은 가장 큰 값 — 이보다 작은 u32 만 써야 mod 10^6 이 고르다. */
const PAIR_CODE_LIMIT = 4_294_000_000;

/** 방향 키당 메시지 상한(설계 §11-9 C-E4 — Ryan 11-21 승인): 카운터 0 ‥ 2^32−1. 닿으면 채널을 끝내고 새 hello. */
export const MAX_MESSAGES_PER_KEY = 2 ** 32;

export const PUBLIC_KEY_BYTES = 65;
export const NONCE_SEED_BYTES = 32;
export const SIGNATURE_BYTES = 64;
export const CONN_ID_BYTES = 16;
/** 짝짓기 코드 자릿수(설계 §9 C-E1 — 6자리 × 2). */
export const PAIR_CODE_DIGITS = 6;

/** E2E 오류 — 코드가 붙는다. 다리·pair 명령이 이 코드로 거절 사유를 남긴다. */
export class E2eError extends Error {
  constructor(
    readonly code:
      | "E2E_BAD_INPUT"
      | "E2E_COMMITMENT_MISMATCH"
      | "E2E_PAIR_CODE_UNAVAILABLE"
      | "E2E_COUNTER_REJECTED"
      | "E2E_DECRYPT_FAILED",
    message: string,
  ) {
    super(message);
  }
}

/** P-256 공개키 JWK — 저장·교환용(필요한 칸만). */
export interface EcPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/** P-256 비공개키 JWK(공개 칸 포함). */
export interface EcPrivateJwk extends EcPublicJwk {
  d: string;
}

// ── 바이트 도우미 ───────────────────────────────────────────────

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** enc(…) — 칸마다 u16be(길이) ‖ 바이트. */
function enc(...fields: Array<Uint8Array | string>): Uint8Array {
  return concatBytes(...fields.map((field) => {
    const bytes = typeof field === "string" ? utf8(field) : field;
    if (bytes.length > 0xffff) {
      throw new E2eError("E2E_BAD_INPUT", `a field is ${bytes.length} bytes (max 65535).`);
    }
    const out = new Uint8Array(2 + bytes.length);
    new DataView(out.buffer).setUint16(0, bytes.length, false);
    out.set(bytes, 2);
    return out;
  }));
}

function u64be(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", data));
}

export function randomBytes(length: number = NONCE_SEED_BYTES): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(length));
}

function expectLength(name: string, bytes: Uint8Array, length: number): void {
  if (bytes.length !== length) {
    throw new E2eError("E2E_BAD_INPUT", `${name} must be ${length} bytes, got ${bytes.length}.`);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

// ── 키 ──────────────────────────────────────────────────────────

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" } as const;

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64url(name: string, text: string, length: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new E2eError("E2E_BAD_INPUT", `${name} is not base64url.`);
  }
  const bytes = new Uint8Array(Buffer.from(text, "base64url"));
  expectLength(name, bytes, length);
  return bytes;
}

/** 모양 검사(순수) — kty EC · crv P-256 · x·y 32바이트. 아니면 undefined. */
export function asPublicJwk(raw: unknown): EcPublicJwk | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (value.kty !== "EC" || value.crv !== "P-256" || typeof value.x !== "string" || typeof value.y !== "string") return undefined;
  try {
    fromBase64url("x", value.x, 32);
    fromBase64url("y", value.y, 32);
  } catch {
    return undefined;
  }
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y };
}

/** 모양 검사(순수) — 공개 칸 + d 32바이트. 아니면 undefined. */
export function asPrivateJwk(raw: unknown): EcPrivateJwk | undefined {
  const pub = asPublicJwk(raw);
  const d = (raw as Record<string, unknown> | undefined)?.d;
  if (!pub || typeof d !== "string") return undefined;
  try {
    fromBase64url("d", d, 32);
  } catch {
    return undefined;
  }
  return { ...pub, d };
}

/** 비공개 JWK 에서 공개 칸만. */
export function publicJwkOf(jwk: EcPrivateJwk): EcPublicJwk {
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/** JWK → 비압축 점 65바이트(0x04 ‖ X ‖ Y). */
export function publicRawFromJwk(jwk: EcPublicJwk): Uint8Array {
  return concatBytes(Uint8Array.of(0x04), fromBase64url("x", jwk.x, 32), fromBase64url("y", jwk.y, 32));
}

/** 비압축 점 65바이트 → JWK. (곡선 위 점인지는 {@link assertSigningPublicKey}·import 가 본다.) */
export function publicJwkFromRaw(raw: Uint8Array): EcPublicJwk {
  expectLength("public key", raw, PUBLIC_KEY_BYTES);
  if (raw[0] !== 0x04) {
    throw new E2eError("E2E_BAD_INPUT", "public key must be an uncompressed P-256 point (0x04 ‖ X ‖ Y).");
  }
  return { kty: "EC", crv: "P-256", x: base64url(raw.subarray(1, 33)), y: base64url(raw.subarray(33, 65)) };
}

/** 장기 서명 키(PC 키) 새로 — 저장할 비공개 JWK. */
export async function generateSigningJwk(): Promise<EcPrivateJwk> {
  const pair = await subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  const jwk = asPrivateJwk(await subtle.exportKey("jwk", pair.privateKey));
  if (!jwk) {
    throw new Error("WebCrypto returned an unexpected P-256 JWK.");
  }
  return jwk;
}

export async function importSigningKey(jwk: EcPrivateJwk): Promise<CryptoKey> {
  return await subtle.importKey("jwk", { ...jwk }, ECDSA, false, ["sign"]);
}

/** 받은 서명 공개키가 P-256 곡선 위의 점인지 — 아니면 E2E_BAD_INPUT(저장 전에 본다). */
export async function assertSigningPublicKey(publicKey: EcPublicJwk): Promise<void> {
  try {
    await subtle.importKey("jwk", { ...publicKey }, ECDSA, false, ["verify"]);
  } catch {
    throw new E2eError("E2E_BAD_INPUT", "public key is not a valid P-256 point.");
  }
}

/** 서명 — IEEE-P1363 r ‖ s 64바이트. */
export async function signBytes(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.sign(SIGN_PARAMS, privateKey, data));
}

/** 검증 — 키·서명 모양이 틀려도 던지지 않고 false. */
export async function verifyBytes(publicKey: EcPublicJwk, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  if (signature.length !== SIGNATURE_BYTES) return false;
  try {
    const key = await subtle.importKey("jwk", { ...publicKey }, ECDSA, false, ["verify"]);
    return await subtle.verify(SIGN_PARAMS, key, signature, data);
  } catch {
    return false;
  }
}

/** 연결마다 쓰는 임시 ECDH 키 — 비공개는 내보낼 수 없다. */
export interface EphemeralKey {
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
}

export async function generateEphemeral(): Promise<EphemeralKey> {
  const pair = await subtle.generateKey(ECDH, false, ["deriveBits"]);
  return { privateKey: pair.privateKey, publicRaw: new Uint8Array(await subtle.exportKey("raw", pair.publicKey)) };
}

/** 고정 임시 키(시험 벡터용) — 비공개 JWK 로. */
export async function importEphemeral(jwk: EcPrivateJwk): Promise<EphemeralKey> {
  return {
    privateKey: await subtle.importKey("jwk", { ...jwk }, ECDH, false, ["deriveBits"]),
    publicRaw: publicRawFromJwk(jwk),
  };
}

// ── 짝짓기(§11-1) ───────────────────────────────────────────────

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 계정 userId → 대화 기록에 넣을 값(소문자 UUID 36자 — §12-4). 다리·pair 가 모두 이것으로 바꾼다. UUID 가 아니면 E2E_BAD_INPUT. */
export function transcriptUserId(raw: string): string {
  const userId = raw.toLowerCase();
  expectUserId(userId);
  return userId;
}

/** 대화 기록의 userId — UUID 소문자 36자만(§12-4). */
function expectUserId(userId: string): void {
  if (!USER_ID.test(userId)) {
    throw new E2eError("E2E_BAD_INPUT", "userId must be a lowercase 36-character UUID.");
  }
}

/** 1단계 약속값 = SHA-256(pcPub ‖ nP). */
export async function pairCommitment(pcPublicRaw: Uint8Array, nP: Uint8Array): Promise<Uint8Array> {
  expectLength("pcPub", pcPublicRaw, PUBLIC_KEY_BYTES);
  expectLength("nP", nP, NONCE_SEED_BYTES);
  return await sha256(concatBytes(pcPublicRaw, nP));
}

/** 3단계(브라우저) — 드러낸 pcPub·nP 가 1단계 약속값과 같지 않으면 E2E_COMMITMENT_MISMATCH. */
export async function assertCommitment(commit: Uint8Array, pcPublicRaw: Uint8Array, nP: Uint8Array): Promise<void> {
  if (!sameBytes(commit, await pairCommitment(pcPublicRaw, nP))) {
    throw new E2eError("E2E_COMMITMENT_MISMATCH", "The PC's revealed key does not match its commitment — pairing aborted.");
  }
}

export interface PairTranscriptInput {
  userId: string;
  pcId: string;
  pcPublicRaw: Uint8Array;
  browserPublicRaw: Uint8Array;
  nP: Uint8Array;
  nB: Uint8Array;
}

/** T = SHA-256(enc("ainecto-pair-v1", userId, pcId, pcPub, browserPub, nP, nB)). */
export async function pairTranscript(input: PairTranscriptInput): Promise<Uint8Array> {
  expectUserId(input.userId);
  expectLength("pcPub", input.pcPublicRaw, PUBLIC_KEY_BYTES);
  expectLength("browserPub", input.browserPublicRaw, PUBLIC_KEY_BYTES);
  expectLength("nP", input.nP, NONCE_SEED_BYTES);
  expectLength("nB", input.nB, NONCE_SEED_BYTES);
  return await sha256(enc(PAIR_LABEL, input.userId, input.pcId, input.pcPublicRaw, input.browserPublicRaw, input.nP, input.nB));
}

/** 코드 블록 K(32바이트) → 6자리(순수 · 거절 샘플링). 8개 u32 가 모두 한도 이상이면 undefined. */
export function pairCodeFromBlock(block: Uint8Array): string | undefined {
  expectLength("code block", block, 32);
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  for (let offset = 0; offset < 32; offset += 4) {
    const value = view.getUint32(offset, false);
    if (value < PAIR_CODE_LIMIT) {
      return String(value % 10 ** PAIR_CODE_DIGITS).padStart(PAIR_CODE_DIGITS, "0");
    }
  }
  return undefined;
}

export interface PairCodes {
  /** PC 가 보이고 사람이 브라우저에 친다. */
  a: string;
  /** 브라우저가 보이고 사람이 PC 에 친다. */
  b: string;
}

/** T → 코드 A·B(서로 독립 · 균등). */
export async function pairCodes(transcript: Uint8Array): Promise<PairCodes> {
  expectLength("transcript", transcript, 32);
  const prk = await subtle.importKey("raw", transcript, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const code = async (info: string): Promise<string> => {
    const block = new Uint8Array(await subtle.sign("HMAC", prk, concatBytes(utf8(info), Uint8Array.of(0x01))));
    const value = pairCodeFromBlock(block);
    if (value === undefined) {
      throw new E2eError("E2E_PAIR_CODE_UNAVAILABLE", "No usable pairing code in this attempt — run `ainecto pair` again.");
    }
    return value;
  };
  return { a: await code(PAIR_CODE_INFO.a), b: await code(PAIR_CODE_INFO.b) };
}

/** done 서명 입력 = enc("ainecto-pair-v1/done", T). */
export function pairDoneInput(transcript: Uint8Array): Uint8Array {
  expectLength("transcript", transcript, 32);
  return enc(PAIR_DONE_LABEL, transcript);
}

// ── 채널(§11-2) ─────────────────────────────────────────────────

/** hello 칸 — 브라우저가 보내고 브라우저 키로 서명한다. */
export interface HelloFields {
  userId: string;
  pcId: string;
  channel: string;
  browserKeyId: string;
  /** 브라우저 임시 ECDH 공개키 65바이트. */
  eB: Uint8Array;
  /** 브라우저 무작위 32바이트. */
  nB: Uint8Array;
}

/** 대화 기록 H 의 칸 — hello + 양쪽 장기 공개키 + welcome 의 eP·nP′. */
export interface ChannelTranscriptInput {
  hello: HelloFields;
  pcPublicRaw: Uint8Array;
  browserPublicRaw: Uint8Array;
  /** PC 임시 ECDH 공개키 65바이트. */
  eP: Uint8Array;
  /** PC 무작위 32바이트(nP′). */
  nP: Uint8Array;
}

function assertHello(hello: HelloFields): void {
  expectUserId(hello.userId);
  expectLength("eB", hello.eB, PUBLIC_KEY_BYTES);
  expectLength("nB", hello.nB, NONCE_SEED_BYTES);
}

/** 브라우저 키가 서명하는 바이트. */
export function helloSignatureInput(hello: HelloFields): Uint8Array {
  assertHello(hello);
  return enc(VERSION, "browser", "hello", hello.userId, hello.pcId, hello.channel, hello.browserKeyId, hello.eB, hello.nB);
}

/** H — welcome 서명 입력이자 HKDF salt. */
export async function channelTranscript(input: ChannelTranscriptInput): Promise<Uint8Array> {
  const { hello } = input;
  assertHello(hello);
  expectLength("pcPub", input.pcPublicRaw, PUBLIC_KEY_BYTES);
  expectLength("browserPub", input.browserPublicRaw, PUBLIC_KEY_BYTES);
  expectLength("eP", input.eP, PUBLIC_KEY_BYTES);
  expectLength("nP'", input.nP, NONCE_SEED_BYTES);
  return await sha256(enc(VERSION, hello.userId, hello.pcId, hello.channel, hello.browserKeyId,
    input.pcPublicRaw, input.browserPublicRaw, hello.eB, hello.nB, input.eP, input.nP));
}

/** 채널 키 원본 — 방향별 32바이트({@link importMessageKey} 로 AES-GCM 키가 된다) + 연결 id 16바이트(AAD 에 들어간다). */
export interface ChannelSecrets {
  browserToPc: Uint8Array;
  pcToBrowser: Uint8Array;
  connId: Uint8Array;
}

/**
 * ECDH(자기 임시 키, 상대 임시 공개키) → HKDF-SHA256(salt = H) → 두 방향 키 + 연결 id.
 * PC 는 (자기 eP 비공개, eB) · 브라우저는 (자기 eB 비공개, eP) 로 부르고 같은 값을 얻는다.
 */
export async function deriveChannelSecrets(input: { own: CryptoKey; peerPublicRaw: Uint8Array; transcript: Uint8Array }): Promise<ChannelSecrets> {
  expectLength("peer ephemeral key", input.peerPublicRaw, PUBLIC_KEY_BYTES);
  expectLength("transcript", input.transcript, 32);
  let peer: CryptoKey;
  try {
    peer = await subtle.importKey("raw", input.peerPublicRaw, ECDH, false, []);
  } catch {
    throw new E2eError("E2E_BAD_INPUT", "peer ephemeral key is not a valid P-256 point.");
  }
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: peer }, input.own, 256));
  const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const derive = async (info: string, bytes: number): Promise<Uint8Array> =>
    new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: input.transcript, info: utf8(info) }, ikm, bytes * 8));
  return {
    browserToPc: await derive(KEY_INFO.browserToPc, 32),
    pcToBrowser: await derive(KEY_INFO.pcToBrowser, 32),
    connId: await derive(KEY_INFO.connId, CONN_ID_BYTES),
  };
}

export async function importMessageKey(secret: Uint8Array): Promise<CryptoKey> {
  expectLength("message key", secret, 32);
  return await subtle.importKey("raw", secret, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// ── 메시지 ──────────────────────────────────────────────────────

/** AAD 에 들어가는 메시지 머리 — 실행 의미를 바꾸는 평문 칸은 모두 여기서 인증된다(§11-2). 없는 칸은 "". */
export interface MessageHeader {
  /** 종류 이름(confirm·frame·input·create …). */
  type: string;
  connId: Uint8Array;
  pcId: string;
  session: string;
  /** 연산 ID — 브라우저가 봉인 전에 정한 UUID(만들기·끝내기·이름), 없으면 "". */
  operationId: string;
  projectUuid: string;
  counter: number;
}

/**
 * 받는 쪽 순서 정책 — exact: 웹→PC(부작용 있는 명령 — 정확히 직전 + 1) · increasing: PC→웹(화면은 건너뛰어도 된다).
 * next = 받을 수 있는 가장 작은 카운터(처음 0).
 */
export interface ReceiveState {
  order: "exact" | "increasing";
  next: number;
}

function assertCounter(counter: number): void {
  if (!Number.isSafeInteger(counter) || counter < 0 || counter >= MAX_MESSAGES_PER_KEY) {
    throw new E2eError("E2E_COUNTER_REJECTED", `counter must be an integer from 0 to ${MAX_MESSAGES_PER_KEY - 1} (then start a new hello).`);
  }
}

export function messageNonce(counter: number): Uint8Array {
  assertCounter(counter);
  return concatBytes(new Uint8Array(4), u64be(counter));
}

export function messageAad(header: MessageHeader): Uint8Array {
  assertCounter(header.counter);
  expectLength("connId", header.connId, CONN_ID_BYTES);
  return enc(VERSION, header.type, header.connId, header.pcId, header.session, header.operationId, header.projectUuid, u64be(header.counter));
}

/** 보내는 쪽 — 카운터는 부르는 쪽이 방향 키마다 0 부터 원자적으로 배정한다(같은 키·같은 카운터를 두 번 쓰지 않는다). */
export async function sealMessage(key: CryptoKey, header: MessageHeader, plaintext: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: messageNonce(header.counter), additionalData: messageAad(header), tagLength: 128 },
    key, plaintext));
}

/**
 * 받는 쪽 — 순서 정책(exact: counter === next · increasing: counter ≥ next)을 먼저 보고, 태그가 맞으면 새 상태(next = counter + 1)를 돌려준다.
 * 실패하면 상태는 그대로(부른 쪽이 채널을 버리고 hello 부터 — §11-2).
 */
export async function openMessage(key: CryptoKey, header: MessageHeader, ciphertext: Uint8Array, state: ReceiveState)
  : Promise<{ plaintext: Uint8Array; state: ReceiveState }> {
  assertCounter(header.counter);
  const inOrder = state.order === "exact" ? header.counter === state.next : header.counter >= state.next;
  if (!inOrder) {
    throw new E2eError("E2E_COUNTER_REJECTED",
      `counter ${header.counter} rejected (${state.order === "exact" ? `expected exactly ${state.next}` : `expected ${state.next} or more`}).`);
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle.decrypt({ name: "AES-GCM", iv: messageNonce(header.counter), additionalData: messageAad(header), tagLength: 128 },
      key, ciphertext);
  } catch {
    throw new E2eError("E2E_DECRYPT_FAILED", "message failed authentication (wrong key, header or ciphertext).");
  }
  return { plaintext: new Uint8Array(plaintext), state: { order: state.order, next: header.counter + 1 } };
}
