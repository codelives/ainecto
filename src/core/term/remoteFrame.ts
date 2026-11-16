import { createHash } from "node:crypto";

/**
 * `term remote` 화면 한 장 — 순수 함수(출처 = 사용자 web-cmux agent 의 textFrame: 줄 목록 → 평문 화면).
 * 1차는 색·커서 없는 평문이다. 데몬 `read` 의 줄을 {@code \r\n} 으로 잇고, UTF-8 → base64 로 싣는다.
 */
export interface ScreenFrame {
  /** base64(UTF-8 평문) — frame 본문의 {@code d}. */
  d: string;
  /** 평문의 sha256 — 바뀐 때만 올린다. */
  hash: string;
  /** 본문 상한에 맞추려고 위(오래된 쪽)에서 덜어 낸 줄 수. */
  dropped: number;
}

/**
 * 줄 → 화면. {@code maxD}(base64 글자 수 = 바이트) 를 넘으면 위 줄부터 덜어 낸다 — 서버가 준 frame 상한(C3)을 넘겨 거절(413)당하지 않게.
 * 한 줄만으로도 넘으면 빈 화면이다.
 */
export function screenFrame(lines: readonly string[], maxD: number): ScreenFrame {
  const sizes = lines.map((line) => Buffer.byteLength(line, "utf8"));
  let start = 0;
  let bytes = sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, lines.length - 1) * 2;
  while (start < lines.length && base64Length(bytes) > maxD) {
    bytes -= (sizes[start] ?? 0) + (start < lines.length - 1 ? 2 : 0);
    start += 1;
  }
  const text = lines.slice(start).join("\r\n");
  return {
    d: Buffer.from(text, "utf8").toString("base64"),
    hash: createHash("sha256").update(text, "utf8").digest("hex"),
    dropped: start,
  };
}

/** frame 본문 상한(서버 {@code frameMaxBytes}) 에서 {@code d} 밖 JSON 칸을 뺀 {@code d} 의 자리. */
export function frameBudget(frameMaxBytes: number, body: { remoteId: string; cols: number; rows: number }): number {
  return frameMaxBytes - Buffer.byteLength(JSON.stringify({ ...body, d: "" }), "utf8");
}

function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}
