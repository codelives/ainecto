import type { ListedSession } from "./protocol";

/**
 * 원격 다리가 서버에 올리는 세션 목록 — 순수 함수(api PC open·sessions 의 sessions[] 모양).
 * 다리를 돌리는 자기 세션(pc 연결 세션)은 뺀다 — 웹에서 그 세션을 끝내면 다리가 같이 죽는다.
 */
export interface WireSession {
  name: string;
  label?: string;
  cols: number;
  rows: number;
  lastOutputAt?: string;
}

export function wireSessions(listed: readonly ListedSession[], exclude: readonly string[]): WireSession[] {
  return listed
    .filter((session) => !exclude.includes(session.name))
    .map((session) => ({
      name: session.name,
      ...(session.label !== undefined ? { label: session.label } : {}),
      cols: session.cols,
      rows: session.rows,
      ...(session.lastOutputAt !== undefined ? { lastOutputAt: session.lastOutputAt } : {}),
    }));
}

/** 바뀜 판정 열쇠 — 같은 목록이면 같은 글(칸 순서까지 wireSessions 가 정한다). */
export function sessionsKey(sessions: readonly WireSession[]): string {
  return JSON.stringify(sessions);
}
