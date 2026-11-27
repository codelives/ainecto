import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** PC 가 올린 봉인 화면(§14-4) — 서버는 c 를 모른다. */
export interface WireFrame { linkId: string; channelId: string; session: string; cols: number; rows: number; n: number; c: string }

/**
 * api PC 계약(설계 terminal-e2e §14 · A1~A7 — open·sessions·poll·frame·answer·close·welcome·channel/close)의 대역 — 프로세스 안 실제 HTTP.
 * poll 은 붙잡았다가 항목·상태가 바뀌면 깬다. open 마다 새 linkId·토큰 · 다른(또는 재시작으로 잊은) linkId·토큰이면 404 REMOTE_NOT_FOUND.
 * ★서버처럼 암호문을 해석하지 않는다 — 웹 쪽(시험 브라우저, support/fakeWeb)이 항목을 밀어 넣고 결과를 읽는다.
 */
export class FakeRemoteServer {
  server!: Server;
  endpoint = "";
  readonly calls: Array<{ op: string; token?: string; body: Record<string, unknown>; raw: string }> = [];
  readonly frames: WireFrame[] = [];
  readonly answers: Array<Record<string, unknown>> = [];
  /** channelId → PC 가 보낸 welcome 본문({welcome} 또는 {refuse}). */
  readonly welcomes = new Map<string, Record<string, unknown>>();
  /** PC 가 닫은 채널(channel/close). */
  readonly closedByPc: Array<{ channelId: string; reason: string }> = [];
  linkId = "";
  linkToken = "";
  remote = "on";
  /** PC 가 마지막으로 올린 목록(open·sessions). */
  listed: Array<Record<string, unknown>> = [];
  private known = false;
  /** 채널마다 보는 세션 — watch 항목은 늘 전체 목록(A1). */
  private readonly watching = new Map<string, string[]>();
  private items: Array<Record<string, unknown>> = [];
  private closedReason: string | undefined;
  private readonly replies: string[] = [];
  pollError: { status: number; code: string } | undefined;
  /** 있으면 sessions 를 이 오류로 거절한다(일시 장애 흉내 — 끝 기록은 책에 남아야 한다). */
  sessionsError: { status: number; code: string } | undefined;
  /** 이 수만큼 sessions 를 답 없이 붙잡는다(목록 올리기가 막힌 동안 다리의 마지막 목록이 낡은 채로 남게). */
  hangSessions = 0;
  /** 화면 밖 본문 상한(api C4) — open 답 limits.bodyMaxBytes 로 알리고, 넘으면 413 BODY_TOO_LARGE {maxBytes}. */
  bodyMaxBytes = 64 * 1024;
  /** 다음 open 을 이 오류로 거절한다(옛 서버 흉내 — 400 INVALID). */
  openError: { status: number; code: string } | undefined;
  /**
   * 옛 서버 흉내 — open 에 이 칸 중 하나라도 있으면 400 INVALID(없으면 받는다).
   * 직전 api(devices 는 알고 images 는 모름) = ["images"] · 그 전 api = ["devices", "images"].
   */
  refuseFields: string[] = [];
  /** npm 꼬리표(계약 1절) — 있으면 OPEN poll 응답에 cli 칸으로. */
  cli: Record<string, string> | undefined;
  hangPolls = 0;
  private held: Array<{ wake: () => void; res: ServerResponse }> = [];
  private hanging: ServerResponse[] = [];

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => this.handle(req, res, body));
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", () => done()));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/mcp`;
  }

  async stop(): Promise<void> {
    for (const res of this.hanging) res.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  /** poll 항목을 넣는다(hello·cmd·channel-closed) — 받은 순서 그대로 넘긴다. */
  push(item: Record<string, unknown>): void {
    this.items.push(item);
    this.wake();
  }

  /** 한 채널이 보는 세션을 바꾼다 — 전체 목록을 watch 항목 하나로. */
  watch(channelId: string, ...sessions: string[]): void {
    this.watching.set(channelId, sessions);
    this.push({ type: "watch", channels: [...this.watching].flatMap(([id, names]) => names.map((session) => ({ channelId: id, session }))) });
  }

  /** 웹이 채널을 닫았다(A2). */
  webClose(channelId: string): void {
    this.watching.delete(channelId);
    this.push({ type: "channel-closed", channelId });
  }

  webOff(): void { this.remote = "off-by-web"; this.wake(); }
  replace(): void { this.closedReason = "REPLACED"; this.wake(); }
  /** api 재시작 — 링크를 잊고 붙잡힌 poll 의 연결은 끊긴다. */
  restart(): void {
    this.known = false;
    this.watching.clear();
    const held = this.held;
    this.held = [];
    for (const { res } of held) res.destroy();
  }
  ops(): string[] { return this.calls.map((call) => call.op); }
  listedNames(): string[] { return this.listed.map((s) => String(s.name)); }
  answerFor(requestId: string): Record<string, unknown> | undefined { return this.answers.find((a) => a.requestId === requestId); }
  closedReasonOf(channelId: string): string | undefined { return this.closedByPc.find((c) => c.channelId === channelId)?.reason; }
  /** PC 와 주고받은 모든 HTTP 본문(요청·응답) — 표지 문자열 검사용. */
  wireText(): string { return [...this.calls.map((call) => call.raw), ...this.replies].join("\n"); }

  private wake(): void {
    const held = this.held;
    this.held = [];
    for (const { wake } of held) wake();
  }

  private handle(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const op = (req.url ?? "").replace("/mcp/term/pc/", "");
    const body = JSON.parse(raw) as Record<string, unknown>;
    const token = req.headers["x-remote-token"];
    this.calls.push({ op, token: typeof token === "string" ? token : undefined, body, raw });
    const reply = (status: number, out: unknown) => {
      const text = JSON.stringify(out);
      this.replies.push(text);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(text);
    };
    if (op !== "frame" && Buffer.byteLength(raw, "utf8") > this.bodyMaxBytes) {
      reply(413, { code: "BODY_TOO_LARGE", message: "too large", maxBytes: this.bodyMaxBytes });
      return;
    }
    if (op !== "open" && (!this.known || body.linkId !== this.linkId || token !== this.linkToken)) {
      reply(404, { code: "REMOTE_NOT_FOUND", message: "No such open remote terminal." });
      return;
    }
    switch (op) {
      case "open":
        if (this.openError) {
          reply(this.openError.status, { code: this.openError.code, message: "refused" });
          return;
        }
        if (this.refuseFields.some((field) => body[field] !== undefined)) {
          reply(400, { code: "INVALID", message: "Invalid request body." });
          return;
        }
        this.linkId = randomUUID();
        this.linkToken = `tok-${randomUUID()}`;
        this.known = true;
        this.closedReason = undefined;
        this.items = [];
        this.remote = body.remoteEnabled === true ? "on" : "off-by-pc";
        this.listed = body.sessions as Array<Record<string, unknown>>;
        reply(201, { linkId: this.linkId, linkToken: this.linkToken,
          limits: { pollHoldSeconds: 1, frameMaxBytes: 1024 * 1024, bodyMaxBytes: this.bodyMaxBytes } });
        return;
      case "sessions":
        if (this.hangSessions > 0) {
          this.hangSessions -= 1;
          this.hanging.push(res);
          return;
        }
        if (this.sessionsError) {
          reply(this.sessionsError.status, { code: this.sessionsError.code, message: "unavailable" });
          return;
        }
        this.listed = body.sessions as Array<Record<string, unknown>>;
        reply(200, {});
        return;
      case "poll": {
        if (this.hangPolls > 0) {
          this.hangPolls -= 1;
          this.hanging.push(res);
          return;
        }
        const answer = () => {
          if (this.pollError) reply(this.pollError.status, { code: this.pollError.code, message: "refused" });
          else if (this.closedReason) reply(200, { state: "CLOSED", reason: this.closedReason });
          else reply(200, { state: "OPEN", remote: this.remote, commands: this.items.splice(0), ...(this.cli ? { cli: this.cli } : {}) });
        };
        if (this.pollError || this.closedReason || this.items.length > 0) {
          answer();
          return;
        }
        const timer = setTimeout(() => {
          this.held = this.held.filter((h) => h.wake !== wakeUp);
          answer();
        }, 1_000);
        const wakeUp = () => {
          clearTimeout(timer);
          answer();
        };
        this.held.push({ wake: wakeUp, res });
        return;
      }
      case "frame":
        this.frames.push({ linkId: String(body.linkId), channelId: String(body.channelId), session: String(body.session), cols: Number(body.cols),
          rows: Number(body.rows), n: Number(body.n), c: String(body.c) });
        reply(200, { version: this.frames.length });
        return;
      case "answer":
        this.answers.push(body);
        reply(200, {});
        return;
      case "welcome":
        this.welcomes.set(String(body.channelId), body);
        reply(200, {});
        return;
      case "channel/close":
        this.closedByPc.push({ channelId: String(body.channelId), reason: String(body.reason) });
        this.watching.delete(String(body.channelId));
        reply(200, {});
        return;
      case "close":
        reply(200, {});
        return;
      default:
        reply(404, { code: "NOPE" });
    }
  }
}
