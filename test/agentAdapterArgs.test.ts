import { agentEnv, ainectoBridge } from "../src/core/agent/agents";
import { claudeAgentArgs, claudeMcpConfig } from "../src/core/agent/claudeArgs";
import { claudeAuthFromJson } from "../src/core/agent/claudeCode";
import {
  codexAppServerArgs,
  codexAuthFromAccount,
  codexOtherMcpServersOff,
  codexServerRequestAnswer,
  codexThreadResumeParams,
  codexThreadStartParams,
  codexTurnResult,
} from "../src/core/agent/codexArgs";

const bridge = ainectoBridge("/usr/bin/node", "/opt/ainecto/dist/bin/ainecto.js", "https://dev.ainecto.com/mcp");

describe("Codex app-server 고정 설정(실측 그대로)", () => {
  it("AiNecto 브리지 · never · read-only · 내장 셸·플러그인·앱·컴퓨터/브라우저 조작·이미지 끔 · 쓰기 도구마다 approve", () => {
    expect(codexAppServerArgs(bridge, new Set(["kanban_apply_changes", "create_documents", "bad.name"]), false)).toEqual([
      "app-server",
      "-c", 'mcp_servers.ainecto.command="/usr/bin/node"',
      "-c", 'mcp_servers.ainecto.args=["/opt/ainecto/dist/bin/ainecto.js","--endpoint","https://dev.ainecto.com/mcp","mcp"]',
      "-c", 'approval_policy="never"',
      "-c", 'sandbox_mode="read-only"',
      "-c", "features.shell_tool=false",
      "-c", "features.plugins=false",
      "-c", "features.apps=false",
      "-c", "features.computer_use=false",
      "-c", "features.browser_use=false",
      "-c", "features.image_generation=false",
      "-c", 'mcp_servers.ainecto.tools.create_documents.approval_mode="approve"',
      "-c", 'mcp_servers.ainecto.tools.kanban_apply_changes.approval_mode="approve"',
    ]);
  });

  it("thread/start·resume 에도 같은 정책과 서버 끄기 · resume 은 지난 차례를 받지 않는다", () => {
    const off = { "mcp_servers.node_repl.enabled": false };
    expect(codexThreadStartParams("/w", off)).toEqual({ cwd: "/w", approvalPolicy: "never", sandbox: "read-only", config: off });
    expect(codexThreadResumeParams("thr-1", "/w", off))
      .toEqual({ threadId: "thr-1", cwd: "/w", approvalPolicy: "never", sandbox: "read-only", config: off, excludeTurns: true });
  });

  it("사용자 설정의 다른 MCP 서버는 AiNecto 만 빼고 전부 끈다 — 설정 키로 못 쓰는 이름이면 시작하지 않는다", () => {
    expect(codexOtherMcpServersOff({ mcp_servers: { ainecto: {}, "dev-ainecto": { url: "x" }, node_repl: {} } }))
      .toEqual({ names: ["dev-ainecto", "node_repl"],
        config: { "mcp_servers.dev-ainecto.enabled": false, "mcp_servers.node_repl.enabled": false } });
    expect(codexOtherMcpServersOff({})).toEqual({ names: [], config: {} });
    expect(codexOtherMcpServersOff(undefined)).toEqual({ names: [], config: {} });
    expect(() => codexOtherMcpServersOff({ mcp_servers: { "a.b": {} } })).toThrow(/a\.b/);
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
    expect(signedIn).toEqual({ ready: true, mode: "subscription", method: "chatgpt", plan: "pro" });
    expect(codexAuthFromAccount({ account: { type: "apiKey" }, requiresOpenaiAuth: true })).toEqual({ ready: true, mode: "apiKey", method: "apiKey" });
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
    expect(claudeAuthFromJson('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","subscriptionType":"max"}', 0, "", false))
      .toEqual({ ready: true, mode: "subscription", method: "claude.ai", plan: "max" });
    expect(claudeAuthFromJson('{"loggedIn":false,"authMethod":"none"}', 1, "", false)).toEqual({ ready: false, method: "none", plan: undefined });
    expect(claudeAuthFromJson("Not logged in", 1, "", false)).toMatchObject({ ready: false, detail: "unreadable auth status (exit 1)" });
    // 실측: auth status 는 키 변수를 보이지 않는다 — 키 변수가 있으면 `-p` 가 그 키를 쓰므로 apiKey(로그인 안 됐어도 준비됨).
    expect(claudeAuthFromJson('{"loggedIn":true,"authMethod":"claude.ai"}', 0, "", true)).toMatchObject({ ready: true, mode: "apiKey" });
    expect(claudeAuthFromJson("Not logged in", 1, "", true)).toMatchObject({ ready: true, mode: "apiKey" });
  });

  it("운영이면 Codex 를 API 키 로그인만 쓰게 띄운다(forced_login_method) — dev 는 그대로", () => {
    const prod = codexAppServerArgs(bridge, new Set<string>(), true);
    expect(prod.slice(-2)).toEqual(["-c", 'forced_login_method="api"']);
    expect(codexAppServerArgs(bridge, new Set<string>(), false)).not.toContain('forced_login_method="api"');
  });

  it("Agent 환경에서 AINECTO_TOKEN 을 뺀다(브리지는 CLI 로그인만)", () => {
    expect(agentEnv({ PATH: "/bin", AINECTO_TOKEN: "secret" })).toEqual({ PATH: "/bin" });
  });
});
