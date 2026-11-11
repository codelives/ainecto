// 시험용 «claude -p --input-format stream-json» — 진짜 자식 프로세스. 받은 인자를 FAKE_CLAUDE_ARGS_LOG 에 한 줄씩 남기고,
// stdin 한 줄마다 init(처음 한 번) · 도구 호출 · result 를 낸다. 글로 동작을 고른다:
//   "write-doc"  → create_documents 결과(📄) + list_documents 결과(📄, 읽기) 뒤 reply
//   "bad-schema" → structured_output 에 모르는 칸
//   "hang"       → 답하지 않는다(기한 시험)
//   "crash"      → code 3 으로 끝난다
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGS_LOG) appendFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, `${JSON.stringify(args)}\n`);
const resume = args.indexOf("--resume");
const sessionId = resume >= 0 ? args[resume + 1] : `sess-${process.pid}`;
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
let started = false;
let seen = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const text = JSON.parse(line).message.content;
  seen += 1;
  if (!started) {
    started = true;
    out({ type: "system", subtype: "init", session_id: sessionId, tools: ["StructuredOutput"] });
  }
  if (text === "crash") process.exit(3);
  if (text === "hang") return;
  if (text === "write-doc") {
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__ainecto__list_documents", input: {} }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "{}" }, { type: "text", text: "📄 다른 문서: https://dev.ainecto.com/app/docs/" + "a".repeat(32) }] }] } });
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "mcp__ainecto__create_documents", input: {} }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "{}" }, { type: "text", text: "📄 Open in AiNecto: https://dev.ainecto.com/app/docs/" + "b".repeat(32) }] }] } });
  }
  const structured = text === "bad-schema" ? { reply: "x", documents: [] } : { reply: `got ${text} #${seen} in ${sessionId}` };
  out({ type: "result", subtype: "success", is_error: false, session_id: sessionId, structured_output: structured, num_turns: 2, total_cost_usd: 0.1 });
});
process.stdin.on("end", () => process.exit(0));
