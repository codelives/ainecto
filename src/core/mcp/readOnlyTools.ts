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

/**
 * ★지금 서버 목록에서 이 이름이 읽기 도구인가 — 그 이름을 찾거나 마지막 쪽에 이를 때까지 {@code nextCursor} 를 따라간다(MCP 목록 쪽 나눔 ·
 * 재리뷰 r2 P1). 찾은 도구는 그 표시대로, 끝까지 없으면 아니다. 같은 커서가 다시 오면(서버 고장) 거기서 멈추고 아니다. 목록 읽기 실패는 던진다
 * (부른 쪽이 막는다).
 * @param page 그 커서의 tools/list 결과(첫 쪽은 undefined)
 */
export async function isReadOnlyToolNow(page: (cursor: string | undefined) => Promise<unknown>, name: string): Promise<boolean> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const result = await page(cursor);
    const tools = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
    const found = tools.find((tool) => isRecord(tool) && tool.name === name);
    if (found !== undefined) return isReadOnlyTool(found);
    const next = isRecord(result) && typeof result.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : undefined;
    if (next === undefined || seen.has(next)) return false;
    seen.add(next);
    cursor = next;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
