import { bridgeKind } from "../pc/bridgeKind";
import type { EndedRecord, ListedSession } from "./protocol";

/**
 * 원격 다리가 서버에 올리는 세션 목록 — 순수 함수(api PC open·sessions 의 sessions[] 모양).
 * PC 연결 세션(종류 pc-bridge — bridgeKind 한 곳)은 뺀다 — 웹에서 그 세션을 끝내면 다리가 같이 죽는다.
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
  /** 늘 "user" — pc-bridge 줄은 싣지 않는다(api SESSION_ITEM kind). */
  kind: "user";
}

/** 서버 장부에 올리는 끝 기록(api ENDED_ITEM) — command 는 PC 안 판정용이라 싣지 않는다. */
export interface WireEnded {
  instance: string;
  name: string;
  kind: "user";
  endedAt: string;
  reason: EndedRecord["reason"];
  exitCode?: number;
  signal?: string;
}

/** 다리가 한 번의 ls 로 보는 것 — 올릴 목록 · 올릴 끝 기록 · 서버 2xx 뒤 책에서 지울 instance(옛 데몬이면 undefined — ended-ack 를 모른다). */
export interface Listing {
  sessions: WireSession[];
  ended: WireEnded[];
  ack: string[] | undefined;
  /** 지금 pc-bridge 인 세션 이름 — 웹 명령이 그 세션을 겨누면 거절한다. */
  bridges: string[];
}

export function listing(listed: readonly ListedSession[], ended: readonly EndedRecord[] | undefined): Listing {
  const user = (row: { name: string; command: readonly string[] | null; kind?: ListedSession["kind"] }): boolean => bridgeKind(row) === "user";
  return {
    sessions: wireSessions(listed.filter(user)),
    ended: (ended ?? []).filter(user).map(wireEnded),
    // pc-bridge 끝 기록은 올리지 않고 같이 지운다(데몬은 원격의 뜻을 모른 채 둔다).
    ack: ended?.map((record) => record.instance),
    bridges: listed.filter((row) => !user(row)).map((row) => row.name),
  };
}

function wireEnded(record: EndedRecord): WireEnded {
  return {
    instance: record.instance,
    name: record.name,
    kind: "user",
    endedAt: record.endedAt,
    reason: record.reason,
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.signal !== undefined ? { signal: record.signal } : {}),
  };
}

function wireSessions(listed: readonly ListedSession[]): WireSession[] {
  return listed
    .map((session) => ({
      name: session.name,
      ...(session.label !== undefined ? { label: session.label } : {}),
      ...(session.project !== undefined ? { project: session.project } : {}),
      cols: session.cols,
      rows: session.rows,
      ...(session.lastOutputAt !== undefined ? { lastOutputAt: session.lastOutputAt } : {}),
      ...(session.instance !== undefined ? { instance: session.instance } : {}),
      kind: "user" as const,
    }));
}

/** 바뀜 판정 열쇠 — 같은 목록이면 같은 글(칸 순서까지 wireSessions 가 정한다). */
export function sessionsKey(sessions: readonly WireSession[]): string {
  return JSON.stringify(sessions);
}
