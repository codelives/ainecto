// 시험용 «claude -p --input-format stream-json» — 진짜 자식 프로세스. 받은 인자를 FAKE_CLAUDE_ARGS_LOG 에 한 줄씩 남기고,
// stdin 한 줄마다 init(처음 한 번) · 도구 호출 · result 를 낸다. 글로 동작을 고른다:
//   "write-doc"  → create_documents 결과(📄) + list_documents 결과(📄, 읽기) 뒤 reply
//   "bad-schema" → structured_output 에 모르는 칸
//   "hang"       → 답하지 않는다(기한 시험) — 줄 «@hang» 이 든 글(할 일 지시문)도 같다
//   "write-then-hang" → 문서 하나를 만든 뒤 답하지 않는다(중단 시험 — 그때까지 한 일이 남는가)
//   "crash"      → code 3 으로 끝난다
//   "write-card" → 만들기(created)·고치기·칸반 카드 결과(쓰기 셋) + 읽기 하나 뒤 reply
//   "write-failed" → 실패한 쓰기(is_error — 결과 글에 📄·카드가 있어도) + 성공한 고치기 하나 뒤 reply
//   "find-open"  → 읽기 둘(문서 찾기·카드 목록) + 실패한 읽기 하나 뒤, 본 것·실패한 것·없는 것을 open* 에 싣고 reply = «열기» 규칙 줄을 받았는가
// 글 맨 앞의 «열기» 규칙 줄([AiNecto rule] …)은 떼고 본다 — 나머지(맥락 줄 + 글)를 «got <글>» 로 돌려준다.
// control_request interrupt 가 오면 붙잡힌 차례를 error_during_execution 으로 끝낸다(실측 모양).
// `--version` · `auth status --json`(FAKE_CLAUDE_AUTH=out 이면 로그인 안 됨) 은 한 번 출력하고 끝난다.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGS_LOG) appendFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, `${JSON.stringify(args)}\n`);
if (args[0] === "--version") {
  process.stdout.write("9.9.9 (Claude Code)\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  const loggedIn = process.env.FAKE_CLAUDE_AUTH !== "out";
  process.stdout.write(`${JSON.stringify(loggedIn
    ? { loggedIn, authMethod: "claude.ai", email: "someone@example.com", subscriptionType: "max" }
    : { loggedIn, authMethod: "none" })}\n`);
  process.exit(loggedIn ? 0 : 1);
}
const resume = args.indexOf("--resume");
const sessionId = resume >= 0 ? args[resume + 1] : `sess-${process.pid}`;
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
let started = false;
let seen = 0;
let hanging = false;
const doc = (tag) => `📄 Open in AiNecto: https://dev.ainecto.com/app/docs/${tag.repeat(32)}`;
const tool = (id, name, texts, isError = false) => {
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: {} }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: texts.map((text) => ({ type: "text", text })),
    ...(isError ? { is_error: true } : {}) }] } });
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    out({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
    if (hanging) {
      hanging = false;
      out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId });
    }
    return;
  }
  const raw = message.message.content;
  const text = raw.replace(/^\[AiNecto rule\][^\n]*\n\n?/, "");
  seen += 1;
  if (!started) {
    started = true;
    out({ type: "system", subtype: "init", session_id: sessionId, tools: ["StructuredOutput"],
      apiKeySource: process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "none" });
  }
  if (text === "crash") process.exit(3);
  if (text === "hang" || text.includes("\n@hang\n")) {
    hanging = true;
    return;
  }
  if (text === "write-then-hang") {
    tool("w1", "mcp__ainecto__create_documents", [`{"count":1,"created":[{"uuid":"${"c".repeat(32)}","type":"markdown","title":"반쯤"}]}`, doc("c")]);
    hanging = true;
    return;
  }
  if (text === "write-card") {
    tool("r1", "mcp__ainecto__list_documents", ['{"documents":[]}', doc("a")]);
    tool("w1", "mcp__ainecto__create_documents", [`{"count":1,"created":[{"uuid":"${"c".repeat(32)}","type":"markdown","title":"새 문서"}]}`, doc("c")]);
    tool("w2", "mcp__ainecto__update_documents", [`{"updated":[{"uuid":"${"d".repeat(32)}","type":"markdown","title":"고친 문서"}]}`, doc("d")]);
    tool("w3", "mcp__ainecto__kanban_apply_changes", [`{"documentUuid":"${"e".repeat(32)}","results":[{"index":0,"op":"create","cardUuid":"${"f".repeat(32)}"}]}`, doc("e")]);
  }
  if (text === "write-failed") {
    tool("w1", "mcp__ainecto__kanban_apply_changes", [`{"documentUuid":"${"e".repeat(32)}","results":[{"index":0,"op":"create","cardUuid":"${"f".repeat(32)}"}]}`, doc("e")], true);
    tool("w2", "mcp__ainecto__update_documents", [`{"updated":[{"uuid":"${"d".repeat(32)}","type":"markdown","title":"고친 문서"}]}`, doc("d")]);
  }
  if (text === "write-doc") {
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__ainecto__list_documents", input: {} }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "{}" }, { type: "text", text: "📄 다른 문서: https://dev.ainecto.com/app/docs/" + "a".repeat(32) }] }] } });
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "mcp__ainecto__create_documents", input: {} }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "{}" }, { type: "text", text: "📄 Open in AiNecto: https://dev.ainecto.com/app/docs/" + "b".repeat(32) }] }] } });
  }
  let structured = text === "bad-schema" ? { reply: "x", documents: [] }
    : { reply: `got ${text} #${seen} in ${sessionId}`, openDocumentUuids: [], openCardUuids: [] };
  if (text === "find-open") {
    tool("r1", "mcp__ainecto__search_documents", [`{"documents":[{"uuid":"${"a".repeat(32)}","title":"찾은 문서"}]}`, doc("a")]);
    tool("r2", "mcp__ainecto__kanban_list_cards", [`{"cards":[{"card":{"uuid":"${"f".repeat(32)}","key":"KAN-1"}}]}`]);
    tool("r3", "mcp__ainecto__get_document", [`{"uuid":"${"b".repeat(32)}"}`, doc("b")], true);
    structured = { reply: `ruled=${raw.startsWith("[AiNecto rule]")}`,
      openDocumentUuids: ["a".repeat(32), "b".repeat(32), "9".repeat(32)], openCardUuids: ["f".repeat(32), "1".repeat(32)] };
  }
  out({ type: "result", subtype: "success", is_error: false, session_id: sessionId, structured_output: structured, num_turns: 2, total_cost_usd: 0.1 });
});
process.stdin.on("end", () => process.exit(0));
