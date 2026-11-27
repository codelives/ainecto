import { AINECTO_MCP_SERVER, type AinectoBridge } from "./agents";

/**
 * ★K5 헤드리스 고정 인자 — 한 곳. 단계 2 첫 실측(2026-11-11, 증적 `.role/claude-dev/evidence/kan1075/stage2-k5/`)에서
 * init 도구 목록이 {@code StructuredOutput} + {@code mcp__ainecto__*} 뿐 · MCP 쓰기 · structured_output · {@code --resume} 맥락 ·
 * 구독 로그인(apiKeySource none) 을 확인한 그대로다. 하나라도 바꾸면 다시 잰다.
 */

/** Claude 가 쓰는 MCP 서버는 이 CLI 의 브리지 하나뿐. */
export function claudeMcpConfig(bridge: AinectoBridge): Record<string, unknown> {
  return { mcpServers: { [AINECTO_MCP_SERVER]: { command: bridge.command, args: bridge.args } } };
}

/**
 * @param readTools 있으면 ★읽기만 세션 — 허용은 이 AiNecto 도구들(서버 readOnlyHint)뿐이고 나머지(쓰기 도구 포함)는 dontAsk 가 묻지 않고 거절한다.
 *                  비어 있으면 AiNecto 도구를 하나도 허용하지 않는다. 없으면 AiNecto 도구 전부(Connect·할 일).
 */
export function claudeAgentArgs(input: {
  schema: Record<string, unknown>;
  mcpConfig: Record<string, unknown>;
  resumeSessionId?: string;
  readTools?: readonly string[];
}): string[] {
  const allowed = input.readTools === undefined ? [`mcp__${AINECTO_MCP_SERVER}`]
    : input.readTools.map((tool) => `${AINECTO_TOOL_PREFIX}${tool}`);
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--json-schema", JSON.stringify(input.schema),
    "--tools", "",                       // 내장 도구(Bash·Read·Write·Edit·Agent·Skill·WebFetch…) 전부 끔
    "--strict-mcp-config", "--mcp-config", JSON.stringify(input.mcpConfig),
    ...(allowed.length > 0 ? ["--allowedTools", allowed.join(",")] : []),
    "--permission-mode", "dontAsk",      // 허용 밖은 묻지 않고 바로 거절(헤드리스에서 묻기 = 2분 대기)
    "--setting-sources", "",             // 사용자·프로젝트 설정(플러그인·스킬·훅·권한) 끔
  ];
  if (input.resumeSessionId) {
    args.push("--resume", input.resumeSessionId);
  }
  return args;
}

/** MCP 도구 이름 앞머리 — 결과를 서버 도구 이름으로 되돌릴 때 쓴다. */
export const AINECTO_TOOL_PREFIX = `mcp__${AINECTO_MCP_SERVER}__`;
