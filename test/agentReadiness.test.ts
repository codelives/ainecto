import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSpawn } from "../src/core/agent/child";
import { claudeCodeAdapter } from "../src/core/agent/claudeCode";
import { codexAdapter } from "../src/core/agent/codex";
import type { AgentLogRecord } from "../src/core/agent/log";
import { checkAgents, openAgents } from "../src/core/agent/readiness";
import { AgentSessionMap } from "../src/core/agent/sessions";
import { DaemonLog } from "../src/core/term/daemonLog";
import { fakeSpawn } from "./support/agentServeWorld";

function world(env: Record<string, string>, spawnImpl: AgentSpawn = fakeSpawn) {
  const dir = mkdtempSync(join(tmpdir(), "agent-ready-"));
  const logPath = join(dir, "agent.log");
  const log = new DaemonLog<AgentLogRecord>(logPath, `${logPath}.1`);
  const shared = { spawnImpl, cwd: dir, env: { ...process.env, ANTHROPIC_API_KEY: "", ...env }, log, writeTools: new Set<string>() };
  const adapters = [
    claudeCodeAdapter({ ...shared, args: () => [] }),
    codexAdapter({ ...shared, appServerArgs: () => ["app-server"], clientVersion: "0.0.0" }),
  ];
  const records = () => readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  return { adapters, log, logPath, records };
}

describe("serve 시작 때 Agent 준비 확인(모델 호출 0)", () => {
  it("둘 다 설치·로그인 — 판 · 준비됨, 확인마다 요청 줄 + 응답 줄 · 계정 식별값은 남기지 않는다", async () => {
    const w = world({});
    const checks = await checkAgents(w.adapters, w.log);
    expect(checks).toEqual([
      { id: "claude-code", installed: true, version: "9.9.9 (Claude Code)", ready: true, auth: "subscription", detail: undefined },
      { id: "codex", installed: true, version: "codex-cli 0.0.0-fake", ready: true, auth: "subscription", detail: undefined },
    ]);
    expect(openAgents(checks)).toEqual([
      { id: "claude-code", ready: true, auth: "subscription" }, { id: "codex", ready: true, auth: "subscription" }]);

    const records = w.records();
    const asked = records.filter((r) => r.event === "agent_probe").map((r) => r.callId);
    expect(asked).toHaveLength(4);
    expect(records.filter((r) => r.event === "agent_probe_response").map((r) => r.callId).sort()).toEqual([...asked].sort());
    expect(records.find((r) => r.event === "agent_probe_response" && r.agent === "codex" && r.probe === "auth"))
      .toMatchObject({ ok: true, ready: true, method: "chatgpt", plan: "pro" });
    expect(records.filter((r) => r.event === "agent_rpc").map((r) => r.method)).toEqual(["initialize", "account/read"]);
    expect(readFileSync(w.logPath, "utf8")).not.toContain("someone@example.com");
  });

  it("로그인 안 됨이면 설치됨 · 준비 안 됨 — open 에는 ready:false 로 싣는다", async () => {
    const w = world({ FAKE_CLAUDE_AUTH: "out", FAKE_CODEX_ACCOUNT: "none" });
    const checks = await checkAgents(w.adapters, w.log);
    expect(checks.map(({ id, installed, ready }) => ({ id, installed, ready }))).toEqual([
      { id: "claude-code", installed: true, ready: false },
      { id: "codex", installed: true, ready: false },
    ]);
    expect(openAgents(checks)).toEqual([{ id: "claude-code", ready: false }, { id: "codex", ready: false }]);
  });

  it("설치되지 않은 Agent 는 open 에서 빠진다(인증 확인도 하지 않는다)", async () => {
    const onlyClaude: AgentSpawn = (command, args, opts) =>
      fakeSpawn(command === "codex" ? "ainecto-no-such-binary-for-test" : command, args, opts);
    const w = world({}, onlyClaude);
    const checks = await checkAgents(w.adapters, w.log);
    expect(checks[1]).toMatchObject({ id: "codex", installed: false, ready: false, detail: "ENOENT" });
    expect(openAgents(checks)).toEqual([{ id: "claude-code", ready: true, auth: "subscription" }]);
    expect(w.records().filter((r) => r.event === "agent_probe" && r.agent === "codex").map((r) => r.probe)).toEqual(["detect"]);
  });
});

describe("인증 방식은 정보 — 구독도 API 키도 준비됨(운영도 구독 허용, 11-14) · 모델 호출 0", () => {
  it("키 변수가 있으면 Claude 는 apiKey(값은 읽지 않는다) · Codex 는 API 키 로그인이면 apiKey — 둘 다 준비됨", async () => {
    const w = world({ ANTHROPIC_API_KEY: "test-placeholder-not-a-key", FAKE_CODEX_ACCOUNT: "apiKey" });
    const checks = await checkAgents(w.adapters, w.log);
    expect(openAgents(checks)).toEqual([{ id: "claude-code", ready: true, auth: "apiKey" }, { id: "codex", ready: true, auth: "apiKey" }]);
    expect(readFileSync(w.logPath, "utf8")).not.toContain("test-placeholder-not-a-key");
  });
});

describe("세션 값 — (대화, Agent) 마다 · 옛 파일과 같이 읽힌다", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "agent-sessions-"));

  it("옛 파일(conversations)은 Claude Code 세션으로 읽고, 다시 써도 그 칸은 그대로", async () => {
    const path = join(dir(), "sessions.json");
    writeFileSync(path, JSON.stringify({ version: 1, conversations: { "conv-a": { sessionId: "sess-1", updatedAt: "x" } } }));
    const map = new AgentSessionMap({ connect: path, room: `${path}.room` });
    expect((await map.read({ conversationUuid: "conv-a" }, "claude-code")).entry?.sessionId).toBe("sess-1");
    expect((await map.read({ conversationUuid: "conv-a" }, "codex")).entry).toBeUndefined();

    expect(await map.write({ conversationUuid: "conv-a" }, "codex", 0, { sessionId: "thr-1" })).toBe("written");
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.conversations["conv-a"].sessionId).toBe("sess-1");
    expect(file.byAgent.codex["conv-a"].sessionId).toBe("thr-1");

    const again = new AgentSessionMap({ connect: path, room: `${path}.room` });
    expect((await again.read({ conversationUuid: "conv-a" }, "codex")).entry?.sessionId).toBe("thr-1");
    expect(await again.write({ conversationUuid: "conv-a" }, "codex", 1, undefined)).toBe("written");
    expect((await again.read({ conversationUuid: "conv-a" }, "codex")).entry).toBeUndefined();
    expect((await again.read({ conversationUuid: "conv-a" }, "claude-code")).entry?.sessionId).toBe("sess-1");
  });

  it("깨진 파일 · 모양이 다른 칸은 버리고 돈다", async () => {
    const path = join(dir(), "sessions.json");
    writeFileSync(path, "{not json");
    const broken = new AgentSessionMap({ connect: path, room: `${path}.room` });
    expect((await broken.read({ conversationUuid: "conv-a" }, "claude-code")).entry).toBeUndefined();

    writeFileSync(path, JSON.stringify({ conversations: { a: { sessionId: 3 }, b: "x" }, byAgent: { codex: { c: { sessionId: "thr" } }, other: {} } }));
    const odd = new AgentSessionMap({ connect: path, room: `${path}.room` });
    expect((await odd.read({ conversationUuid: "a" }, "claude-code")).entry).toBeUndefined();
    expect((await odd.read({ conversationUuid: "c" }, "codex")).entry?.sessionId).toBe("thr");
  });
});

describe("agentStartLine — serve 시작 글(KAN-1613)", () => {
  it("이 PC 에서 못 찾았거나 실행이 안 된 Agent 도 한 줄 — 이유(ENOENT·timed out·exit 1)를 그대로 싣고, 설치·PATH 확인을 안내한다", async () => {
    const { agentStartLine } = await import("../src/core/agent/readiness");
    const missing = agentStartLine({ id: "claude-code", installed: false, ready: false, detail: "spawn claude ENOENT" }, "Claude Code", "Anthropic");
    expect(missing).toContain("Claude Code was not found on this PC, or did not run (spawn claude ENOENT)");
    expect(missing).toContain("check that it is installed where this PC's `ainecto` can run it (PATH)");
    expect(missing).toContain("`ainecto stop`, then `ainecto start`");
    expect(agentStartLine({ id: "claude-code", installed: false, ready: false, detail: "timed out" }, "Claude Code", "Anthropic"))
      .toContain("(timed out)");
  });

  it("준비됨 줄은 전과 같고, 준비 안 됨은 «로그인 안 됨»으로 단정하지 않고 요청은 준비될 때까지 기다린다(리뷰 r1 P0-3·P1-2)", async () => {
    const { agentStartLine } = await import("../src/core/agent/readiness");
    expect(agentStartLine({ id: "codex", installed: true, ready: true, auth: "subscription" }, "Codex", "OpenAI"))
      .toBe("Codex: runs on your subscription login (uses your plan's limits; AiNecto credits are not used).");
    expect(agentStartLine({ id: "codex", installed: true, ready: true, auth: "apiKey" }, "Codex", "OpenAI"))
      .toBe("Codex: runs on your own API key (billed to your OpenAI API account; AiNecto credits are not used).");
    const notReady = agentStartLine({ id: "claude-code", installed: true, ready: false, detail: "auth status timed out" }, "Claude Code", "Anthropic");
    expect(notReady).toBe("Claude Code is installed, but it could not be confirmed as ready (auth status timed out). Requests to Claude Code "
      + "wait until it is ready — check its sign-in on this PC, then reconnect this PC (`ainecto stop`, then `ainecto start`).");
    expect(notReady).not.toContain("refused");
  });

  it("serve_start 의 Agent 칸은 검사 결과 + 같은 줄 — `ainecto start` 터미널은 이번 시작 뒤의 serve_start 줄만 옮긴다(리뷰 r1 P0-1)", async () => {
    const { agentStartRecords } = await import("../src/core/agent/readiness");
    const { serveStartLines } = await import("../src/core/agent/log");
    const records = agentStartRecords([
      { id: "claude-code", installed: false, ready: false, detail: "spawn claude ENOENT" },
      { id: "codex", installed: true, ready: true, auth: "subscription", version: "0.9" },
    ], (id) => (id === "codex" ? "Codex" : "Claude Code"), () => "Anthropic");
    expect(records.map(({ id, installed, detail }) => ({ id, installed, detail }))).toEqual([
      { id: "claude-code", installed: false, detail: "spawn claude ENOENT" }, { id: "codex", installed: true, detail: undefined },
    ]);
    expect(records[0]?.line).toContain("Claude Code was not found on this PC, or did not run (spawn claude ENOENT)");
    const log = [
      JSON.stringify({ ts: "2026-11-27T01:00:00.000Z", event: "serve_start", agents: [{ id: "codex", line: "old run" }] }),
      JSON.stringify({ ts: "2026-11-27T02:00:00.000Z", event: "serve_start", agents: records }),
      JSON.stringify({ ts: "2026-11-27T02:00:01.000Z", event: "serve_stop", reason: "no_agents" }),
      "{half a line",
    ].join("\n");
    expect(serveStartLines(log, "2026-11-27T01:30:00.000Z")).toEqual(records.map((r) => r.line));
    expect(serveStartLines(log, "2026-11-27T03:00:00.000Z"), "이번 시작 전 기록은 옮기지 않는다").toEqual([]);
    expect(serveStartLines("", "2026-11-27T00:00:00.000Z")).toEqual([]);
  });
});
