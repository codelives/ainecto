import { assertTrustedEndpointUrl } from "../config/endpoints";
import { documentContractProblem } from "./harnessDoc";

/**
 * 저장소에 쓸 하네스 문서를 서버에서 받아 온다.
 *
 * <p>★<b>이것이 「규칙을 고치려면 npm 퍼블리시」를 끊는 지점이다.</b> 예전엔 본문이 패키지
 * 안에 박혀 있어서, 한 줄 고치려면 CLI 를 배포하고 모든 사용자가 init 을 다시 쳐야 했다.
 *
 * <p>⚠<b>못 받으면 «기본값을 썼다»고 적는다.</b> 조용히 패키지 사본으로 떨어지면, 서버에서
 * 규칙을 고쳐도 안 바뀌는 이유를 사용자가 영영 못 찾는다 — 오늘 여러 번 만난 모양이다.
 *
 * <p>MCP 엔드포인트 아래({@code <endpoint>/harness/documents})에 둔 이유: MCP 토큰은 REST
 * ({@code /api/v1/...})에서 거절되고, 도구로 내면 모든 세션의 도구 목록이 한 칸 늘어난다.
 */
export interface HarnessDocuments {
  doc?: string;
  agentNote?: string;
  /** 어느 판을 받았나. 못 받았으면 undefined. */
  versions: Record<string, string>;
  /** 못 받은 이유 — 요청 자체가 실패했을 때. 받았으면 undefined. */
  unavailableReason?: string;
  /**
   * ★<b>문서별로 패키지 기본값을 쓴 이유.</b> 서버가 HTTP 200 으로 «빈 문서»를 주거나
   * 계약을 안 지킨 본문을 줘도 예전엔 조용히 패키지 사본으로 떨어졌다 — 사용자는 자기가
   * 서버 판을 받았다고 믿는다(2026-09-23 독립 재리뷰 I5).
   */
  fallbacks: Record<string, string>;
}

export interface FetchHarnessDocumentsInput {
  endpoint: string;
  accessToken?: string;
  client?: string;
  fetchImpl?: typeof fetch;
}

export const DOC_KEY = "HARNESS.DOC";
export const AGENT_NOTE_KEY = "HARNESS.AGENT_NOTE";

export async function fetchHarnessDocuments(
  input: FetchHarnessDocumentsInput,
): Promise<HarnessDocuments> {
  const url = new URL(`${input.endpoint.replace(/\/$/, "")}/harness/documents`);
  assertTrustedEndpointUrl(url, "harness documents URL");
  if (input.client) {
    url.searchParams.set("client", input.client);
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url.toString(), {
      headers: {
        accept: "application/json",
        ...(input.accessToken ? { authorization: `Bearer ${input.accessToken}` } : {}),
      },
    });
    if (!response.ok) {
      return { versions: {}, fallbacks: {}, unavailableReason: `server answered HTTP ${response.status}` };
    }
    const payload = (await response.json()) as {
      documents?: Record<string, { body?: unknown; version?: unknown; reason?: unknown }>;
    };
    const documents = payload.documents ?? {};
    const versions: Record<string, string> = {};
    const fallbacks: Record<string, string> = {};
    const bodies: Record<string, string | undefined> = {};
    for (const key of [DOC_KEY, AGENT_NOTE_KEY]) {
      const entry = documents[key];
      const problem = usableBodyProblem(key, entry);
      if (problem) {
        // 서버가 이유를 말해 줬으면 그것을 쓰고, 아니면 우리가 본 것을 쓴다.
        fallbacks[key] = typeof entry?.reason === "string" && entry.reason ? entry.reason : problem;
        continue;
      }
      bodies[key] = entry!.body as string;
      if (typeof entry?.version === "string") {
        versions[key] = entry.version;
      }
    }
    return { doc: bodies[DOC_KEY], agentNote: bodies[AGENT_NOTE_KEY], versions, fallbacks };
  } catch (error) {
    return {
      versions: {},
      fallbacks: {},
      unavailableReason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 이 응답 조각을 저장소에 «써도 되는가». 쓰면 안 되는 이유가 있으면 그 이유를 돌려준다.
 *
 * <p>★서버가 200 을 줬다는 것은 «전송이 됐다»는 뜻이지 «쓸 수 있는 글»이라는 뜻이 아니다.
 * 예전엔 본문이 비어 있지만 않으면 그대로 파일에 썼다 — 변수가 빠진 DOC 이나 관리 마커가
 * 없는 AGENT_NOTE 가 사용자 저장소에 들어갔고, 마커가 없으면 재실행마다 덧붙고 undo 도
 * 못 걷어낸다(2026-09-23 독립 재리뷰 I1).
 */
function usableBodyProblem(key: string, entry: { body?: unknown } | undefined): string | undefined {
  if (typeof entry?.body !== "string" || !entry.body.trim()) {
    return `server returned no body for ${key}`;
  }
  return documentContractProblem(key, entry.body);
}
