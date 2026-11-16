import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AgentCallError, createAgentHttp } from "../src/core/agent/http";
import type { AgentLogRecord } from "../src/core/agent/log";
import { DaemonLog } from "../src/core/term/daemonLog";

/** ★실제 HTTP 서버 — 요청 1줄 + 응답 1줄(같은 callId)이 성공·4xx·네트워크 실패 모두에 남는가. */
describe("agentCall — PC ↔ 서버 한 입구", () => {
  let server: Server;
  let endpoint: string;
  const seen: Array<{ url?: string; auth?: string; link?: string; body: string }> = [];
  let handler: (req: IncomingMessage, body: string) => { status: number; body: unknown };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url: req.url, auth: req.headers.authorization, link: req.headers["x-link-token"] as string | undefined, body });
        const out = handler(req, body);
        res.writeHead(out.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => server.close());
  beforeEach(() => (seen.length = 0));

  function world() {
    const logPath = join(mkdtempSync(join(tmpdir(), "agent-http-")), "agent.log");
    let refreshed = 0;
    const http = createAgentHttp({
      endpoint,
      log: new DaemonLog<AgentLogRecord>(logPath, `${logPath}.1`),
      tokenProvider: {
        getAccessToken: async () => "old",
        refreshAfterUnauthorized: async () => {
          refreshed += 1;
          return "new";
        },
      },
    });
    const records = () => readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    return { http, records, refreshed: () => refreshed };
  }

  it("성공 — /mcp/agent/pc/<op> · Bearer · link 토큰 · 요청·응답 줄 한 쌍(본문 0)", async () => {
    handler = () => ({ status: 200, body: { state: "OPEN", offers: [{ turnUuid: "t" }] } });
    const w = world();
    w.http.useLinkToken("link-secret");
    const res = await w.http.call("poll", { linkId: "l" }, { turnUuid: "t" });
    expect(res.state).toBe("OPEN");
    expect(seen[0]).toMatchObject({ url: "/mcp/agent/pc/poll", auth: "Bearer old", link: "link-secret", body: '{"linkId":"l"}' });
    const [req, resp] = w.records();
    expect(req).toMatchObject({ event: "agent_call", op: "poll", turnUuid: "t", bytes: 14 });
    expect(resp).toMatchObject({ event: "agent_call_response", op: "poll", ok: true, status: 200, offers: 1, callId: req?.callId });
    expect(JSON.stringify(w.records())).not.toContain("link-secret");
  });

  it("401 이면 로그인을 한 번 새로 받아 다시 보낸다", async () => {
    handler = (req) => req.headers.authorization === "Bearer new" ? { status: 200, body: {} } : { status: 401, body: {} };
    const w = world();
    await w.http.call("open", { hostName: "h", cliVersion: "v" });
    expect(w.refreshed()).toBe(1);
    expect(seen.map((s) => s.auth)).toEqual(["Bearer old", "Bearer new"]);
    expect(seen[0]?.link).toBeUndefined();
  });

  it("4xx — 서버 code 를 싣고 다시 하지 않는다 · 응답 줄에 status·code", async () => {
    handler = () => ({ status: 404, body: { code: "LINK_NOT_FOUND", message: "No such agent link." } });
    const w = world();
    const error = await w.http.call("reply", { linkId: "l" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentCallError);
    expect(error).toMatchObject({ status: 404, code: "LINK_NOT_FOUND", retryable: false, message: "No such agent link." });
    expect(w.records()[1]).toMatchObject({ event: "agent_call_response", ok: false, status: 404, code: "LINK_NOT_FOUND" });
  });

  it("네트워크 실패도 응답 줄은 남는다(이유 포함) · 다시 해 볼 만한 실패", async () => {
    const logPath = join(mkdtempSync(join(tmpdir(), "agent-http-")), "agent.log");
    const http = createAgentHttp({
      endpoint: "http://127.0.0.1:1/mcp",
      log: new DaemonLog<AgentLogRecord>(logPath, `${logPath}.1`),
      tokenProvider: { getAccessToken: async () => "t", refreshAfterUnauthorized: async () => "t" },
    });
    const error = await http.call("open", {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ retryable: true });
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ event: "agent_call_response", ok: false });
    expect(String(lines[1]?.error)).not.toBe("");
  });
});
