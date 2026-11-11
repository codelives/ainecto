import type { TurnOutcome } from "./claudeProcess";

export interface AgentReply {
  status: "DONE" | "FAILED";
  reply: string;
  documentUuids: string[];
  errorCode?: string;
}

/**
 * Claude 한 차례 결과 → 서버에 보낼 답(순수 함수). ★schema 를 지킨 {@code structured_output.reply} 만 DONE.
 * 어긴 답은 원문을 FAILED 로 보인다(설계 1절). 글 상한·문서 상한은 서버 open 응답의 값.
 */
export function replyForOutcome(outcome: TurnOutcome, limits: { textMaxCharacters: number; documentsMax: number }): AgentReply {
  const documentUuids = outcome.kind === "result" ? outcome.documents.slice(0, limits.documentsMax) : [];
  const failed = (errorCode: string, text: string): AgentReply =>
    ({ status: "FAILED", errorCode, reply: clip(text, limits.textMaxCharacters), documentUuids });
  switch (outcome.kind) {
    case "timeout":
      return failed("TURN_TIMEOUT", "제한 시간 안에 끝나지 않아 멈췄어요. 다시 보내 주세요.");
    case "exited":
      return failed("AGENT_EXITED", `Claude Code 가 끝났어요(code ${outcome.code ?? "-"}${outcome.signal ? `, ${outcome.signal}` : ""}).`
        + (outcome.stderrTail ? `\n${outcome.stderrTail}` : ""));
    case "result": {
      const { result } = outcome;
      if (result.isError) {
        return failed("AGENT_ERROR", `Claude Code 가 실패했어요(${result.subtype ?? "error"}).`
          + (result.resultText ? `\n${result.resultText}` : ""));
      }
      const reply = (result.structuredOutput as { reply?: unknown } | undefined)?.reply;
      const keys = result.structuredOutput && typeof result.structuredOutput === "object"
        ? Object.keys(result.structuredOutput as object) : [];
      if (typeof reply === "string" && reply.trim().length > 0 && keys.length === 1
          && codePoints(reply) <= limits.textMaxCharacters) {
        return { status: "DONE", reply, documentUuids };
      }
      const raw = result.structuredOutput !== undefined ? JSON.stringify(result.structuredOutput) : result.resultText ?? "";
      return failed("SCHEMA_VIOLATION", `답 형식이 어긋났어요.\n${raw}`);
    }
  }
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

/** 글자(코드 포인트) 단위로 자른다 — 서버 상한과 같은 단위. 빈 글은 보내지 않는다. */
function clip(text: string, max: number): string {
  const chars = Array.from(text.trim() || "-");
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}
