import { createHash } from "node:crypto";

import type { CellStyle, ScreenCursor } from "./screen";

/**
 * 원격 다리 화면 한 장 — 순수 함수(출처 = 사용자 web-cmux agent 의 textFrame: 줄 목록 → 평문 화면).
 * 글자는 평문이다 — 데몬 `read` 의 줄을 {@code \r\n} 으로 잇고, UTF-8 → base64 로 — 봉인 본문의 {@code d}(설계 §14-4 · A6).
 * 글자 속성(색·흐림·굵기·반전)과 커서는 {@code d} 옆의 선택 칸이다(Ryan 11-25 색 싣기) — 옛 웹은 모르는 칸을 버리고 글자만 그린다.
 */
export interface ScreenFrame {
  /** base64(UTF-8 평문) — 봉인 frame 본문의 {@code d}. */
  d: string;
  /** 속성 구간 — {@code d} 의 줄과 같은 수(덜어 낸 줄은 같이 덜어 낸다). 속성이 없으면 없다. */
  runs?: number[][];
  /** 커서 — 줄 번호는 덜어 낸 뒤의 번호. 덜어 낸 줄에 있었으면 없다. */
  cursor?: ScreenCursor;
  /** 글자·속성·커서의 sha256 — 바뀐 때만 올린다. */
  hash: string;
  /** 본문 상한에 맞추려고 위(오래된 쪽)에서 덜어 낸 줄 수. */
  dropped: number;
}

/** 화면과 함께 싣는 속성 — 데몬 `read`(styles) 그대로. */
export interface ScreenAttributes {
  styles: CellStyle[];
  runs: number[][];
  cursor?: ScreenCursor;
}

/**
 * 줄 → 화면. {@code maxD}(봉인 본문에서 {@code d}·구간·커서가 쓸 수 있는 바이트) 를 넘으면 위 줄부터 덜어 낸다 —
 * 서버가 준 frame 상한(C3)을 넘겨 거절(413)당하지 않게. 구간은 그 줄과 함께 덜어 낸다. 한 줄만으로도 넘으면 빈 화면이다.
 * ★속성 표(styles)는 {@link frameBudget} 의 봉인 칸에 넣어 센다 — 여기서는 줄마다 늘고 주는 것만 센다.
 */
export function screenFrame(lines: readonly string[], maxD: number, attributes?: ScreenAttributes): ScreenFrame {
  const sizes = lines.map((line) => Buffer.byteLength(line, "utf8"));
  const runs = attributes?.runs.length === lines.length ? attributes.runs : undefined;
  const runSizes = runs ? runs.map((row) => JSON.stringify(row).length + 1) : [];
  let start = 0;
  let bytes = sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, lines.length - 1) * 2;
  // `,"runs":[` + `]` 와 `,"cursor":{"row":…,"col":…}` 를 가장 길게.
  const fixed = runs ? 10 + CURSOR_BYTES : 0;
  let runBytes = runSizes.reduce((sum, size) => sum + size, 0);
  while (start < lines.length && base64Length(bytes) + fixed + runBytes > maxD) {
    bytes -= (sizes[start] ?? 0) + (start < lines.length - 1 ? 2 : 0);
    runBytes -= runSizes[start] ?? 0;
    start += 1;
  }
  const text = lines.slice(start).join("\r\n");
  const kept = runs?.slice(start);
  const cursorRow = attributes?.cursor ? attributes.cursor.row - start : -1;
  const cursor = attributes?.cursor && cursorRow >= 0 ? { row: cursorRow, col: attributes.cursor.col } : undefined;
  const hash = createHash("sha256").update(text, "utf8");
  if (kept) hash.update(JSON.stringify([attributes?.styles, kept, cursor ?? null]), "utf8");
  return {
    d: Buffer.from(text, "utf8").toString("base64"),
    ...(kept ? { runs: kept } : {}),
    ...(cursor ? { cursor } : {}),
    hash: hash.digest("hex"),
    dropped: start,
  };
}

/** 커서 칸이 가장 길 때 — 줄·칸 번호를 2^32−1 로 센다. */
const CURSOR_BYTES = Buffer.byteLength(JSON.stringify({ cursor: { row: 2 ** 32 - 1, col: 2 ** 32 - 1 } }), "utf8");

/** GCM 태그(128비트) — 암호문 뒤에 붙는다(e2e.ts). */
const GCM_TAG_BYTES = 16;
/** 번호 칸(n·executedThrough)이 가장 길 때 — 2^32−1(C-E4). 상한 계산은 늘 가장 긴 값으로. */
const MAX_COUNTER = 2 ** 32 - 1;

/**
 * 봉인 frame 의 {@code d} 자리(base64 글자 수) — 서버 상한 {@code frameMaxBytes} 에서 ①바깥 JSON 칸(linkId·channelId·session·크기·n)
 * ②base64url(패딩 없음) 덧붙임 ③GCM 태그 16 ④봉인 본문의 {@code d} 밖 칸(modes·instance·executedThrough·속성 표 styles)을 뺀다(설계 §6 화면 상한).
 * 번호 칸은 가장 긴 값으로 센다 — 번호가 자라도 넘지 않는다. 순수 함수.
 */
export function frameBudget(frameMaxBytes: number, outer: Record<string, unknown>, sealed: Record<string, unknown>): number {
  const outside = Buffer.byteLength(JSON.stringify({ ...outer, n: MAX_COUNTER, c: "" }), "utf8");
  const cipherBytes = Math.floor(((frameMaxBytes - outside) * 3) / 4);
  const inside = Buffer.byteLength(JSON.stringify({ ...sealed, d: "", executedThrough: MAX_COUNTER }), "utf8");
  return cipherBytes - GCM_TAG_BYTES - inside;
}

function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}
