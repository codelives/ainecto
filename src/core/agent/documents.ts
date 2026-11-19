/**
 * 답에 붙일 문서·카드 — ★모델 말이 아니라 «쓰기 도구» 결과에서 뽑는다(설계 1절). ★두 Agent 가 이 한 곳을 쓴다.
 * 서버는 읽기 도구(list_documents 등) 결과에도 {@code 📄 …/app/docs/<uuid>} 줄을 붙이므로(K5 실측), 쓰기 도구인지는 서버 {@code tools/list} 의
 * {@code annotations.readOnlyHint} 가 정한다 — 여기에 도구 이름 목록을 두지 않는다.
 *
 * <ul>
 *   <li>문서 = 결과의 📄 줄(서버가 «이 호출이 닿은 문서»로 붙인 것).</li>
 *   <li>새로 만든 문서 = 그 가운데 결과 JSON 맨 위 {@code created} 배열의 {@code uuid} 인 것 — 서버가 «만든 것»을 부르는 칸 이름 그대로
 *       ({@code create_documents} 의 {@code {"created":[{uuid,…}]}}). 나머지는 고친 문서다.</li>
 *   <li>카드 = 결과 JSON 안의 {@code cardUuid}(32 hex) 값 전부({@code kanban_apply_changes} 의 {@code results[].cardUuid} 등).</li>
 * </ul>
 * 찾기만 한 문서·카드(KAN-1229 Edwin #2172)는 모델이 «열기»로 고른 id 가운데 이 차례 AiNecto 도구(읽기·쓰기) 결과에 실제로 나온 것만 싣는다
 * ({@code seen}) — 문서인지 카드인지·읽을 수 있는지는 서버가 가린다.
 */

const DOCUMENT_LINE = /📄[^\n]*?\/app\/docs\/([0-9a-f]{32})(?![0-9a-f])/gu;
const HEX32 = /^[0-9a-f]{32}$/;

export interface WriteFacts {
  documents: string[];
  /** {@code documents} 의 부분집합. */
  createdDocuments: string[];
  cards: string[];
}

/** 한 차례의 사실 — 쓰기 결과 + 성공한 AiNecto 도구 결과 전부에 나온 32 hex id(📄 줄 · JSON 값, 순서대로 · 중복 없이). */
export interface TurnFacts extends WriteFacts {
  seen: string[];
}

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

/** 쓰기 도구 결과 하나 → 문서·새 문서·카드(순수 함수). */
export function writeResultFacts(content: unknown): WriteFacts {
  const documents = documentUuidsIn(content);
  const created = new Set<string>();
  const cards: string[] = [];
  for (const value of jsonObjectsIn(content)) {
    const top = value as { created?: unknown };
    if (Array.isArray(top.created)) {
      for (const item of top.created) {
        const uuid = (item as { uuid?: unknown } | null)?.uuid;
        if (typeof uuid === "string") created.add(uuid);
      }
    }
    collectCards(value, cards);
  }
  return { documents, createdDocuments: documents.filter((uuid) => created.has(uuid)), cards };
}

/** 결과 하나에 나온 32 hex id — 📄 줄의 문서 + JSON 안의 32 hex 글 값 전부(순수 함수). */
export function seenIdsIn(content: unknown): string[] {
  const out = documentUuidsIn(content);
  for (const value of jsonObjectsIn(content)) collectHexValues(value, out);
  return out;
}

/** 한 차례 동안 성공한 AiNecto 도구 결과를 모은다 — 순서대로 · 중복 없이. 쓰기 도구 결과만 문서·카드가 된다. */
export class TurnFactsCollector {
  private readonly facts: TurnFacts = { documents: [], createdDocuments: [], cards: [], seen: [] };

  add(content: unknown, write: boolean): void {
    appendUnique(this.facts.seen, seenIdsIn(content));
    if (!write) return;
    const next = writeResultFacts(content);
    appendUnique(this.facts.documents, next.documents);
    appendUnique(this.facts.createdDocuments, next.createdDocuments);
    appendUnique(this.facts.cards, next.cards);
  }

  snapshot(): TurnFacts {
    return { documents: [...this.facts.documents], createdDocuments: [...this.facts.createdDocuments], cards: [...this.facts.cards],
      seen: [...this.facts.seen] };
  }
}

/** 서버 tools/list 결과에서 쓰기 도구 이름(readOnlyHint 가 참이 아닌 것). */
export function writeToolNames(tools: ReadonlyArray<{ name: string; annotations?: { readOnlyHint?: boolean } }>): Set<string> {
  return new Set(tools.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name));
}

function texts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text]
      : []);
}

/** 결과 글 가운데 JSON 객체인 것(도구 본문). 📄 줄·알림 줄은 JSON 이 아니라 걸러진다. */
function jsonObjectsIn(content: unknown): object[] {
  return texts(content).flatMap((text) => {
    if (!text.trimStart().startsWith("{")) return [];
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

function collectCards(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCards(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "cardUuid" && typeof child === "string" && HEX32.test(child)) {
      if (!out.includes(child)) out.push(child);
    } else {
      collectCards(child, out);
    }
  }
}

function collectHexValues(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (HEX32.test(value) && !out.includes(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectHexValues(item, out);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectHexValues(child, out);
  }
}

function appendUnique(target: string[], items: readonly string[]): void {
  for (const item of items) {
    if (!target.includes(item)) target.push(item);
  }
}
