import { termRequest } from "./client";
import { noSession, TermError } from "./errors";
import type { TermPaths } from "./paths";
import { listedSessions, type ListedSession } from "./protocol";

/** 명령이 겨누는 세션 — 이름(선 위 열쇠) + 처음 해석한 인스턴스(있으면 holder 가 «지금 그 이름이 그 인스턴스일 때만» 적용한다). */
export interface SessionTarget {
  name: string;
  instance?: string;
}

/**
 * `<uuid|이름>` → 세션 하나(세션 유지 구조 원칙 2 · G7 — 순수 함수). uuid(인스턴스)와 같으면 그것,
 * 아니면 이름으로 찾고 ★정확히 하나일 때만. 여럿이면 «uuid 로 지정하세요»로 거절한다(이름은 표시용 — 판정을 기대지 않는다).
 * 옛 구조 데몬(인스턴스 칸 없음)의 세션은 이름만 싣는다.
 */
export function pickTarget(sessions: readonly ListedSession[], ref: string): SessionTarget {
  const byInstance = sessions.find((session) => session.instance === ref);
  if (byInstance) return toTarget(byInstance);
  const byName = sessions.filter((session) => session.name === ref);
  if (byName.length === 1) return toTarget(byName[0]!);
  if (byName.length > 1) {
    throw new TermError("TERM_AMBIGUOUS_NAME", `There are ${byName.length} sessions named "${ref}" — name one by its uuid (see term ls).`);
  }
  throw new TermError("TERM_NO_SESSION", `No session named "${ref}" (and no session has that uuid).`);
}

/** 지금 목록에서 `<uuid|이름>` 을 푼다. 데몬이 없으면 «세션 없음». */
export async function lookupTarget(paths: TermPaths, ref: string): Promise<SessionTarget> {
  const result = await termRequest(paths, { op: "ls" }, { start: false });
  if (!result.daemon) {
    throw noSession(ref);
  }
  return pickTarget(listedSessions(result.data), ref);
}

function toTarget(session: ListedSession): SessionTarget {
  return { name: session.name, ...(session.instance !== undefined ? { instance: session.instance } : {}) };
}
