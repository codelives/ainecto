import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOLDER_TALK } from "../src/core/term/holderTalk";
import { parseClientMessage } from "../src/core/term/protocol";

/**
 * holder 말은 «추가만»(세션 유지 구조 설계 3-1) — 열린 세션을 쥔 holder 는 판이 바뀌어도 그대로라, 바깥이 보낼 수 있는 op·칸이
 * 사라지거나 뜻이 바뀌면 «바깥이 holder 와 말을 못 한다»가 생긴다. 기준 파일은 덧붙이기만 한다(구현자가 갈아끼우지 않는다).
 */
const baseline = (JSON.parse(readFileSync(join(__dirname, "fixtures/holder-talk.baseline.json"), "utf8")) as { talk: Record<string, string[]> }).talk;

/** op 마다 모든 칸을 채운 요청 한 줄 — 선 위 모양(protocol.ts)이 그 칸을 읽는지 본다. */
const SAMPLE: Record<string, unknown> = {
  nonce: "n", outer: "00000000-0000-4000-8000-000000000001", version: "0.16.7", pid: 4242, name: "a", cwd: "/", command: ["sh"], env: {}, cols: 80, rows: 24,
  project: "00000000-0000-4000-8000-000000000002", input: "none", kind: "user", instances: ["i"], to: "t", text: "x", paste: true,
  instance: "i", key: "Enter", scrollback: true, lines: 3, styles: true, holder: "00000000-0000-4000-8000-000000000003", label: "L", d: "eA==", file: "/opt/ainecto/dist/term/compute.js",
};

describe("holder 말 — 기준 파일보다 줄지 않는다", () => {
  it("기준의 op·칸이 모두 지금 말에 있다(지움·이름 바꿈 0)", () => {
    const missing = Object.entries(baseline).flatMap(([op, fields]) =>
      HOLDER_TALK[op] === undefined ? [op] : fields.filter((field) => !HOLDER_TALK[op]!.includes(field)).map((field) => `${op}.${field}`));
    expect(missing).toEqual([]);
  });

  it("지금 말의 op 마다 모든 칸을 실은 줄을 선 위 모양이 읽는다(표와 파서가 어긋나지 않는다)", () => {
    for (const [op, fields] of Object.entries(HOLDER_TALK)) {
      const line = JSON.stringify({ op, ...(op === "in" || op === "resize" ? {} : { id: "r" }), ...Object.fromEntries(fields.map((field) => [field, SAMPLE[field]])) });
      const parsed = parseClientMessage(line) as unknown as Record<string, unknown>;
      expect({ op, fields: fields.filter((field) => parsed[field] === undefined) }).toEqual({ op, fields: [] });
    }
  });
});
