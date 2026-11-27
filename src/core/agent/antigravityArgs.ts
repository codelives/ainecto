import type { AinectoBridge } from "./agents";

/**
 * ★Antigravity CLI(agy) 헤드리스 고정 인자 — 한 곳. 설계 `_workspace/design/windows-pc/ecobit/antigravity-pc-agent.md` r3
 * (reviewer03 GO 11-23) · 실측 agy 1.5.14(M1~M6). 하나라도 바꾸면 다시 잰다.
 */

/** 실행 파일 이름 — Windows 공식 설치는 {@code %LOCALAPPDATA%\agy\bin\agy.exe}(Path 로 찾는다 · planLaunch). */
export const AGY = "agy";

/** 검증한 agy 판 — ★상수(루트 승인 11-23 · 1.5.14 → 1.5.15 루트 결재 11-23 19:4x — dev 실측이 1.5.15 · 로그만 · 막지 않음). agy 는 스스로 갱신되므로 다르면 {@code agent_version_unverified} 한 줄. */
export const VERIFIED_AGY_VERSION = "1.5.15";

/**
 * Antigravity 에 붙이는 AiNecto 브리지의 서버 이름 — Claude·Codex 의 {@code ainecto} 와 다르다.
 * {@code ainecto setup} 이 Antigravity 전역 설정에 원격 {@code ainecto} 를 쓰므로 이름이 같으면 어느 쪽이 이기는지가 agy 의 (문서에 없는) 병합 규칙에 걸린다.
 */
export const ANTIGRAVITY_MCP_SERVER = "ainecto-pc";

/** agy 의 사용자 지정 폴더 넷 — 공식 Customization discovery 가 모두 인정한다. */
export const AGY_CUSTOMIZATION_DIRS = [".agents", ".agent", "_agents", "_agent"] as const;

/** 권한 작업 이름으로 막는 내장 도구 — 셸 · 파일 쓰기 · 파일 읽기 · 주소 읽기 · 주소 실행. */
const BUILTIN_DENY = ["command(*)", "write_file(*)", "read_file(*)", "read_url(*)", "execute_url(*)"] as const;

/** 서버 tools/list 의 도구 하나(이름 · 설명 · 입력 schema) — serve 가 시작할 때 한 번 받은 것. */
export interface AgyToolDefinition {
  name: string;
  description?: unknown;
  inputSchema?: unknown;
}

/**
 * 차례 입력 앞에 싣는 도구 정의 — 서버 tools/list 한 벌 그대로(손으로 복제하지 않는다 · 구현 리뷰 1차 P1 대안 ①).
 * agy 는 MCP 정의를 파일(~/.gemini/antigravity-cli/mcp/…)로 두고 read_file 로 읽게 하는데, 우리는 read_file 을 막는다(헤드리스는 allow 를 무시해
 * 그 폴더만 열 수 없다). 정의가 없으면 모델이 인자를 추측해 오류를 거듭한다(실측 기록: ecobit/agy-evidence/definition-passing-counts.json).
 */
export function antigravityToolPreamble(tools: ReadonlyArray<AgyToolDefinition>): string {
  const definitions = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  return `[AiNecto tool definitions — MCP server "${ANTIGRAVITY_MCP_SERVER}" (call these with call_mcp_tool; `
    + `the definitions are complete, do not look for definition files)]\n${JSON.stringify(definitions)}\n\n`;
}

/** 작업 폴더 {@code .agents/mcp_config.json} — MCP 서버는 이 CLI 의 브리지 하나뿐(stdio). */
export function antigravityMcpConfig(bridge: AinectoBridge): Record<string, unknown> {
  return { mcpServers: { [ANTIGRAVITY_MCP_SERVER]: { command: bridge.command, args: bridge.args } } };
}

/**
 * 이 실행만의 설정({@code --settings} · 사용자 파일에 쓰지 않음). ★보장은 이름 거절이 한다 — 사용자 {@code always-proceed} 는
 * ask/deny 에 걸리지 않는 MCP 호출을 승인하므로, 브리지 밖 서버 이름을 전부 deny 에 싣는다(실측 M5 other 1 → M6 0).
 * {@code deny mcp(*)} 는 Deny 우선이라 브리지까지 막으므로 쓰지 않는다. {@code toolPermission} 은 덧댐(우선순위는 문서에 없다).
 * {@code denyBridgeTools} = 브리지에서도 거절할 도구(읽기만 세션의 쓰기 도구 — 규칙 꼴 {@code mcp(<서버>/<도구>)} 는 M6 거절 문구
 * «Permission denied for mcp(other/ping)» 그대로 · 도구 하나 단위 거절은 실측하지 않았다).
 */
export function antigravitySettings(denyServers: readonly string[], denyBridgeTools: readonly string[] = []): Record<string, unknown> {
  return {
    toolPermission: "request-review",
    permissions: {
      allow: [`mcp(${ANTIGRAVITY_MCP_SERVER}/*)`],
      deny: [...BUILTIN_DENY, ...denyServers.map((name) => `mcp(${name}/*)`),
        ...denyBridgeTools.map((tool) => `mcp(${ANTIGRAVITY_MCP_SERVER}/${tool})`)],
    },
  };
}

export function antigravityAgentArgs(input: {
  schema: Record<string, unknown>;
  settings: Record<string, unknown>;
  conversationId?: string;
}): string[] {
  const args = [
    // ★`-p` 는 값을 받는다 — 비우지 않으면 다음 인자를 프롬프트로 먹는다(실측 1.5.14 끝 코드 2). 프롬프트는 stdin(stream-json) 한 줄이라 빈 글.
    "-p", "",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--json-schema", JSON.stringify(input.schema),
    "--settings", JSON.stringify(input.settings),
  ];
  if (input.conversationId) {
    args.push("--conversation", input.conversationId);
  }
  return args;
}
