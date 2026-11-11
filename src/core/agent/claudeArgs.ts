/**
 * ★K5 헤드리스 고정 인자 — 한 곳. 단계 2 첫 실측(2026-11-11, 증적 `.role/claude-dev/evidence/kan1075/stage2-k5/`)에서
 * init 도구 목록이 {@code StructuredOutput} + {@code mcp__ainecto__*} 뿐 · MCP 쓰기 · structured_output · {@code --resume} 맥락 ·
 * 구독 로그인(apiKeySource none) 을 확인한 그대로다. 하나라도 바꾸면 다시 잰다.
 */

/** 답 schema(설계 1절) — 닫힌 schema. 문서는 모델 말이 아니라 쓰기 도구 결과에서 뽑는다. */
export function agentReplySchema(textMaxCharacters: number): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["reply"],
    properties: { reply: { type: "string", minLength: 1, maxLength: textMaxCharacters } },
  };
}

/** Claude 가 쓰는 MCP 서버는 이 CLI 의 브리지 하나뿐 — 같은 서버 주소·같은 로그인. */
export function agentMcpConfig(nodePath: string, cliScript: string, endpoint: string): Record<string, unknown> {
  return { mcpServers: { ainecto: { command: nodePath, args: [cliScript, "--endpoint", endpoint, "mcp"] } } };
}

export function claudeAgentArgs(input: {
  schema: Record<string, unknown>;
  mcpConfig: Record<string, unknown>;
  resumeSessionId?: string;
}): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--json-schema", JSON.stringify(input.schema),
    "--tools", "",                       // 내장 도구(Bash·Read·Write·Edit·Agent·Skill·WebFetch…) 전부 끔
    "--strict-mcp-config", "--mcp-config", JSON.stringify(input.mcpConfig),
    "--allowedTools", "mcp__ainecto",
    "--permission-mode", "dontAsk",      // 허용 밖은 묻지 않고 바로 거절(헤드리스에서 묻기 = 2분 대기)
    "--setting-sources", "",             // 사용자·프로젝트 설정(플러그인·스킬·훅·권한) 끔
  ];
  if (input.resumeSessionId) {
    args.push("--resume", input.resumeSessionId);
  }
  return args;
}

/** Claude 에 넘기는 환경 — 브리지가 CLI 로그인만 쓰게 {@code AINECTO_TOKEN} 을 뺀다. */
export function claudeAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.AINECTO_TOKEN;
  return out;
}

/** MCP 도구 이름 앞머리 — 결과를 서버 도구 이름으로 되돌릴 때 쓴다. */
export const AINECTO_TOOL_PREFIX = "mcp__ainecto__";
