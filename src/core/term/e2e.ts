import { webcrypto } from "node:crypto";

/**
 * 원격 터미널 종단 간 암호화(E2E)의 순수 암호 한 벌 — I/O 0 · 새 의존성 0(`node:crypto` 의 WebCrypto 만).
 * 설계: `_workspace/design/terminal-e2e/README.md` §3·§4-2·§4-4.
 *
 * ★브라우저(ainecto-front `src/lib/e2e`)가 아래 바이트 배열을 **한 바이트도 다르지 않게** 다시 만든다.
 *   묶음은 `test/fixtures/e2e-vectors.v1.json`(front 와 같은 파일)이 지킨다 — 여기를 바꾸면 그 벡터가 깨져야 한다.
 *
 * ── 바이트 규칙(v1) ─────────────────────────────────────────────
 * - 문자열은 UTF-8 바이트.
 * - `lp(x)` = 길이(4바이트 big-endian 부호 없는 정수) ‖ x. 이어 붙이는 칸은 **모두** lp 로 감싼다(경계가 모호하지 않게).
 * - 공개키(서명 키·임시 ECDH 키 모두)는 P-256 비압축 점 65바이트 = 0x04 ‖ X(32) ‖ Y(32) — WebCrypto `exportKey("raw")` 그대로.
 * - 무작위 nP·nB 는 32바이트.
 * - 서명 = ECDSA P-256 / SHA-256, IEEE-P1363(r ‖ s, 64바이트) — WebCrypto `sign` 그대로(DER 아님).
 *
 * 짝짓기(§4-2)
 * - commit = SHA-256(pcPub(65) ‖ nP(32))                         — 두 칸 길이가 고정이라 lp 없이 그대로 잇는다.
 * - T      = SHA-256(lp("ainecto-pair-v1") ‖ lp(pcId) ‖ lp(pcPub) ‖ lp(browserPub) ‖ lp(nP) ‖ lp(nB))
 * - 코드 A = (T 의 비트 0..19 를 big-endian 정수로) mod 10^6, 6자리 0 채움. 즉 ((T[0]<<12)|(T[1]<<4)|(T[2]>>4)) % 1e6
 * - 코드 B = (T 의 비트 20..39) mod 10^6, 6자리 0 채움.              즉 (((T[2]&0x0f)<<16)|(T[3]<<8)|T[4]) % 1e6
 *
 * 채널(§4-4)
 * - hello 서명 입력   = lp("ainecto-e2e-v1/hello")   ‖ lp(pcId) ‖ lp(channel) ‖ lp(eB) ‖ lp(nB)            — 브라우저 키가 서명
 * - welcome 서명 입력 = lp("ainecto-e2e-v1/welcome") ‖ lp(pcId) ‖ lp(channel) ‖ lp(eB) ‖ lp(nB) ‖ lp(eP)  — PC 키가 서명
 * - 공유 비밀 Z = ECDH(임시 키, 상대 임시 공개키) 의 x 좌표 32바이트(WebCrypto `deriveBits(…, 256)`).
 * - salt = SHA-256(welcome 서명 입력)   (= 대화 기록 hash — 양쪽 임시 공개키·nB·채널·pcId 를 모두 덮는다)
 * - 웹→PC 키 = HKDF-SHA256(Z, salt, info = "ainecto-e2e-v1/key/browser-to-pc", 32바이트)
 * - PC→웹 키 = HKDF-SHA256(Z, salt, info = "ainecto-e2e-v1/key/pc-to-browser", 32바이트)
 *
 * 메시지(AES-256-GCM, 태그 16바이트 — 암호문 뒤에 붙는다, WebCrypto 그대로)
 * - 카운터: 방향마다 1 부터 1씩. 받는 쪽은 마지막으로 받은 값보다 큰 것만 받는다(재전송·되감기 거절). 최대 2^53-1.
 * - nonce(12바이트) = 0x00000000 ‖ u64be(카운터)
 * - AAD = lp("ainecto-e2e-v1/msg") ‖ lp(channel) ‖ lp(type) ‖ lp(session) ‖ u64be(카운터)   (세션이 없는 종류는 session = "")
 */

const subtle = webcrypto.subtle;
type CryptoKey = webcrypto.CryptoKey;

const PAIR_LABEL = "ainecto-pair-v1";
const HELLO_LABEL = "ainecto-e2e-v1/hello";
const WELCOME_LABEL = "ainecto-e2e-v1/welcome";
const KEY_INFO_BROWSER_TO_PC = "ainecto-e2e-v1/key/browser-to-pc";
const KEY_INFO_PC_TO_BROWSER = "ainecto-e2e-v1/key/pc-to-browser";
const MESSAGE_LABEL = "ainecto-e2e-v1/msg";

export const PUBLIC_KEY_BYTES = 65;
export const NONCE_SEED_BYTES = 32;
export const SIGNATURE_BYTES = 64;
/** 짝짓기 코드 자릿수(설계 §9 C-E1 — 6자리 × 2). */
export const PAIR_CODE_DIGITS = 6;

/** E2E 오류 — 코드가 붙는다. 다리·pair 명령이 이 코드로 거절 사유를 남긴다. */
export class E2eError extends Error {
  constructor(
    readonly code: "E2E_BAD_INPUT" | "E2E_COMMITMENT_MISMATCH" | "E2E_COUNTER_REJECTED" | "E2E_DECRYPT_FAILED",
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

/** 길이(u32 big-endian) ‖ 바이트. 문자열은 UTF-8 로. */
function lp(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === "string" ? utf8(value) : value;
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, false);
  out.set(bytes, 4);
  return out;
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

/** 비압축 점 65바이트 → JWK. (곡선 위 점인지는 import 가 본다.) */
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

// ── 짝짓기(§4-2) ────────────────────────────────────────────────

/** 1단계 약속값 = SHA-256(pcPub ‖ nP). */
export async function pairCommitment(pcPublicRaw: Uint8Array, nP: Uint8Array): Promise<Uint8Array> {
  expectLength("pcPub", pcPublicRaw, PUBLIC_KEY_BYTES);
  expectLength("nP", nP, NONCE_SEED_BYTES);
  return await sha256(concatBytes(pcPublicRaw, nP));
}

/** 3단계(브라우저) — 드러낸 pcPub·nP 가 1단계 약속값과 같지 않으면 E2E_COMMITMENT_MISMATCH. */
export async function assertCommitment(commit: Uint8Array, pcPublicRaw: Uint8Array, nP: Uint8Array): Promise<void> {
  const expected = await pairCommitment(pcPublicRaw, nP);
  if (commit.length !== expected.length || !expected.every((byte, index) => byte === commit[index])) {
    throw new E2eError("E2E_COMMITMENT_MISMATCH", "The PC's revealed key does not match its commitment — pairing aborted.");
  }
}

export interface PairTranscriptInput {
  pcId: string;
  pcPublicRaw: Uint8Array;
  browserPublicRaw: Uint8Array;
  nP: Uint8Array;
  nB: Uint8Array;
}

/** T = SHA-256(lp(label) ‖ lp(pcId) ‖ lp(pcPub) ‖ lp(browserPub) ‖ lp(nP) ‖ lp(nB)). */
export async function pairTranscript(input: PairTranscriptInput): Promise<Uint8Array> {
  expectLength("pcPub", input.pcPublicRaw, PUBLIC_KEY_BYTES);
  expectLength("browserPub", input.browserPublicRaw, PUBLIC_KEY_BYTES);
  expectLength("nP", input.nP, NONCE_SEED_BYTES);
  expectLength("nB", input.nB, NONCE_SEED_BYTES);
  return await sha256(concatBytes(lp(PAIR_LABEL), lp(input.pcId), lp(input.pcPublicRaw), lp(input.browserPublicRaw), lp(input.nP), lp(input.nB)));
}

export interface PairCodes {
  /** PC 가 보이고 사람이 브라우저에 친다. */
  a: string;
  /** 브라우저가 보이고 사람이 PC 에 친다. */
  b: string;
}

/** T → 코드 A(비트 0..19) · 코드 B(비트 20..39), 각각 mod 10^6 · 6자리 0 채움. */
export function pairCodes(transcript: Uint8Array): PairCodes {
  if (transcript.length < 5) {
    throw new E2eError("E2E_BAD_INPUT", "transcript hash is too short.");
  }
  const t = (index: number): number => transcript[index] ?? 0;
  const first = (t(0) << 12) | (t(1) << 4) | (t(2) >> 4);
  const second = ((t(2) & 0x0f) << 16) | (t(3) << 8) | t(4);
  const code = (value: number): string => String(value % 10 ** PAIR_CODE_DIGITS).padStart(PAIR_CODE_DIGITS, "0");
  return { a: code(first), b: code(second) };
}

// ── 채널(§4-4) ──────────────────────────────────────────────────

export interface HelloFields {
  pcId: string;
  channel: string;
  /** 브라우저 임시 ECDH 공개키 65바이트. */
  eB: Uint8Array;
  /** 브라우저 무작위 32바이트. */
  nB: Uint8Array;
}

function helloBody(hello: HelloFields): Uint8Array[] {
  expectLength("eB", hello.eB, PUBLIC_KEY_BYTES);
  expectLength("nB", hello.nB, NONCE_SEED_BYTES);
  return [lp(hello.pcId), lp(hello.channel), lp(hello.eB), lp(hello.nB)];
}

/** 브라우저 키가 서명하는 바이트. */
export function helloSignatureInput(hello: HelloFields): Uint8Array {
  return concatBytes(lp(HELLO_LABEL), ...helloBody(hello));
}

/** PC 키가 서명하는 바이트(= HKDF salt 의 원문). */
export function welcomeSignatureInput(hello: HelloFields, eP: Uint8Array): Uint8Array {
  expectLength("eP", eP, PUBLIC_KEY_BYTES);
  return concatBytes(lp(WELCOME_LABEL), ...helloBody(hello), lp(eP));
}

/** 방향별 채널 키 원본(32바이트씩) — {@link importMessageKey} 로 AES-GCM 키가 된다. */
export interface ChannelSecrets {
  browserToPc: Uint8Array;
  pcToBrowser: Uint8Array;
}

/**
 * ECDH(자기 임시 키, 상대 임시 공개키) → HKDF-SHA256(salt = SHA-256(welcome 서명 입력)) → 두 방향 키.
 * PC 는 (자기 eP 비공개, eB) · 브라우저는 (자기 eB 비공개, eP) 로 부르고 같은 값을 얻는다.
 */
export async function deriveChannelSecrets(input: {
  own: CryptoKey;
  peerPublicRaw: Uint8Array;
  hello: HelloFields;
  eP: Uint8Array;
}): Promise<ChannelSecrets> {
  expectLength("peer ephemeral key", input.peerPublicRaw, PUBLIC_KEY_BYTES);
  let peer: CryptoKey;
  try {
    peer = await subtle.importKey("raw", input.peerPublicRaw, ECDH, false, []);
  } catch {
    throw new E2eError("E2E_BAD_INPUT", "peer ephemeral key is not a valid P-256 point.");
  }
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: peer }, input.own, 256));
  const salt = await sha256(welcomeSignatureInput(input.hello, input.eP));
  const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const derive = async (info: string): Promise<Uint8Array> =>
    new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: utf8(info) }, ikm, 256));
  return { browserToPc: await derive(KEY_INFO_BROWSER_TO_PC), pcToBrowser: await derive(KEY_INFO_PC_TO_BROWSER) };
}

export async function importMessageKey(secret: Uint8Array): Promise<CryptoKey> {
  expectLength("message key", secret, 32);
  return await subtle.importKey("raw", secret, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// ── 메시지 ──────────────────────────────────────────────────────

/** 카운터 상한 — JS 정수가 정확한 끝. */
export const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

/** AAD 에 들어가는 메시지 머리. type 은 frame·input·create 같은 종류 이름, 세션이 없으면 session = "". */
export interface MessageHeader {
  channel: string;
  type: string;
  session: string;
  counter: number;
}

function assertCounter(counter: number): void {
  if (!Number.isSafeInteger(counter) || counter < 1 || counter > MAX_COUNTER) {
    throw new E2eError("E2E_COUNTER_REJECTED", `counter must be an integer from 1 to ${MAX_COUNTER}.`);
  }
}

export function messageNonce(counter: number): Uint8Array {
  assertCounter(counter);
  return concatBytes(new Uint8Array(4), u64be(counter));
}

export function messageAad(header: MessageHeader): Uint8Array {
  assertCounter(header.counter);
  return concatBytes(lp(MESSAGE_LABEL), lp(header.channel), lp(header.type), lp(header.session), u64be(header.counter));
}

/** 보내는 쪽 — 카운터는 부르는 쪽이 방향마다 1 부터 늘린다(같은 키·같은 카운터를 두 번 쓰지 않는다). */
export async function sealMessage(key: CryptoKey, header: MessageHeader, plaintext: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: messageNonce(header.counter), additionalData: messageAad(header), tagLength: 128 },
    key, plaintext));
}

/**
 * 받는 쪽 — 카운터가 lastSeen 보다 커야 하고(재전송·되감기 거절), 태그가 맞아야 한다(본문·머리 변조 거절).
 * 성공하면 새 lastSeen(= 이 카운터). 실패하면 채널을 버리고 hello 부터(설계 §4-4).
 */
export async function openMessage(key: CryptoKey, header: MessageHeader, ciphertext: Uint8Array, lastSeen: number)
  : Promise<{ plaintext: Uint8Array; lastSeen: number }> {
  assertCounter(header.counter);
  if (header.counter <= lastSeen) {
    throw new E2eError("E2E_COUNTER_REJECTED", `counter ${header.counter} is not after ${lastSeen} (replayed or reordered).`);
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle.decrypt({ name: "AES-GCM", iv: messageNonce(header.counter), additionalData: messageAad(header), tagLength: 128 },
      key, ciphertext);
  } catch {
    throw new E2eError("E2E_DECRYPT_FAILED", "message failed authentication (wrong key, header or ciphertext).");
  }
  return { plaintext: new Uint8Array(plaintext), lastSeen: header.counter };
}
