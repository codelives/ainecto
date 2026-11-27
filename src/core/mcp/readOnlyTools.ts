/**
 * ★«읽기 도구»의 한 판정 — 서버 tools/list 의 {@code annotations.readOnlyHint === true} 만 읽기다. 표시가 없거나 거짓이면 쓰기(막는다).
 * 읽기만 세션(Room 차례)의 보장은 브리지(stdioBridge)가 이 판정으로 지킨다. serve 의 엔진별 인자(Claude 허용 목록 · Antigravity 거절 ·
 * 문서 줄 뽑기)도 같은 함수를 쓴다(documents.writeToolNames).
 */
export function isReadOnlyTool(tool: unknown): boolean {
  if (!isRecord(tool) || !isRecord(tool.annotations)) return false;
  return tool.annotations.readOnlyHint === true;
}

/** tools/list 결과에서 읽기 도구만 남긴 결과 — 다른 칸(nextCursor 등)은 그대로. 꼴이 다르면 도구 0개. */
export function readOnlyToolsResult(result: unknown): Record<string, unknown> & { tools: unknown[] } {
  const base = isRecord(result) ? result : {};
  return { ...base, tools: Array.isArray(base.tools) ? base.tools.filter(isReadOnlyTool) : [] };
}

/** tools/list 결과에서 이 이름이 읽기 도구인가 — 없거나 표시가 없으면 아니다. */
export function isReadOnlyToolIn(result: unknown, name: string): boolean {
  return readOnlyToolsResult(result).tools.some((tool) => isRecord(tool) && tool.name === name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
