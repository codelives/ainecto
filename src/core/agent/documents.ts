/**
 * 답에 붙일 문서 — ★모델 말이 아니라 «쓰기 도구» 결과의 {@code 📄 …/app/docs/<uuid>} 줄에서 뽑는다(설계 1절).
 * 서버는 읽기 도구(list_documents 등) 결과에도 이 줄을 붙이므로(K5 실측), 쓰기 도구인지는 서버 {@code tools/list} 의
 * {@code annotations.readOnlyHint} 가 정한다 — 여기에 도구 이름 목록을 두지 않는다.
 */

const DOCUMENT_LINE = /📄[^\n]*?\/app\/docs\/([0-9a-f]{32})(?![0-9a-f])/gu;

/** tool_result 의 content(문자열 또는 [{type:"text", text}]) 에서 문서 uuid 를 순서대로(중복 없이). */
export function documentUuidsIn(content: unknown): string[] {
  const out: string[] = [];
  for (const text of texts(content)) {
    for (const match of text.matchAll(DOCUMENT_LINE)) {
      const uuid = match[1];
      if (uuid && !out.includes(uuid)) out.push(uuid);
    }
  }
  return out;
}

function texts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text]
      : []);
}

/** 서버 tools/list 결과에서 쓰기 도구 이름(readOnlyHint 가 참이 아닌 것). */
export function writeToolNames(tools: ReadonlyArray<{ name: string; annotations?: { readOnlyHint?: boolean } }>): Set<string> {
  return new Set(tools.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name));
}
