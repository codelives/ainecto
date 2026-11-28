import { describe, expect, it } from "vitest";
import { ownResidents } from "./termRig";

/** 실물 시험의 정리 — 이 시험이 띄운 상주 프로세스만 고른다(세션 유지 구조 리뷰 r1 P0-1 · 가상 ps 표로). */
describe("시험 정리 — 이 시험이 띄운 상주 프로세스만(ownResidents)", () => {
  const table = [
    "  101 node /tmp/aterm-dist-ab/a/dist/bin/ainecto.js term daemon",
    "  102 node /tmp/aterm-x1/.ainecto/term/holder/0123456789abcdef/ainecto.js term holder",
    "  103 /usr/bin/vim /tmp/aterm-x1/notes.txt",
    "  104 node /Users/someone/.npm/_npx/ainecto.js term daemon",
    "  105 /sbin/launchd",
  ].join("\n");

  it("★준비가 폴더를 정하기 전에 끊겼다(out·home 빈 문자열) — 아무것도 고르지 않는다", () => {
    expect(ownResidents(table, ["", ""], 1)).toEqual([]);
  });

  it("이 시험 폴더의 바깥·holder 만 — 같은 폴더의 다른 프로그램 · 남의 데몬 · 자기 자신은 뺀다", () => {
    expect(ownResidents(table, ["/tmp/aterm-dist-ab", "/tmp/aterm-x1"], 1)).toEqual([101, 102]);
    expect(ownResidents(table, ["/tmp/aterm-dist-ab", ""], 101)).toEqual([]);
  });
});

