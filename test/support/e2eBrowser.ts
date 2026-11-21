import type { PairedBrowser } from "../../src/core/pc/pcKeys";
import {
  browserKeyIdOf,
  channelTranscript,
  deriveChannelSecrets,
  generateEphemeral,
  generateSigningJwk,
  helloSignatureInput,
  importMessageKey,
  importSigningKey,
  openMessage,
  publicJwkOf,
  publicRawFromJwk,
  randomBytes,
  sealMessage,
  signBytes,
  verifyBytes,
  type EcPrivateJwk,
  type EcPublicJwk,
} from "../../src/core/term/e2e";

/**
 * 시험용 브라우저 한 벌 — ★진짜 암호(e2e.ts)로 front 가 할 일을 그대로 한다: 장기 키 · hello 서명 · welcome 검증 · 채널 키 · 봉인/열기.
 * 장부(ChannelBook) 단위 시험과 가짜 서버 왕복 시험이 같이 쓴다.
 */
export class TestBrowser {
  private constructor(
    readonly key: EcPrivateJwk,
    readonly keyId: string,
    readonly name: string,
  ) {}

  static async create(name = "Chrome · macOS"): Promise<TestBrowser> {
    const key = await generateSigningJwk();
    return new TestBrowser(key, await browserKeyIdOf(publicRawFromJwk(key)), name);
  }

  /** PC 쪽 pc-keys.json 에 넣을 핀. */
  paired(pairedAt = "2026-11-21T09:00:00.000Z"): PairedBrowser {
    return { keyId: this.keyId, publicJwk: publicJwkOf(this.key), name: this.name, pairedAt };
  }

  /** hello 한 장(A4)과 welcome 을 받아 채널을 여는 함수. */
  async hello(input: { userId: string; pcId: string; tab: string; signWith?: EcPrivateJwk }): Promise<{
    hello: { channel: string; eB: string; nB: string; browserKeyId: string; sig: string };
    finish(welcome: { eP: string; nP: string; sig: string }, pcPublic: EcPublicJwk): Promise<BrowserChannel>;
  }> {
    const ephemeral = await generateEphemeral();
    const nB = randomBytes(32);
    const fields = { userId: input.userId, pcId: input.pcId, channel: input.tab, browserKeyId: this.keyId, eB: ephemeral.publicRaw, nB };
    const sig = await signBytes(await importSigningKey(input.signWith ?? this.key), helloSignatureInput(fields));
    return {
      hello: { channel: input.tab, eB: b64u(ephemeral.publicRaw), nB: b64u(nB), browserKeyId: this.keyId, sig: b64u(sig) },
      finish: async (welcome, pcPublic) => {
        const eP = fromB64u(welcome.eP);
        const nP = fromB64u(welcome.nP);
        const transcript = await channelTranscript({
          hello: fields, pcPublicRaw: publicRawFromJwk(pcPublic), browserPublicRaw: publicRawFromJwk(this.key), eP, nP,
        });
        if (!(await verifyBytes(pcPublic, fromB64u(welcome.sig), transcript))) throw new Error("welcome signature did not verify");
        const secrets = await deriveChannelSecrets({ own: ephemeral.privateKey, peerPublicRaw: eP, transcript });
        return new BrowserChannel(input.pcId, secrets.connId, await importMessageKey(secrets.browserToPc), await importMessageKey(secrets.pcToBrowser));
      },
    };
  }
}

/** 선 위 cmd 칸(A3) — channelId·requestId 는 부르는 쪽이 붙인다. */
export interface SealedCmd {
  n: number;
  c: string;
  kind: string;
  session?: string;
  opId?: string;
  projectUuid?: string;
}

export interface CmdMeta {
  session?: string;
  opId?: string;
  projectUuid?: string;
}

/** 브라우저 쪽 채널 — 웹→PC 번호는 0(confirm)부터 하나씩. */
export class BrowserChannel {
  private next = 0;

  constructor(
    readonly pcId: string,
    readonly connId: Uint8Array,
    private readonly b2p: Awaited<ReturnType<typeof importMessageKey>>,
    private readonly p2b: Awaited<ReturnType<typeof importMessageKey>>,
  ) {}

  /** 봉인 — aad 를 주면 선 위 칸(meta)과 다른 AAD 로 봉인한다(바꿔치기 시험). */
  async seal(kind: string, body: unknown, meta: CmdMeta = {}, options: { n?: number; aad?: CmdMeta } = {}): Promise<SealedCmd> {
    const n = options.n ?? this.next++;
    const aad = options.aad ?? meta;
    const sealed = await sealMessage(this.b2p, {
      type: kind, connId: this.connId, pcId: this.pcId, session: aad.session ?? "", operationId: aad.opId ?? "", projectUuid: aad.projectUuid ?? "",
      counter: n,
    }, new TextEncoder().encode(JSON.stringify(body)));
    return { n, c: b64u(sealed), kind, ...meta };
  }

  /** 번호 하나를 건너뛴다(그 번호의 poll 응답을 잃은 것과 같다 — PC 는 받지 못한다). */
  skip(): number {
    return this.next++;
  }

  /** PC→웹 열기 — frame(session) · answer(session·opId·projectUuid). */
  async open(kind: "frame" | "answer", n: number, c: string, meta: CmdMeta): Promise<Record<string, unknown>> {
    const { plaintext } = await openMessage(this.p2b, {
      type: kind, connId: this.connId, pcId: this.pcId, session: meta.session ?? "", operationId: meta.opId ?? "", projectUuid: meta.projectUuid ?? "",
      counter: n,
    }, fromB64u(c), { order: "increasing", next: 0 });
    return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
  }
}

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromB64u(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}
