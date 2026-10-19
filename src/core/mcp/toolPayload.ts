/**
 * MCP 도구 결과 → 도구가 돌려준 JSON 객체. 서버는 결과를 `content[].text` 에 JSON 문자열로 싣는다(뒤에 안내 문장이 붙을 수 있다).
 * JSON 으로 시작하는 첫 text 를 읽고, 못 읽으면 받은 값을 그대로 돌려준다.
 */
export function unwrapMcpToolPayload(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return value;
  }
  const text = value.content
    .map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "")
    .find((itemText) => itemText.trim().startsWith("{"));
  if (!text) {
    return value;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return value;
  }
}

/** 도구가 거부했을 때 사람이 읽을 사유 — content text 를 이어 붙인다. */
export function toolErrorText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return "The tool returned an error.";
  }
  const text = value.content
    .map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n");
  return text || "The tool returned an error.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 응답 모양을 단정하지 않고 «uuid 와 name 을 가진 객체의 배열»을 찾는다(list_projects 등).
 * ⚠도구 응답 포맷을 여기 박아 두면 서버가 한 겹 감싸는 순간 조용히 빈 목록이 된다.
 */
export function extractProjects(value: unknown): Array<{ uuid: string; name: string }> {
  const candidates: unknown[] = Array.isArray(value)
    ? value
    : isRecord(value)
      ? ["projects", "items", "created", "data", "hits"].flatMap((key) => {
        const nested = value[key];
        return Array.isArray(nested) ? nested : [];
      })
      : [];
  const projects: Array<{ uuid: string; name: string }> = [];
  for (const candidate of candidates) {
    if (isRecord(candidate) && typeof candidate.uuid === "string") {
      projects.push({
        uuid: candidate.uuid,
        name: typeof candidate.name === "string" ? candidate.name : candidate.uuid,
      });
    }
  }
  return projects;
}
