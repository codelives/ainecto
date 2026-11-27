/**
 * holder 말 — 바깥(`term daemon`)이 holder(`term holder`)에 보내는 요청의 op·칸 목록(세션 유지 구조 설계 3-1 «말은 추가만»).
 * ★한 번 낸 op·칸은 지우지도, 이름을 바꾸지도, 뜻을 바꾸지도 않는다. 새 일은 새 op·새 칸으로만 더한다.
 *   이 목록은 기준 파일(test/fixtures/holder-talk.baseline.json — 덧붙이기만)과 견주는 시험이 지킨다.
 * 선 위 모양(파싱)은 protocol.ts 한 곳이다 — 이 표는 «holder 가 무엇을 아는가»를 바깥에 알리는 기능 묻기(caps)의 값이다.
 */
export const HOLDER_TALK: Readonly<Record<string, readonly string[]>> = {
  hello: ["nonce"],
  caps: [],
  lease: ["outer", "version"],
  via: ["outer"],
  new: ["name", "cwd", "command", "env", "cols", "rows", "project", "input", "kind"],
  ls: [],
  "ended-ack": ["instances"],
  "listed-to": ["to", "instances"],
  send: ["name", "text", "paste", "instance"],
  key: ["name", "key", "instance"],
  read: ["name", "scrollback", "lines", "styles"],
  kill: ["name", "instance"],
  "kill-server": ["holder"],
  restore: ["env"],
  attach: ["name", "cols", "rows"],
  detach: [],
  watch: ["name"],
  "watch-sessions": [],
  "set-size": ["name", "cols", "rows", "instance"],
  label: ["name", "label", "instance"],
  /** attach 흐름 줄(id 없음). */
  in: ["d"],
  resize: ["cols", "rows"],
};

/** holder 의 기능 묻기 답. */
export interface HolderCaps {
  /** holder uuid — 시작할 때 한 번 뽑는다(holder 평생 같음). kill-server 는 이 값을 실어야 받는다. */
  holder: string;
  pid: number;
  /** holder 를 띄운 CLI 판. */
  version: string;
  /** 아는 op 와 그 칸({@link HOLDER_TALK}). */
  talk: Record<string, string[]>;
  /** 지금 쓰기 임대를 쥔 바깥 — 없으면 null. */
  lease: { outer: string; version: string } | null;
}

/** caps 답 → holder 기능. 모양이 틀리면 undefined(옛 구조 데몬은 caps 에 답하지 않고 끊는다). 순수 함수. */
export function holderCaps(data: unknown): HolderCaps | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as Record<string, unknown>;
  const lease = value.lease;
  const leaseOk = lease === null || (!!lease && typeof lease === "object"
    && typeof (lease as Record<string, unknown>).outer === "string" && typeof (lease as Record<string, unknown>).version === "string");
  const talk = value.talk;
  const talkOk = !!talk && typeof talk === "object" && !Array.isArray(talk)
    && Object.values(talk).every((fields) => Array.isArray(fields) && fields.every((field) => typeof field === "string"));
  if (typeof value.holder !== "string" || typeof value.pid !== "number" || typeof value.version !== "string" || !leaseOk || !talkOk) return undefined;
  return {
    holder: value.holder,
    pid: value.pid,
    version: value.version,
    talk: talk as Record<string, string[]>,
    lease: lease as HolderCaps["lease"],
  };
}
