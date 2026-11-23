// 시험용 «agy -p --input-format stream-json --output-format stream-json» — 진짜 자식 프로세스. 이벤트 모양은 실측 agy 1.5.14 그대로
// (init 의 conversation_id 는 최상위 · step_update/result 는 중첩). 받은 인자와 cwd 를 FAKE_AGY_ARGS_LOG 에 한 줄씩 남긴다.
// stdin 한 줄({"event":"user","message":{"content":…}})의 글로 동작을 고른다:
//   "write-doc" → 브리지 create_documents DONE(같은 단계 두 번) + ACTIVE·ERROR 단계 + 모르는 도구 이름 뒤 SUCCESS
//   "foreign"   → 브리지 밖 서버(other)의 도구가 DONE 뒤 SUCCESS(사후 대조 시험)
//   "fail"      → result status ERROR
//   "hang"      → init 만 내고 답하지 않는다(중단·기한 시험)
//   "crash"     → result 없이 code 3
//   그 밖       → reply «got <글>»
// `--version`(FAKE_AGY_VERSION) · `models`(FAKE_AGY_AUTH=out 이면 1) · `plugin list --json`(FAKE_AGY_PLUGINS · FAKE_AGY_PLUGINS_FAIL) 은 한 번 출력하고 끝난다.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write(`${process.env.FAKE_AGY_VERSION ?? "1.5.14"}\n`);
  process.exit(0);
}
if (args[0] === "models") {
  if (process.env.FAKE_AGY_AUTH === "out") {
    process.stderr.write("Please sign in\n");
    process.exit(1);
  }
  process.stdout.write("gemini-3.8-flash-low\n");
  process.exit(0);
}
if (args[0] === "plugin" && args[1] === "list") {
  if (process.env.FAKE_AGY_PLUGINS_FAIL) process.exit(2);
  process.stdout.write(`${process.env.FAKE_AGY_PLUGINS ?? "[]"}\n`);
  process.exit(0);
}
if (process.env.FAKE_AGY_ARGS_LOG) appendFileSync(process.env.FAKE_AGY_ARGS_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
const resume = args.indexOf("--conversation");
const conversationId = resume >= 0 ? args[resume + 1] : `conv-${process.pid}`;
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
const step = (index, state, tool) => out({ event: "step_update", step_update: { step_index: index, state, step_type: "tool", tool_info: tool } });
const mcp = (server, tool, extra = {}) => ({ name: "call_mcp_tool", parameters: { ServerName: server, ToolName: tool, Arguments: {} }, ...extra });
const doc = (tag) => `📄 Open in AiNecto: https://dev.ainecto.com/app/docs/${tag.repeat(32)}`;
const reply = (text) => out({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "{}", num_turns: 1,
  structured_output: { reply: text, openDocumentUuids: [], openCardUuids: [] }, usage: { input_tokens: 10, output_tokens: 2 } } });

createInterface({ input: process.stdin }).once("line", (line) => {
  const text = JSON.parse(line).message.content;
  out({ event: "init", conversation_id: conversationId, init: { model: "fake", cwd: process.cwd(), tools: ["call_mcp_tool"] } });
  if (text === "crash") process.exit(3);
  if (text === "hang") {
    setInterval(() => {}, 1_000);
    return;
  }
  if (text === "fail") {
    out({ event: "result", result: { conversation_id: conversationId, status: "ERROR", response: "boom" } });
    return;
  }
  if (text === "foreign") {
    step(2, "DONE", mcp("other", "ping", { output: "pong" }));
    reply("done");
    return;
  }
  if (text === "write-doc") {
    step(2, "ACTIVE", mcp("ainecto-pc", "create_documents"));
    step(2, "DONE", mcp("ainecto-pc", "create_documents", { output: doc("a") }));
    step(2, "DONE", mcp("ainecto-pc", "create_documents", { output: doc("a") }));
    step(3, "ERROR", mcp("ainecto-pc", "update_documents", { output: doc("b"), error: { type: "TOOL_ERROR", message: "x" } }));
    step(4, "DONE", mcp("ainecto-pc", "not_a_public_tool", { output: doc("c") }));
    step(5, "DONE", mcp("ainecto-pc", "search", { output: doc("d") }));
    reply("wrote");
    return;
  }
  reply(`got ${text}`);
});
