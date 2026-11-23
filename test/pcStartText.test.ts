import { describe, expect, it } from "vitest";
import { pcResultText, preflightNotes } from "../src/adapters/cli/pcStartText";
import type { DoctorCheck } from "../src/core/setup/doctorChecks";

/** `ainecto` 기본 실행 글 — 결과 먼저 · 내부 용어 없음 · 에이전트 경고 한 줄 · 직무는 doctor 에만(Ryan 11-21). */
const notConnected = (item: string): DoctorCheck => ({ item, level: "warn", detail: "not connected to AiNecto", fix: "ainecto setup" });

describe("ainecto 기본 실행 글", () => {
  it("에이전트 «항목 없음» 경고는 한 줄로 합치고, 로컬 설정만 본다는 것을 정직하게 말한다", () => {
    const lines = preflightNotes([
      notConnected("Claude Code"), notConnected("Cursor"), notConnected("Codex"),
      { item: "AiNecto job title", level: "warn", detail: "not set — AI uses it to pitch explanations; it does not change permissions", fix: "set it at https://ainecto.com/home/settings" },
      { item: "AiNecto sign-in", level: "ok", detail: "signed in" },
    ]);
    expect(lines).toEqual([
      "! To use AiNecto from Claude Code, Cursor and Codex on this computer, run `ainecto setup` — their settings here "
        + "have no AiNecto entry yet (a connector you added in your claude.ai or ChatGPT account is not checked here).",
    ]);
    expect(lines.join("\n")).not.toContain("not connected");
    expect(lines.join("\n")).not.toContain("job title");
  });

  it("다른 경고·실패는 그대로 한 줄씩", () => {
    expect(preflightNotes([
      { item: "AiNecto server", level: "fail", detail: "unreachable", fix: "ainecto doctor" },
      notConnected("Codex"),
    ])).toEqual([
      "! To use AiNecto from Codex on this computer, run `ainecto setup` — its settings here have no AiNecto entry yet "
        + "(a connector you added in your claude.ai or ChatGPT account is not checked here).",
      "✗ AiNecto server: unreachable — fix: ainecto doctor",
    ]);
  });

  it("결과 글 — 연결됐다 · 무엇에 쓰나 · 창을 닫아도 돈다 · 끄는 법, 세션 이름 없음", () => {
    const text = pcResultText({ kind: "connected", agentMissing: false, log: "~/.ainecto/agent/agent.log" });
    expect(text).toMatch(/^This PC is now connected to AiNecto\. From AiNecto on the web you can open a terminal on this PC/);
    expect(text).toContain("It keeps running after you close this window. To stop it, run `ainecto stop`.");
    expect(text).not.toContain("session");
    expect(pcResultText({ kind: "connected", agentMissing: true, log: "L" })).toContain("No Claude Code, Codex or Antigravity was found");
    expect(pcResultText({ kind: "already", folder: "/w", version: "1.0.0", log: "L" }))
      .toBe("This PC is already connected to AiNecto (folder /w, version 1.0.0). To stop it, run `ainecto stop`. Log: L");
  });
});
