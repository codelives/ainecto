import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  asPrivateJwk,
  assertCommitment,
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
  pairCodes,
  pairCommitment,
  pairTranscript,
  publicJwkFromRaw,
  publicJwkOf,
  publicRawFromJwk,
  sealMessage,
  signBytes,
  verifyBytes,
  welcomeSignatureInput,
  type EcPrivateJwk,
  type HelloFields,
  type MessageHeader,
} from "../src/core/term/e2e";

/** ★front 와 같은 파일 — 기준(golden)이다. 구현을 고쳐서 이 값을 맞추지, 이 파일을 다시 만들지 않는다. */
interface Vectors {
  keys: { pcSigning: EcPrivateJwk; browserSigning: EcPrivateJwk; pcPublicRawHex: string; browserPublicRawHex: string };
  pairing: { pcId: string; nPHex: string; nBHex: string; commitHex: string; transcriptHex: string; codeA: string; codeB: string };
  channel: {
    pcId: string; channel: string; browserEphemeral: EcPrivateJwk; pcEphemeral: EcPrivateJwk; eBHex: string; ePHex: string; nBHex: string;
    helloSignatureInputHex: string; helloSignatureHex: string; welcomeSignatureInputHex: string; welcomeSignatureHex: string;
    saltHex: string; browserToPcKeySha256Hex: string; pcToBrowserKeySha256Hex: string;
  };
  messages: Array<{ direction: "browser-to-pc" | "pc-to-browser"; header: MessageHeader; plaintextUtf8: string; nonceHex: string; aadHex: string; ciphertextHex: string }>;
}

const V = JSON.parse(readFileSync(new URL("./fixtures/e2e-vectors.v1.json", import.meta.url), "utf8")) as Vectors;
const bytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");
const sha256Hex = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function hello(): HelloFields {
  return { pcId: V.channel.pcId, channel: V.channel.channel, eB: bytes(V.channel.eBHex), nB: bytes(V.channel.nBHex) };
}

async function vectorSecrets(side: "pc" | "browser") {
  const eB = await importEphemeral(V.channel.browserEphemeral);
  const eP = await importEphemeral(V.channel.pcEphemeral);
  return side === "pc"
    ? deriveChannelSecrets({ own: eP.privateKey, peerPublicRaw: eB.publicRaw, hello: hello(), eP: eP.publicRaw })
    : deriveChannelSecrets({ own: eB.privateKey, peerPublicRaw: eP.publicRaw, hello: hello(), eP: eP.publicRaw });
}

async function expectCode(promise: Promise<unknown>, code: E2eError["code"]): Promise<void> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(E2eError);
  expect((error as E2eError).code).toBe(code);
}

describe("E2E 시험 벡터 v1 — CLI·front 가 같은 바이트를 낸다", () => {
  it("키: JWK ↔ 비압축 점 65바이트", () => {
    expect(hex(publicRawFromJwk(V.keys.pcSigning))).toBe(V.keys.pcPublicRawHex);
    expect(hex(publicRawFromJwk(V.keys.browserSigning))).toBe(V.keys.browserPublicRawHex);
    expect(publicJwkFromRaw(bytes(V.keys.pcPublicRawHex))).toEqual(publicJwkOf(V.keys.pcSigning));
  });

  it("짝짓기: 약속값 · T · 코드 A/B 가 벡터와 같다 — 그리고 머리 주석의 바이트 규칙을 손으로 다시 만든 값과도 같다", async () => {
    const pcPub = bytes(V.keys.pcPublicRawHex);
    const browserPub = bytes(V.keys.browserPublicRawHex);
    const nP = bytes(V.pairing.nPHex);
    const nB = bytes(V.pairing.nBHex);
    expect(hex(await pairCommitment(pcPub, nP))).toBe(V.pairing.commitHex);
    const T = await pairTranscript({ pcId: V.pairing.pcId, pcPublicRaw: pcPub, browserPublicRaw: browserPub, nP, nB });
    expect(hex(T)).toBe(V.pairing.transcriptHex);
    expect(pairCodes(T)).toEqual({ a: V.pairing.codeA, b: V.pairing.codeB });

    // 주석의 규칙(lp = u32be 길이 ‖ 바이트)을 구현과 따로 — front 가 읽고 따라 할 정의가 맞는지.
    const lp = (value: Uint8Array): Buffer => {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(value.length);
      return Buffer.concat([head, value]);
    };
    expect(sha256Hex(Buffer.concat([pcPub, nP]))).toBe(V.pairing.commitHex);
    expect(sha256Hex(Buffer.concat([lp(utf8("ainecto-pair-v1")), lp(utf8(V.pairing.pcId)), lp(pcPub), lp(browserPub), lp(nP), lp(nB)])))
      .toBe(V.pairing.transcriptHex);
  });

  it("hello·welcome: 서명 입력 바이트가 같고, 저장된 서명이 검증된다(ECDSA 는 무작위라 같음이 아니라 verify)", async () => {
    expect(hex(helloSignatureInput(hello()))).toBe(V.channel.helloSignatureInputHex);
    const eP = bytes(V.channel.ePHex);
    expect(hex(welcomeSignatureInput(hello(), eP))).toBe(V.channel.welcomeSignatureInputHex);
    expect(await verifyBytes(publicJwkOf(V.keys.browserSigning), bytes(V.channel.helloSignatureHex), bytes(V.channel.helloSignatureInputHex))).toBe(true);
    expect(await verifyBytes(publicJwkOf(V.keys.pcSigning), bytes(V.channel.welcomeSignatureHex), bytes(V.channel.welcomeSignatureInputHex))).toBe(true);
    // 새로 만든 서명도 64바이트 P1363 이고 검증된다.
    const fresh = await signBytes(await importSigningKey(V.keys.browserSigning), helloSignatureInput(hello()));
    expect(fresh.length).toBe(64);
    expect(await verifyBytes(publicJwkOf(V.keys.browserSigning), fresh, helloSignatureInput(hello()))).toBe(true);
  });

  it("채널 키: 양쪽이 같은 두 방향 키를 얻고, 지문이 벡터와 같다 · salt = SHA-256(welcome 입력)", async () => {
    const pc = await vectorSecrets("pc");
    const browser = await vectorSecrets("browser");
    expect(hex(pc.browserToPc)).toBe(hex(browser.browserToPc));
    expect(hex(pc.pcToBrowser)).toBe(hex(browser.pcToBrowser));
    expect(hex(pc.browserToPc)).not.toBe(hex(pc.pcToBrowser));
    expect(sha256Hex(pc.browserToPc)).toBe(V.channel.browserToPcKeySha256Hex);
    expect(sha256Hex(pc.pcToBrowser)).toBe(V.channel.pcToBrowserKeySha256Hex);
    expect(sha256Hex(bytes(V.channel.welcomeSignatureInputHex))).toBe(V.channel.saltHex);
  });

  it("메시지: nonce·AAD·암호문이 벡터와 같고 되푼다", async () => {
    const secrets = await vectorSecrets("browser");
    for (const message of V.messages) {
      const key = await importMessageKey(message.direction === "browser-to-pc" ? secrets.browserToPc : secrets.pcToBrowser);
      expect(hex(messageNonce(message.header.counter))).toBe(message.nonceHex);
      expect(hex(messageAad(message.header))).toBe(message.aadHex);
      expect(hex(await sealMessage(key, message.header, utf8(message.plaintextUtf8)))).toBe(message.ciphertextHex);
      const opened = await openMessage(key, message.header, bytes(message.ciphertextHex), message.header.counter - 1);
      expect(new TextDecoder().decode(opened.plaintext)).toBe(message.plaintextUtf8);
      expect(opened.lastSeen).toBe(message.header.counter);
    }
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

  it("코드: 앞 20비트·다음 20비트 · mod 10^6 · 6자리 0 채움", () => {
    expect(pairCodes(Uint8Array.of(0x00, 0x00, 0x10, 0x00, 0x02))).toEqual({ a: "000001", b: "000002" });
    // 0xFFFFF = 1048575 → mod 10^6 = 048575
    expect(pairCodes(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff))).toEqual({ a: "048575", b: "048575" });
  });

  it("서명 위조·다른 키·다른 채널은 false", async () => {
    const browser = publicJwkOf(V.keys.browserSigning);
    const input = bytes(V.channel.helloSignatureInputHex);
    const signature = bytes(V.channel.helloSignatureHex);
    const tampered = signature.slice();
    tampered[10] = (tampered[10] ?? 0) ^ 0x01;
    expect(await verifyBytes(browser, tampered, input)).toBe(false);
    expect(await verifyBytes(publicJwkOf(V.keys.pcSigning), signature, input)).toBe(false);
    expect(await verifyBytes(browser, signature, helloSignatureInput({ ...hello(), channel: "tab-other" }))).toBe(false);
    expect(await verifyBytes(browser, signature.subarray(0, 63), input)).toBe(false);
  });

  it("카운터: 같은 값(재전송)·더 작은 값(되감기)·0·정수 아님은 E2E_COUNTER_REJECTED", async () => {
    const key = await importMessageKey((await vectorSecrets("pc")).browserToPc);
    const message = V.messages.find((item) => item.direction === "browser-to-pc" && item.header.counter === 2);
    if (!message) throw new Error("vector message missing");
    const ciphertext = bytes(message.ciphertextHex);
    const opened = await openMessage(key, message.header, ciphertext, 1);
    await expectCode(openMessage(key, message.header, ciphertext, opened.lastSeen), "E2E_COUNTER_REJECTED");
    await expectCode(openMessage(key, message.header, ciphertext, 5), "E2E_COUNTER_REJECTED");
    await expectCode(openMessage(key, { ...message.header, counter: 0 }, ciphertext, -1), "E2E_COUNTER_REJECTED");
    await expectCode(sealMessage(key, { ...message.header, counter: 1.5 }, utf8("x")), "E2E_COUNTER_REJECTED");
  });

  it("AAD(채널·종류·세션·카운터)나 본문이 하나라도 다르면 E2E_DECRYPT_FAILED · 다른 방향 키로도 실패", async () => {
    const secrets = await vectorSecrets("pc");
    const key = await importMessageKey(secrets.browserToPc);
    const message = V.messages[0];
    if (!message) throw new Error("vector message missing");
    const ciphertext = bytes(message.ciphertextHex);
    for (const header of [
      { ...message.header, channel: "tab-other" },
      { ...message.header, type: "frame" },
      { ...message.header, session: "other" },
      { ...message.header, counter: message.header.counter + 1 },
    ]) {
      await expectCode(openMessage(key, header, ciphertext, 0), "E2E_DECRYPT_FAILED");
    }
    const flipped = ciphertext.slice();
    flipped[0] = (flipped[0] ?? 0) ^ 0x80;
    await expectCode(openMessage(key, message.header, flipped, 0), "E2E_DECRYPT_FAILED");
    await expectCode(openMessage(await importMessageKey(secrets.pcToBrowser), message.header, ciphertext, 0), "E2E_DECRYPT_FAILED");
  });

  it("새 키·새 임시 키로 한 바퀴 — 저장 가능한 JWK 모양이고 양쪽 키가 맞물린다", async () => {
    const pcKey = await generateSigningJwk();
    expect(asPrivateJwk(pcKey)).toEqual(pcKey);
    const eB = await generateEphemeral();
    const eP = await generateEphemeral();
    const fields: HelloFields = { pcId: "pc", channel: "tab", eB: eB.publicRaw, nB: new Uint8Array(32).fill(7) };
    const pc = await deriveChannelSecrets({ own: eP.privateKey, peerPublicRaw: eB.publicRaw, hello: fields, eP: eP.publicRaw });
    const browser = await deriveChannelSecrets({ own: eB.privateKey, peerPublicRaw: eP.publicRaw, hello: fields, eP: eP.publicRaw });
    expect(hex(pc.pcToBrowser)).toBe(hex(browser.pcToBrowser));
    const header: MessageHeader = { channel: "tab", type: "frame", session: "s", counter: 1 };
    const sealed = await sealMessage(await importMessageKey(pc.pcToBrowser), header, utf8("hi"));
    expect(new TextDecoder().decode((await openMessage(await importMessageKey(browser.pcToBrowser), header, sealed, 0)).plaintext)).toBe("hi");
    // 곡선 밖 점·모양이 틀린 키는 E2E_BAD_INPUT.
    const offCurve = eB.publicRaw.slice();
    offCurve[64] = (offCurve[64] ?? 0) ^ 1;
    await expectCode(deriveChannelSecrets({ own: eP.privateKey, peerPublicRaw: offCurve, hello: fields, eP: eP.publicRaw }), "E2E_BAD_INPUT");
    expect(() => publicJwkFromRaw(new Uint8Array(65))).toThrow(E2eError);
    expect(asPrivateJwk({ ...pcKey, d: "short" })).toBeUndefined();
  });
});
