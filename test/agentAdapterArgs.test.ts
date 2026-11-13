import { agentEnv, ainectoBridge } from "../src/core/agent/agents";
import { claudeAgentArgs, claudeMcpConfig } from "../src/core/agent/claudeArgs";
import { claudeAuthFromJson } from "../src/core/agent/claudeCode";
import {
  codexAppServerArgs,
  codexAuthFromAccount,
  codexServerRequestAnswer,
  codexThreadResumeParams,
  codexThreadStartParams,
  codexTurnResult,
} from "../src/core/agent/codexArgs";

const bridge = ainectoBridge("/usr/bin/node", "/opt/ainecto/dist/bin/ainecto.js", "https://dev.ainecto.com/mcp");

describe("Codex app-server 고정 설정(실측 그대로)", () => {
  it("AiNecto 브리지 · never · read-only · 쓰기 도구마다 approve — 다른 것은 싣지 않는다", () => {
    expect(codexAppServerArgs(bridge, new Set(["kanban_apply_changes", "create_documents", "bad.name"]))).toEqual([
      "app-server",
      "-c", 'mcp_servers.ainecto.command="/usr/bin/node"',
      "-c", 'mcp_servers.ainecto.args=["/opt/ainecto/dist/bin/ainecto.js","--endpoint","https://dev.ainecto.com/mcp","mcp"]',
      "-c", 'approval_policy="never"',
      "-c", 'sandbox_mode="read-only"',
      "-c", 'mcp_servers.ainecto.tools.create_documents.approval_mode="approve"',
      "-c", 'mcp_servers.ainecto.tools.kanban_apply_changes.approval_mode="approve"',
    ]);
  });

  it("thread/start·resume 에도 같은 정책 · resume 은 지난 차례를 받지 않는다", () => {
    expect(codexThreadStartParams("/w")).toEqual({ cwd: "/w", approvalPolicy: "never", sandbox: "read-only" });
    expect(codexThreadResumeParams("thr-1", "/w"))
      .toEqual({ threadId: "thr-1", cwd: "/w", approvalPolicy: "never", sandbox: "read-only", excludeTurns: true });
  });

  it("Codex 가 묻는 것은 전부 거절 — 모양은 schema 그대로, 모르는 요청은 JSON-RPC 오류", () => {
    expect(codexServerRequestAnswer("mcpServer/elicitation/request")).toEqual({ result: { action: "decline" } });
    expect(codexServerRequestAnswer("item/commandExecution/requestApproval")).toEqual({ result: { decision: "decline" } });
    expect(codexServerRequestAnswer("item/fileChange/requestApproval")).toEqual({ result: { decision: "decline" } });
    expect(codexServerRequestAnswer("execCommandApproval")).toEqual({ result: { decision: "denied" } });
    expect(codexServerRequestAnswer("applyPatchApproval")).toEqual({ result: { decision: "denied" } });
    expect(codexServerRequestAnswer("item/tool/requestUserInput")).toMatchObject({ error: { code: -32601 } });
  });

  it("account/read → 준비 여부 · 이메일은 싣지 않는다", () => {
    const signedIn = codexAuthFromAccount({ account: { type: "chatgpt", email: "a@b.c", planType: "pro" }, requiresOpenaiAuth: true });
    expect(signedIn).toEqual({ ready: true, method: "chatgpt", plan: "pro" });
    expect(codexAuthFromAccount({ account: { type: "apiKey" }, requiresOpenaiAuth: true })).toEqual({ ready: true, method: "apiKey" });
    expect(codexAuthFromAccount({ account: null, requiresOpenaiAuth: true })).toMatchObject({ ready: false });
    expect(codexAuthFromAccount({ account: null, requiresOpenaiAuth: false })).toMatchObject({ ready: true });
  });

  it("turn/completed → 공통 결과: 답 글이 JSON 이면 schema 값, 아니면 원문 · 실패·중단은 오류", () => {
    expect(codexTurnResult({ status: "completed" }, '{"reply":"보라고래"}'))
      .toEqual({ subtype: "completed", isError: false, structuredOutput: { reply: "보라고래" } });
    expect(codexTurnResult({ status: "completed", items: [{ type: "agentMessage", text: '{"reply":"x"}' }] }, undefined).structuredOutput)
      .toEqual({ reply: "x" });
    expect(codexTurnResult({ status: "completed" }, "plain")).toEqual({ subtype: "completed", isError: false, resultText: "plain" });
    expect(codexTurnResult({ status: "failed", error: { message: "boom" } }, undefined)).toEqual({ subtype: "failed", isError: true, resultText: "boom" });
    expect(codexTurnResult({ status: "interrupted" }, undefined)).toMatchObject({ subtype: "interrupted", isError: true });
  });
});

describe("Claude Code 고정 설정 · 인증 읽기", () => {
  it("K5 인자는 그대로(내장 도구 끔 · MCP 는 브리지 하나 · dontAsk · 설정 끔)", () => {
    expect(claudeAgentArgs({ schema: { type: "object" }, mcpConfig: claudeMcpConfig(bridge), resumeSessionId: "s-1" })).toEqual([
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--json-schema", '{"type":"object"}',
      "--tools", "",
      "--strict-mcp-config", "--mcp-config",
      '{"mcpServers":{"ainecto":{"command":"/usr/bin/node","args":["/opt/ainecto/dist/bin/ainecto.js","--endpoint","https://dev.ainecto.com/mcp","mcp"]}}}',
      "--allowedTools", "mcp__ainecto",
      "--permission-mode", "dontAsk",
      "--setting-sources", "",
      "--resume", "s-1",
    ]);
  });

  it("claude auth status --json → 준비 여부(실측 칸 이름) · 못 읽으면 준비 안 됨", () => {
    expect(claudeAuthFromJson('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","subscriptionType":"max"}', 0, ""))
      .toEqual({ ready: true, method: "claude.ai", plan: "max" });
    expect(claudeAuthFromJson('{"loggedIn":false,"authMethod":"none"}', 1, "")).toEqual({ ready: false, method: "none", plan: undefined });
    expect(claudeAuthFromJson("Not logged in", 1, "")).toMatchObject({ ready: false, detail: "unreadable auth status (exit 1)" });
  });

  it("Agent 환경에서 AINECTO_TOKEN 을 뺀다(브리지는 CLI 로그인만)", () => {
    expect(agentEnv({ PATH: "/bin", AINECTO_TOKEN: "secret" })).toEqual({ PATH: "/bin" });
  });
});
