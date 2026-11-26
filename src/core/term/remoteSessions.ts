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

/**
 * 다리가 한 번의 ls 로 보는 것 — 올릴 목록 · 이 수신처에 올릴 끝 기록 · 서버에 올리지 않고 책에서 지울 instance.
 * known = 데몬이 끝 기록을 안다(ls 에 ended 칸 — 옛 데몬은 false: ended-ack·listed-to 를 보내지 않는다).
 */
export interface Listing {
  sessions: WireSession[];
  ended: WireEnded[];
  /** 올리지 않고 지울 것 — PC 연결 세션의 끝 · 어느 서버도 목록으로 받은 적 없는 세션의 끝. */
  drop: string[];
  known: boolean;
  /** 지금 pc-bridge 인 세션 이름 — 웹 명령이 그 세션을 겨누면 거절한다. */
  bridges: string[];
}

/**
 * ★끝 기록은 «그 세션을 목록으로 받은 수신처»(서버 + 계정 — destination)에만 간다(리뷰 0.16.6 P0-2). 다른 수신처의 기록은 싣지도 지우지도 않는다
 * (그 수신처의 다리가 다시 열 때 받는다). destination 이 없으면(계정을 모름) 끝 기록은 하나도 다루지 않는다.
 */
export function listing(listed: readonly ListedSession[], ended: readonly EndedRecord[] | undefined, destination: string | undefined): Listing {
  const user = (row: { name: string; command: readonly string[] | null; kind?: ListedSession["kind"] }): boolean => bridgeKind(row) === "user";
  const records = destination === undefined ? [] : (ended ?? []);
  return {
    sessions: wireSessions(listed.filter(user)),
    ended: records.filter((record) => user(record) && record.to === destination).map(wireEnded),
    // PC 연결 세션의 끝(데몬은 원격의 뜻을 모른 채 둔다) · 아무 서버도 본 적 없는 세션의 끝 — 올릴 곳이 없다.
    drop: records.filter((record) => !user(record) || record.to === undefined).map((record) => record.instance),
    known: ended !== undefined,
    bridges: listed.filter((row) => !user(row)).map((row) => row.name),
  };
}

/**
 * 본문 상한(서버가 알려 준 bodyMaxBytes · 413 의 maxBytes) 안에 들어가는 앞쪽 끝 기록 수(순수 함수 — 리뷰 0.16.6 P1-1). 상한을 모르면 전부.
 * 하나도 안 들어가면 0(목록만 보낸다 — 다음 번에도 같으면 그 기록은 책에 남는다).
 */
export function endedThatFit(body: Record<string, unknown>, ended: readonly WireEnded[], maxBytes: number | undefined): number {
  if (maxBytes === undefined || ended.length === 0) return ended.length;
  const size = (count: number): number => Buffer.byteLength(JSON.stringify(count > 0 ? { ...body, ended: ended.slice(0, count) } : body), "utf8");
  let low = 0;
  let high = ended.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (size(mid) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return low;
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
