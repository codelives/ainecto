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
