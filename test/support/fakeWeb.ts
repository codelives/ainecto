import { randomUUID } from "node:crypto";
import { loadPcKeys, updatePcKeys, withBrowser } from "../../src/core/pc/pcKeys";
import { generateSigningJwk, publicJwkOf } from "../../src/core/term/e2e";
import { TestBrowser, type BrowserChannel, type CmdMeta, type SealedCmd } from "./e2eBrowser";
import type { FakeRemoteServer } from "./fakeRemoteServer";

/** 웹이 연 화면 한 장(복호한 것). */
export interface OpenedFrame {
  session: string;
  n: number;
  cols: number;
  rows: number;
  text: string;
  modes?: Record<string, boolean>;
  instance: string;
  executedThrough: number;
}

/**
 * 웹 쪽 대역 = 시험 브라우저(진짜 암호) + 가짜 서버. front 가 할 일을 그대로 한다 — hello → welcome 검증 → confirm → 봉인 명령 → 화면·답 열기.
 * pc-keys.json 에 이 브라우저를 핀해 두는 것(PC 앞 짝짓기의 결과)도 여기서 한다.
 */
export class FakeWeb {
  private constructor(
    readonly fake: FakeRemoteServer,
    readonly browser: TestBrowser,
    private readonly ids: { userId: string; pcId: string; keysPath: string; accountKey: string },
  ) {}

  static async create(fake: FakeRemoteServer, ids: { userId: string; pcId: string; keysPath: string; accountKey: string },
    options: { pin?: boolean; name?: string } = {}): Promise<FakeWeb> {
    const browser = await TestBrowser.create(options.name);
    const web = new FakeWeb(fake, browser, ids);
    if (options.pin !== false) await web.pin();
    return web;
  }

  /** PC 앞 짝짓기의 결과 — 이 계정의 PC 키(없으면 새로)와 이 브라우저 핀. */
  async pin(): Promise<void> {
    const pcKey = (await loadPcKeys(this.ids.keysPath)).accounts[this.ids.accountKey]?.pcKey ?? await generateSigningJwk();
    await updatePcKeys(this.ids.keysPath, (keys) => withBrowser(keys, this.ids.accountKey, pcKey, this.browser.paired()));
  }

  /** hello 를 넣고 welcome 을 기다린다 — 거절이면 {refused}. confirm 은 하지 않는다. */
  async hello(tab: string = randomUUID()): Promise<WebChannel | { refused: string; channelId: string } | { closed: string; channelId: string }> {
    const channelId = randomUUID();
    const started = await this.browser.hello({ userId: this.ids.userId, pcId: this.ids.pcId, tab });
    this.fake.push({ type: "hello", channelId, hello: started.hello });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const answer = this.fake.welcomes.get(channelId);
      if (answer) {
        if (typeof answer.refuse === "string") return { refused: answer.refuse, channelId };
        const pcKey = (await loadPcKeys(this.ids.keysPath)).accounts[this.ids.accountKey]?.pcKey;
        if (!pcKey) throw new Error("no PC key");
        return new WebChannel(this.fake, channelId, await started.finish(answer.welcome as never, publicJwkOf(pcKey)));
      }
      const closed = this.fake.closedReasonOf(channelId);
      if (closed) return { closed, channelId };
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error("no welcome");
  }

  /** hello → welcome → confirm 까지. */
  async connect(tab: string = randomUUID()): Promise<WebChannel> {
    const channel = await this.hello(tab);
    if (!(channel instanceof WebChannel)) throw new Error(`hello was not welcomed: ${JSON.stringify(channel)}`);
    await channel.confirm();
    return channel;
  }
}

export class WebChannel {
  private readonly opened = new Map<number, OpenedFrame>();

  constructor(
    readonly fake: FakeRemoteServer,
    readonly id: string,
    readonly channel: BrowserChannel,
  ) {}

  /** 봉인한 명령을 넣는다 — CRUD 는 서버 상관 id(requestId)를 붙여 돌려준다. */
  push(sealed: SealedCmd, requestId?: string): void {
    this.fake.push({ type: "cmd", channelId: this.id, ...sealed, ...(requestId ? { requestId } : {}) });
  }

  async send(kind: string, body: unknown, meta: CmdMeta = {}, requestId?: string): Promise<SealedCmd> {
    const sealed = await this.channel.seal(kind, body, meta);
    this.push(sealed, requestId);
    return sealed;
  }

  async confirm(): Promise<void> {
    await this.send("confirm", {});
  }

  watch(...sessions: string[]): void {
    this.fake.watch(this.id, ...sessions);
  }

  async input(session: string, instance: string, text: string): Promise<SealedCmd> {
    return await this.send("input", { session, instance, d: Buffer.from(text, "utf8").toString("base64") }, { session });
  }

  async key(session: string, instance: string, key: string): Promise<SealedCmd> {
    return await this.send("key", { session, instance, key }, { session });
  }

  async resize(session: string, instance: string, cols: number, rows: number): Promise<SealedCmd> {
    return await this.send("resize", { session, instance, cols, rows }, { session });
  }

  /** 만들기 — {opId, requestId, meta}. */
  async create(body: { name: string; projectUuid?: string; cwd?: string; command?: string }): Promise<Crud> {
    const opId = randomUUID();
    const requestId = randomUUID();
    const meta = { session: body.name, opId, ...(body.projectUuid ? { projectUuid: body.projectUuid } : {}) };
    await this.send("create", { opId, ...body }, meta, requestId);
    return { opId, requestId, meta };
  }

  async kill(session: string, instance: string): Promise<Crud> {
    const opId = randomUUID();
    const requestId = randomUUID();
    await this.send("kill", { opId, session, instance }, { session, opId }, requestId);
    return { opId, requestId, meta: { session, opId } };
  }

  async label(session: string, instance: string, label: string): Promise<Crud> {
    const opId = randomUUID();
    const requestId = randomUUID();
    await this.send("label", { opId, session, instance, label }, { session, opId }, requestId);
    return { opId, requestId, meta: { session, opId } };
  }

  /** 이 채널에 온 화면 전부(복호) — 순서대로. */
  async frames(): Promise<OpenedFrame[]> {
    const mine = this.fake.frames.filter((frame) => frame.channelId === this.id);
    for (const frame of mine) {
      if (this.opened.has(frame.n)) continue;
      const body = await this.channel.open("frame", frame.n, frame.c, { session: frame.session });
      this.opened.set(frame.n, {
        session: frame.session, n: frame.n, cols: frame.cols, rows: frame.rows,
        text: Buffer.from(String(body.d), "base64").toString("utf8"),
        ...(body.modes ? { modes: body.modes as Record<string, boolean> } : {}),
        instance: String(body.instance),
        executedThrough: Number(body.executedThrough),
      });
    }
    return [...this.opened.values()].sort((a, b) => a.n - b.n);
  }

  async latest(session: string): Promise<OpenedFrame | undefined> {
    return (await this.frames()).filter((frame) => frame.session === session).at(-1);
  }

  /** CRUD 답 — 바깥(서버가 보는 것)과 봉인 본문(복호). 아직 없으면 undefined. */
  async answer(crud: Crud): Promise<{ outer: Record<string, unknown>; sealed: Record<string, unknown> } | undefined> {
    const outer = this.fake.answerFor(crud.requestId);
    if (!outer) return undefined;
    return { outer, sealed: await this.channel.open("answer", Number(outer.n), String(outer.c), crud.meta) };
  }

  closedReason(): string | undefined {
    return this.fake.closedReasonOf(this.id);
  }
}

export interface Crud {
  opId: string;
  requestId: string;
  meta: CmdMeta;
}
