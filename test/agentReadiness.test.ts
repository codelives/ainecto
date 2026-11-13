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
  const shared = { spawnImpl, cwd: dir, env: { ...process.env, ...env }, log, writeTools: new Set<string>() };
  const adapters = [
    claudeCodeAdapter({ ...shared, args: () => [] }),
    codexAdapter({ ...shared, appServerArgs: ["app-server"], clientVersion: "0.0.0" }),
  ];
  const records = () => readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  return { adapters, log, logPath, records };
}

describe("serve 시작 때 Agent 준비 확인(모델 호출 0)", () => {
  it("둘 다 설치·로그인 — 판 · 준비됨, 확인마다 요청 줄 + 응답 줄 · 계정 식별값은 남기지 않는다", async () => {
    const w = world({});
    const checks = await checkAgents(w.adapters, w.log);
    expect(checks).toEqual([
      { id: "claude-code", installed: true, version: "9.9.9 (Claude Code)", ready: true, detail: undefined },
      { id: "codex", installed: true, version: "codex-cli 0.0.0-fake", ready: true, detail: undefined },
    ]);
    expect(openAgents(checks)).toEqual([{ id: "claude-code", ready: true }, { id: "codex", ready: true }]);

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
    expect(openAgents(checks)).toEqual([{ id: "claude-code", ready: true }]);
    expect(w.records().filter((r) => r.event === "agent_probe" && r.agent === "codex").map((r) => r.probe)).toEqual(["detect"]);
  });
});

describe("세션 값 — (대화, Agent) 마다 · 옛 파일과 같이 읽힌다", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "agent-sessions-"));

  it("옛 파일(conversations)은 Claude Code 세션으로 읽고, 다시 써도 그 칸은 그대로", async () => {
    const path = join(dir(), "sessions.json");
    writeFileSync(path, JSON.stringify({ version: 1, conversations: { "conv-a": { sessionId: "sess-1", updatedAt: "x" } } }));
    const map = new AgentSessionMap(path);
    await map.load();
    expect(map.get("conv-a", "claude-code")).toBe("sess-1");
    expect(map.get("conv-a", "codex")).toBeUndefined();

    await map.set("conv-a", "codex", "thr-1");
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.conversations["conv-a"].sessionId).toBe("sess-1");
    expect(file.byAgent.codex["conv-a"].sessionId).toBe("thr-1");

    const again = new AgentSessionMap(path);
    await again.load();
    expect(again.get("conv-a", "codex")).toBe("thr-1");
    await again.forget("conv-a", "codex");
    expect(again.get("conv-a", "codex")).toBeUndefined();
    expect(again.get("conv-a", "claude-code")).toBe("sess-1");
  });

  it("깨진 파일 · 모양이 다른 칸은 버리고 돈다", async () => {
    const path = join(dir(), "sessions.json");
    writeFileSync(path, "{not json");
    const broken = new AgentSessionMap(path);
    await broken.load();
    expect(broken.get("conv-a", "claude-code")).toBeUndefined();

    writeFileSync(path, JSON.stringify({ conversations: { a: { sessionId: 3 }, b: "x" }, byAgent: { codex: { c: { sessionId: "thr" } }, other: {} } }));
    const odd = new AgentSessionMap(path);
    await odd.load();
    expect(odd.get("a", "claude-code")).toBeUndefined();
    expect(odd.get("c", "codex")).toBe("thr");
  });
});
