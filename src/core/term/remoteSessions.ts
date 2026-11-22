import type { ListedSession } from "./protocol";

/**
 * 원격 다리가 서버에 올리는 세션 목록 — 순수 함수(api PC open·sessions 의 sessions[] 모양).
 * 다리를 돌리는 자기 세션(pc 연결 세션)은 뺀다 — 웹에서 그 세션을 끝내면 다리가 같이 죽는다.
 */
export interface WireSession {
  name: string;
  label?: string;
  /** 프로젝트 꼬리표 — 있을 때만 싣는다(옛 api 는 이 칸을 모르고 400 — 배포 순서 api 먼저). */
  project?: string;
  cols: number;
  rows: number;
  lastOutputAt?: string;
  /**
   * 세션 인스턴스 id(무작위 — 화면·입력 내용 없음, 설계 terminal-e2e §2). 브라우저가 화면을 안 연 세션도 끝내기·이름 바꾸기에 싣는다.
   * 맞는지는 데몬이 명령을 적용하는 자리에서 본다(§14-6 4). 옛 데몬이면 칸 없음.
   */
  instance?: string;
}

export function wireSessions(listed: readonly ListedSession[], exclude: readonly string[]): WireSession[] {
  return listed
    .filter((session) => !exclude.includes(session.name))
    .map((session) => ({
      name: session.name,
      ...(session.label !== undefined ? { label: session.label } : {}),
      ...(session.project !== undefined ? { project: session.project } : {}),
      cols: session.cols,
      rows: session.rows,
      ...(session.lastOutputAt !== undefined ? { lastOutputAt: session.lastOutputAt } : {}),
      ...(session.instance !== undefined ? { instance: session.instance } : {}),
    }));
}

/** 바뀜 판정 열쇠 — 같은 목록이면 같은 글(칸 순서까지 wireSessions 가 정한다). */
export function sessionsKey(sessions: readonly WireSession[]): string {
  return JSON.stringify(sessions);
}
