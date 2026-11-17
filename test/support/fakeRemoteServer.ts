import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Frame { linkId: string; session: string; cols: number; rows: number; text: string; modes?: Record<string, boolean> }

/**
 * api PC 계약(open·sessions·poll·frame·answer·close)의 대역 — 프로세스 안 실제 HTTP. poll 은 붙잡았다가 명령·보기·상태가 바뀌면 깬다.
 * open 마다 새 linkId·토큰 · 다른(또는 재시작으로 잊은) linkId·토큰이면 404 REMOTE_NOT_FOUND(서버와 같다).
 */
export class FakeRemoteServer {
  server!: Server;
  endpoint = "";
  readonly calls: Array<{ op: string; token?: string; body: Record<string, unknown> }> = [];
  readonly frames: Frame[] = [];
  readonly answers: Array<Record<string, unknown>> = [];
  linkId = "";
  linkToken = "";
  remote = "on";
  /** PC 가 마지막으로 올린 목록(open·sessions). */
  listed: Array<Record<string, unknown>> = [];
  private known = false;
  private watching: string[] = [];
  private commands: Array<Record<string, unknown>> = [];
  private closedReason: string | undefined;
  pollError: { status: number; code: string } | undefined;
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

  watch(...names: string[]): void { this.watching = names; this.wake(); }
  input(session: string, text: string): void { this.push({ type: "input", session, d: Buffer.from(text).toString("base64") }); }
  key(session: string, key: string): void { this.push({ type: "key", session, key }); }
  resize(session: string, cols: number, rows: number): void { this.push({ type: "resize", session, cols, rows }); }
  create(name: string, extra: Record<string, unknown> = {}): string { return this.request({ type: "create", name, ...extra }); }
  kill(session: string): string { return this.request({ type: "kill", session }); }
  label(session: string, label: string): string { return this.request({ type: "label", session, label }); }
  webOff(): void { this.remote = "off-by-web"; this.wake(); }
  replace(): void { this.closedReason = "REPLACED"; this.wake(); }
  /** api 재시작 — 링크를 잊고 붙잡힌 poll 의 연결은 끊긴다. */
  restart(): void {
    this.known = false;
    const held = this.held;
    this.held = [];
    for (const { res } of held) res.destroy();
  }
  ops(): string[] { return this.calls.map((call) => call.op); }
  listedNames(): string[] { return this.listed.map((s) => String(s.name)); }
  answerFor(requestId: string): Record<string, unknown> | undefined { return this.answers.find((a) => a.requestId === requestId); }

  private request(command: Record<string, unknown>): string {
    const requestId = randomUUID();
    this.push({ ...command, requestId });
    return requestId;
  }

  private push(command: Record<string, unknown>): void {
    this.commands.push(command);
    this.wake();
  }

  private wake(): void {
    const held = this.held;
    this.held = [];
    for (const { wake } of held) wake();
  }

  private handle(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const op = (req.url ?? "").replace("/mcp/term/pc/", "");
    const body = JSON.parse(raw) as Record<string, unknown>;
    const token = req.headers["x-remote-token"];
    this.calls.push({ op, token: typeof token === "string" ? token : undefined, body });
    const reply = (status: number, out: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    };
    if (op !== "open" && (!this.known || body.linkId !== this.linkId || token !== this.linkToken)) {
      reply(404, { code: "REMOTE_NOT_FOUND", message: "No such open remote terminal." });
      return;
    }
    switch (op) {
      case "open":
        this.linkId = randomUUID();
        this.linkToken = `tok-${randomUUID()}`;
        this.known = true;
        this.closedReason = undefined;
        this.remote = body.remoteEnabled === true ? "on" : "off-by-pc";
        this.listed = body.sessions as Array<Record<string, unknown>>;
        reply(201, { linkId: this.linkId, linkToken: this.linkToken,
          limits: { pollHoldSeconds: 1, frameMaxBytes: 1024 * 1024, bodyMaxBytes: 64 * 1024 } });
        return;
      case "sessions":
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
          else reply(200, { state: "OPEN", remote: this.remote, watching: this.watching, commands: this.commands.splice(0) });
        };
        if (this.pollError || this.closedReason || this.commands.length > 0) {
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
        this.frames.push({ linkId: String(body.linkId), session: String(body.session), cols: Number(body.cols), rows: Number(body.rows),
          text: Buffer.from(String(body.d), "base64").toString("utf8"),
          ...(body.modes ? { modes: body.modes as Record<string, boolean> } : {}) });
        reply(200, { version: this.frames.length });
        return;
      case "answer":
        this.answers.push(body);
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
