import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  asPrivateJwk,
  assertCommitment,
  channelTranscript,
  deriveChannelSecrets,
  E2eError,
  generateEphemeral,
  generateSigningJwk,
  helloSignatureInput,
  importEphemeral,
  importMessageKey,
  importSigningKey,
  messageAad,
  messageNonce,
  openMessage,
  pairCodeFromBlock,
  pairCodes,
  pairCommitment,
  pairDoneInput,
  pairTranscript,
  publicJwkFromRaw,
  publicJwkOf,
  publicRawFromJwk,
  sealMessage,
  signBytes,
  verifyBytes,
  type EcPrivateJwk,
  type HelloFields,
  type MessageHeader,
  type ReceiveState,
  browserKeyIdOf,
  pairCodeInput,
  type PairCodeInput,
  MAX_MESSAGES_PER_KEY,
  transcriptUserId,
} from "../src/core/term/e2e";

/** ★front 와 같은 파일 — 기준(golden)이다. 구현을 고쳐서 이 값을 맞추지, 이 파일을 다시 만들지 않는다. */
interface VectorHeader { type: string; session: string; operationId: string; projectUuid: string; counter: number; connIdHex: string; pcId: string }
interface Vectors {
  keys: { pcSigning: EcPrivateJwk; browserSigning: EcPrivateJwk; pcPublicRawHex: string; browserPublicRawHex: string };
  pairing: {
    userId: string; pcId: string; nPHex: string; nBHex: string; commitHex: string; transcriptHex: string;
    codeBlockAHex: string; codeBlockBHex: string; codeA: string; codeB: string; doneSignatureInputHex: string; doneSignatureHex: string;
  };
  codeBlockExamples: Array<{ blockHex: string; code: string | null }>;
  keyIdExamples: Array<{ label: string; publicRawHex: string; keyId: string }>;
  codeInputExamples: Array<{ input: string; result: PairCodeInput }>;
  userIdExamples: Array<{ label: string; rawUserId: string; transcriptUserId: string; transcriptHex: string; a: string; b: string }>;
  channel: {
    userId: string; pcId: string; channel: string; browserKeyId: string; browserEphemeral: EcPrivateJwk; pcEphemeral: EcPrivateJwk;
    eBHex: string; ePHex: string; nBHex: string; nPPrimeHex: string; helloSignatureInputHex: string; helloSignatureHex: string;
    transcriptHex: string; welcomeSignatureHex: string; browserToPcKeySha256Hex: string; pcToBrowserKeySha256Hex: string; connIdHex: string;
  };
  messages: Array<{ direction: "browser-to-pc" | "pc-to-browser"; header: VectorHeader; plaintextUtf8: string; nonceHex: string; aadHex: string; ciphertextHex: string }>;
}

const V = JSON.parse(readFileSync(new URL("./fixtures/e2e-vectors.v1.json", import.meta.url), "utf8")) as Vectors;
const bytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");
const sha256Hex = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 주석의 enc(u16be 길이 ‖ 바이트)를 구현과 따로 — front 가 읽고 따라 할 정의가 맞는지 본다. */
const enc = (...fields: Array<Uint8Array | string>): Buffer => Buffer.concat(fields.map((field) => {
  const value = typeof field === "string" ? Buffer.from(field, "utf8") : Buffer.from(field);
  const head = Buffer.alloc(2);
  head.writeUInt16BE(value.length);
  return Buffer.concat([head, value]);
}));

function hello(): HelloFields {
  const c = V.channel;
  return { userId: c.userId, pcId: c.pcId, channel: c.channel, browserKeyId: c.browserKeyId, eB: bytes(c.eBHex), nB: bytes(c.nBHex) };
}

function header(vector: VectorHeader): MessageHeader {
  return { type: vector.type, connId: bytes(vector.connIdHex), pcId: vector.pcId, session: vector.session, operationId: vector.operationId,
    projectUuid: vector.projectUuid, counter: vector.counter };
}

async function vectorSecrets(side: "pc" | "browser") {
  const eB = await importEphemeral(V.channel.browserEphemeral);
  const eP = await importEphemeral(V.channel.pcEphemeral);
  const transcript = bytes(V.channel.transcriptHex);
  return side === "pc"
    ? deriveChannelSecrets({ own: eP.privateKey, peerPublicRaw: eB.publicRaw, transcript })
    : deriveChannelSecrets({ own: eB.privateKey, peerPublicRaw: eP.publicRaw, transcript });
}

async function expectCode(promise: Promise<unknown>, code: E2eError["code"]): Promise<void> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(E2eError);
  expect(error instanceof E2eError ? error.code : undefined).toBe(code);
}

const exact = (next: number): ReceiveState => ({ order: "exact", next });
const increasing = (next: number): ReceiveState => ({ order: "increasing", next });

describe("E2E 시험 벡터 v1 — CLI·front 가 같은 바이트를 낸다(설계 r3 §12 > §11)", () => {
  it("키: JWK ↔ 비압축 점 65바이트", () => {
    expect(hex(publicRawFromJwk(V.keys.pcSigning))).toBe(V.keys.pcPublicRawHex);
    expect(hex(publicRawFromJwk(V.keys.browserSigning))).toBe(V.keys.browserPublicRawHex);
    expect(publicJwkFromRaw(bytes(V.keys.pcPublicRawHex))).toEqual(publicJwkOf(V.keys.pcSigning));
  });

  it("짝짓기: 약속값 · T · 코드 블록(HKDF-Expand) · 코드 A/B · done 입력이 벡터와 같다 — 주석 규칙을 손으로 다시 만든 값과도 같다", async () => {
    const p = V.pairing;
    const pcPub = bytes(V.keys.pcPublicRawHex);
    const browserPub = bytes(V.keys.browserPublicRawHex);
    const nP = bytes(p.nPHex);
    const nB = bytes(p.nBHex);
    expect(hex(await pairCommitment(pcPub, nP))).toBe(p.commitHex);
    const T = await pairTranscript({ userId: p.userId, pcId: p.pcId, pcPublicRaw: pcPub, browserPublicRaw: browserPub, nP, nB });
    expect(hex(T)).toBe(p.transcriptHex);
    expect(await pairCodes(T)).toEqual({ a: p.codeA, b: p.codeB });
    expect(hex(pairDoneInput(T))).toBe(p.doneSignatureInputHex);

    expect(sha256Hex(Buffer.concat([pcPub, nP]))).toBe(p.commitHex);
    expect(sha256Hex(enc("ainecto-pair-v1", p.userId, p.pcId, pcPub, browserPub, nP, nB))).toBe(p.transcriptHex);
    const block = (info: string): Buffer => createHmac("sha256", T).update(Buffer.concat([Buffer.from(info), Buffer.of(1)])).digest();
    expect(hex(block("ainecto-pair-code-A"))).toBe(p.codeBlockAHex);
    expect(hex(block("ainecto-pair-code-B"))).toBe(p.codeBlockBHex);
    expect(pairCodeFromBlock(bytes(p.codeBlockAHex))).toBe(p.codeA);
    expect(pairCodeFromBlock(bytes(p.codeBlockBHex))).toBe(p.codeB);
    expect(hex(enc("ainecto-pair-v1/done", T))).toBe(p.doneSignatureInputHex);
    expect(await verifyBytes(publicJwkOf(V.keys.pcSigning), bytes(p.doneSignatureHex), bytes(p.doneSignatureInputHex))).toBe(true);
  });

  it("코드 블록 거절 샘플링: v < 4294000000 인 첫 u32 · mod 10^6 · 6자리 0 채움 · 8개 모두 넘으면 없음", () => {
    for (const example of V.codeBlockExamples) {
      expect(pairCodeFromBlock(bytes(example.blockHex)) ?? null).toBe(example.code);
    }
    expect(V.codeBlockExamples.map((example) => example.code)).toEqual(["000005", "999999", "234567", null]);
  });

  it("브라우저 키 id = SHA-256(공개키 65바이트) 앞 16바이트 소문자 hex · hello 의 키 id 도 그 값", async () => {
    for (const example of V.keyIdExamples) {
      expect(await browserKeyIdOf(bytes(example.publicRawHex))).toBe(example.keyId);
      expect(sha256Hex(bytes(example.publicRawHex)).slice(0, 32)).toBe(example.keyId);
    }
    expect(V.channel.browserKeyId).toBe(await browserKeyIdOf(bytes(V.keys.browserPublicRawHex)));
  });

  it("코드 입력 규칙(A·B 같은 규칙): 앞뒤 공백만 지움 · 비면 취소 · 정확히 ASCII 숫자 6개만 · 하이픈·가운데 공백·전각 숫자는 불일치", () => {
    for (const example of V.codeInputExamples) {
      expect(pairCodeInput(example.input)).toEqual(example.result);
    }
    expect(V.codeInputExamples.find((example) => example.input === "123-456")?.result).toEqual({ kind: "invalid" });
    expect(V.codeInputExamples.find((example) => example.input === "")?.result).toEqual({ kind: "empty" });
  });

  it("userId: 서버 주소 없이 UUID 소문자 36자 — 대문자로 온 값도 같은 바이트 · UUID 가 아니면 E2E_BAD_INPUT", async () => {
    const p = V.pairing;
    for (const example of V.userIdExamples) {
      expect(transcriptUserId(example.rawUserId)).toBe(example.transcriptUserId);
      const T = await pairTranscript({ userId: transcriptUserId(example.rawUserId), pcId: p.pcId, pcPublicRaw: bytes(V.keys.pcPublicRawHex),
        browserPublicRaw: bytes(V.keys.browserPublicRawHex), nP: bytes(p.nPHex), nB: bytes(p.nBHex) });
      expect(hex(T)).toBe(example.transcriptHex);
      expect(await pairCodes(T)).toEqual({ a: example.a, b: example.b });
    }
    expect(() => transcriptUserId("https://ainecto.com/mcp#5b1f2c9e-0a7d-4e63-8f41-9c2d7b6a3e10")).toThrow(E2eError);
    await expectCode(pairTranscript({ userId: "5B1F2C9E-0A7D-4E63-8F41-9C2D7B6A3E10", pcId: p.pcId, pcPublicRaw: bytes(V.keys.pcPublicRawHex),
      browserPublicRaw: bytes(V.keys.browserPublicRawHex), nP: bytes(p.nPHex), nB: bytes(p.nBHex) }), "E2E_BAD_INPUT");
  });

  it("hello·welcome: 서명 입력·H 가 같고, 저장된 서명이 검증된다(ECDSA 는 무작위라 같음이 아니라 verify)", async () => {
    const c = V.channel;
    expect(hex(helloSignatureInput(hello()))).toBe(c.helloSignatureInputHex);
    expect(hex(enc("ainecto-e2e-v1", "browser", "hello", c.userId, c.pcId, c.channel, c.browserKeyId, bytes(c.eBHex), bytes(c.nBHex))))
      .toBe(c.helloSignatureInputHex);
    const pcPub = bytes(V.keys.pcPublicRawHex);
    const browserPub = bytes(V.keys.browserPublicRawHex);
    const H = await channelTranscript({ hello: hello(), pcPublicRaw: pcPub, browserPublicRaw: browserPub, eP: bytes(c.ePHex), nP: bytes(c.nPPrimeHex) });
    expect(hex(H)).toBe(c.transcriptHex);
    expect(sha256Hex(enc("ainecto-e2e-v1", c.userId, c.pcId, c.channel, c.browserKeyId, pcPub, browserPub,
      bytes(c.eBHex), bytes(c.nBHex), bytes(c.ePHex), bytes(c.nPPrimeHex)))).toBe(c.transcriptHex);
    expect(await verifyBytes(publicJwkOf(V.keys.browserSigning), bytes(c.helloSignatureHex), bytes(c.helloSignatureInputHex))).toBe(true);
    expect(await verifyBytes(publicJwkOf(V.keys.pcSigning), bytes(c.welcomeSignatureHex), H)).toBe(true);
    // 새로 만든 서명도 64바이트 P1363 이고 검증된다.
    const fresh = await signBytes(await importSigningKey(V.keys.browserSigning), helloSignatureInput(hello()));
    expect(fresh.length).toBe(64);
    expect(await verifyBytes(publicJwkOf(V.keys.browserSigning), fresh, helloSignatureInput(hello()))).toBe(true);
  });

  it("채널 키: 양쪽이 같은 두 방향 키·연결 id 를 얻고, 벡터와 같다", async () => {
    const pc = await vectorSecrets("pc");
    const browser = await vectorSecrets("browser");
    expect([hex(pc.browserToPc), hex(pc.pcToBrowser), hex(pc.connId)]).toEqual([hex(browser.browserToPc), hex(browser.pcToBrowser), hex(browser.connId)]);
    expect(hex(pc.browserToPc)).not.toBe(hex(pc.pcToBrowser));
    expect(sha256Hex(pc.browserToPc)).toBe(V.channel.browserToPcKeySha256Hex);
    expect(sha256Hex(pc.pcToBrowser)).toBe(V.channel.pcToBrowserKeySha256Hex);
    expect(hex(pc.connId)).toBe(V.channel.connIdHex);
  });

  it("메시지: nonce·AAD·암호문이 벡터와 같고 되푼다(웹→PC 는 0 부터 정확히 하나씩)", async () => {
    const secrets = await vectorSecrets("browser");
    let toPc = exact(0);
    for (const message of V.messages) {
      const h = header(message.header);
      const key = await importMessageKey(message.direction === "browser-to-pc" ? secrets.browserToPc : secrets.pcToBrowser);
      expect(hex(messageNonce(h.counter))).toBe(message.nonceHex);
      expect(hex(messageAad(h))).toBe(message.aadHex);
      expect(hex(enc("ainecto-e2e-v1", h.type, h.connId, h.pcId, h.session, h.operationId, h.projectUuid, bytes(message.nonceHex).subarray(4))))
        .toBe(message.aadHex);
      expect(hex(await sealMessage(key, h, utf8(message.plaintextUtf8)))).toBe(message.ciphertextHex);
      const state = message.direction === "browser-to-pc" ? toPc : increasing(0);
      const opened = await openMessage(key, h, bytes(message.ciphertextHex), state);
      expect(new TextDecoder().decode(opened.plaintext)).toBe(message.plaintextUtf8);
      expect(opened.state.next).toBe(h.counter + 1);
      if (message.direction === "browser-to-pc") toPc = opened.state;
    }
    expect(toPc).toEqual(exact(3));
  });
});

describe("E2E 거절 — 약속값·서명·카운터·AAD", () => {
  it("약속값과 다른 pcPub·nP 는 E2E_COMMITMENT_MISMATCH", async () => {
    const commit = bytes(V.pairing.commitHex);
    await expect(assertCommitment(commit, bytes(V.keys.pcPublicRawHex), bytes(V.pairing.nPHex))).resolves.toBeUndefined();
    await expectCode(assertCommitment(commit, bytes(V.keys.browserPublicRawHex), bytes(V.pairing.nPHex)), "E2E_COMMITMENT_MISMATCH");
    const otherNonce = bytes(V.pairing.nPHex);
    otherNonce[0] = (otherNonce[0] ?? 0) ^ 1;
    await expectCode(assertCommitment(commit, bytes(V.keys.pcPublicRawHex), otherNonce), "E2E_COMMITMENT_MISMATCH");
  });

  it("T 의 칸이 하나라도 다르면(userId 포함) 코드가 달라진다", async () => {
    const p = V.pairing;
    const input = { userId: p.userId, pcId: p.pcId, pcPublicRaw: bytes(V.keys.pcPublicRawHex), browserPublicRaw: bytes(V.keys.browserPublicRawHex),
      nP: bytes(p.nPHex), nB: bytes(p.nBHex) };
    const other = await pairCodes(await pairTranscript({ ...input, userId: "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d" }));
    expect(other).not.toEqual({ a: p.codeA, b: p.codeB });
  });

  it("서명 위조·다른 키·다른 채널·다른 브라우저 키 id 는 false", async () => {
    const browser = publicJwkOf(V.keys.browserSigning);
    const input = bytes(V.channel.helloSignatureInputHex);
    const signature = bytes(V.channel.helloSignatureHex);
    const tampered = signature.slice();
    tampered[10] = (tampered[10] ?? 0) ^ 0x01;
    expect(await verifyBytes(browser, tampered, input)).toBe(false);
    expect(await verifyBytes(publicJwkOf(V.keys.pcSigning), signature, input)).toBe(false);
    expect(await verifyBytes(browser, signature, helloSignatureInput({ ...hello(), channel: "tab-other" }))).toBe(false);
    expect(await verifyBytes(browser, signature, helloSignatureInput({ ...hello(), browserKeyId: "other" }))).toBe(false);
    expect(await verifyBytes(browser, signature.subarray(0, 63), input)).toBe(false);
  });

  it("웹→PC(exact): 재전송·되감기·건너뛰기 모두 E2E_COUNTER_REJECTED · 실패해도 상태는 그대로", async () => {
    const key = await importMessageKey((await vectorSecrets("pc")).browserToPc);
    const [confirm, input] = V.messages;
    if (!confirm || !input) throw new Error("vector message missing");
    const first = await openMessage(key, header(confirm.header), bytes(confirm.ciphertextHex), exact(0));
    expect(first.state).toEqual(exact(1));
    await expectCode(openMessage(key, header(confirm.header), bytes(confirm.ciphertextHex), first.state), "E2E_COUNTER_REJECTED");
    await expectCode(openMessage(key, header(input.header), bytes(input.ciphertextHex), exact(0)), "E2E_COUNTER_REJECTED");
    await expectCode(openMessage(key, header(input.header), bytes(input.ciphertextHex), exact(2)), "E2E_COUNTER_REJECTED");
    expect((await openMessage(key, header(input.header), bytes(input.ciphertextHex), first.state)).state).toEqual(exact(2));
    await expectCode(sealMessage(key, { ...header(input.header), counter: 1.5 }, utf8("x")), "E2E_COUNTER_REJECTED");
    await expectCode(sealMessage(key, { ...header(input.header), counter: -1 }, utf8("x")), "E2E_COUNTER_REJECTED");
    // 방향 키당 2^32 개(C-E4) — 마지막 번호까지는 쓰고, 그다음은 새 hello.
    expect(MAX_MESSAGES_PER_KEY).toBe(2 ** 32);
    expect(hex(messageNonce(MAX_MESSAGES_PER_KEY - 1))).toBe("0000000000000000ffffffff");
    await expectCode(sealMessage(key, { ...header(input.header), counter: MAX_MESSAGES_PER_KEY }, utf8("x")), "E2E_COUNTER_REJECTED");
  });

  it("PC→웹(increasing): 건너뛰기는 받고, 같은 값·작은 값은 거절", async () => {
    const key = await importMessageKey((await vectorSecrets("browser")).pcToBrowser);
    const frame = V.messages.find((item) => item.direction === "pc-to-browser");
    if (!frame) throw new Error("vector message missing");
    const opened = await openMessage(key, header(frame.header), bytes(frame.ciphertextHex), increasing(5));
    expect(opened.state).toEqual(increasing(301));
    await expectCode(openMessage(key, header(frame.header), bytes(frame.ciphertextHex), opened.state), "E2E_COUNTER_REJECTED");
  });

  it("AAD(종류·연결 id·pcId·세션·연산 ID·projectUuid·카운터)나 본문이 하나라도 다르면 E2E_DECRYPT_FAILED · 다른 방향 키로도 실패", async () => {
    const secrets = await vectorSecrets("pc");
    const key = await importMessageKey(secrets.browserToPc);
    const create = V.messages.find((item) => item.header.type === "create");
    if (!create) throw new Error("vector message missing");
    const h = header(create.header);
    const ciphertext = bytes(create.ciphertextHex);
    const otherConn = h.connId.slice();
    otherConn[0] = (otherConn[0] ?? 0) ^ 1;
    for (const changed of [
      { ...h, type: "input" },
      { ...h, connId: otherConn },
      { ...h, pcId: "other-pc" },
      { ...h, session: "other" },
      { ...h, operationId: "" },
      { ...h, projectUuid: "" },
      { ...h, counter: h.counter + 1 },
    ]) {
      await expectCode(openMessage(key, changed, ciphertext, increasing(0)), "E2E_DECRYPT_FAILED");
    }
    const flipped = ciphertext.slice();
    flipped[0] = (flipped[0] ?? 0) ^ 0x80;
    await expectCode(openMessage(key, h, flipped, increasing(0)), "E2E_DECRYPT_FAILED");
    await expectCode(openMessage(await importMessageKey(secrets.pcToBrowser), h, ciphertext, increasing(0)), "E2E_DECRYPT_FAILED");
  });

  it("새 키·새 임시 키로 한 바퀴 — 저장 가능한 JWK 모양이고 양쪽 키가 맞물린다 · 곡선 밖 점은 E2E_BAD_INPUT", async () => {
    const pcKey = await generateSigningJwk();
    expect(asPrivateJwk(pcKey)).toEqual(pcKey);
    const eB = await generateEphemeral();
    const eP = await generateEphemeral();
    const transcript = new Uint8Array(32).fill(9);
    const pc = await deriveChannelSecrets({ own: eP.privateKey, peerPublicRaw: eB.publicRaw, transcript });
    const browser = await deriveChannelSecrets({ own: eB.privateKey, peerPublicRaw: eP.publicRaw, transcript });
    expect(hex(pc.pcToBrowser)).toBe(hex(browser.pcToBrowser));
    const h: MessageHeader = { type: "frame", connId: pc.connId, pcId: "pc", session: "s", operationId: "", projectUuid: "", counter: 0 };
    const sealed = await sealMessage(await importMessageKey(pc.pcToBrowser), h, utf8("hi"));
    expect(new TextDecoder().decode((await openMessage(await importMessageKey(browser.pcToBrowser), h, sealed, increasing(0))).plaintext)).toBe("hi");
    const offCurve = eB.publicRaw.slice();
    offCurve[64] = (offCurve[64] ?? 0) ^ 1;
    await expectCode(deriveChannelSecrets({ own: eP.privateKey, peerPublicRaw: offCurve, transcript }), "E2E_BAD_INPUT");
    expect(() => publicJwkFromRaw(new Uint8Array(65))).toThrow(E2eError);
    expect(asPrivateJwk({ ...pcKey, d: "short" })).toBeUndefined();
  });
});
