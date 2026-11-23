// 시험용 «agy -p --input-format stream-json --output-format stream-json» — 진짜 자식 프로세스. 이벤트 모양은 실측 agy 1.5.14 그대로
// (init 의 conversation_id 는 최상위 · step_update/result 는 중첩). 받은 인자와 cwd 를 FAKE_AGY_ARGS_LOG 에 한 줄씩 남긴다.
// stdin 한 줄({"event":"user","message":{"content":…}})의 글로 동작을 고른다:
//   "write-doc" → 브리지 create_documents DONE(같은 단계 두 번) + ACTIVE·ERROR 단계 + 모르는 도구 이름 뒤 SUCCESS
//   "foreign"   → 브리지 밖 서버(other)의 도구가 DONE 뒤 SUCCESS(사후 대조 시험)
//   "fail"      → result status ERROR
//   "hang"      → init 만 내고 답하지 않는다(중단·기한 시험)
//   "crash"     → result 없이 code 3
//   "result-on-term" → 답하지 않다가 SIGTERM 을 받으면 result 를 낸 뒤 끝난다(멈춤·결과 경합)
//   "linger"    → result 를 낸 뒤 끝나지 않고 남는다(200ms 뒤 늦은 브리지 단계 하나 · SIGTERM 이면 끝) — 다음 차례 전 정리 시험
// FAKE_AGY_LIFE_LOG 가 있으면 -p 프로세스의 «start <pid>» · «end <pid>» 를 한 줄씩 남긴다.
//   그 밖       → reply «got <글>»
// `--version`(FAKE_AGY_VERSION) · `models`(FAKE_AGY_AUTH=out 이면 1) · `plugin list --json`(FAKE_AGY_PLUGINS · FAKE_AGY_PLUGINS_FAIL) 은 한 번 출력하고 끝난다.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
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
  // FAKE_AGY_PLUGINS_HOLD=<파일>: «<파일>.started» 를 만들고 <파일> 이 생길 때까지 답을 붙잡는다(사전 점검 중 멈춤 시험).
  const hold = process.env.FAKE_AGY_PLUGINS_HOLD;
  if (hold) {
    writeFileSync(`${hold}.started`, String(process.pid));
    while (!existsSync(hold)) await new Promise((r) => setTimeout(r, 20));
  }
  process.stdout.write(`${process.env.FAKE_AGY_PLUGINS ?? "[]"}\n`);
  process.exit(0);
}
if (process.env.FAKE_AGY_ARGS_LOG) appendFileSync(process.env.FAKE_AGY_ARGS_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
const life = process.env.FAKE_AGY_LIFE_LOG;
if (life) {
  appendFileSync(life, `start ${process.pid}\n`);
  process.on("exit", () => appendFileSync(life, `end ${process.pid}\n`));
}
process.on("SIGTERM", () => process.exit(0));
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
  if (text === "result-on-term") {   // 멈춤(SIGTERM)과 결과가 겹치는 경우 — 끄라는 신호를 받은 뒤 result 를 내고 끝난다
    process.removeAllListeners("SIGTERM");
    process.on("SIGTERM", () => { reply("finished anyway"); process.exit(0); });
    setInterval(() => {}, 1_000);
    return;
  }
  if (text === "linger") {
    reply("lingering");
    setTimeout(() => step(9, "DONE", mcp("ainecto-pc", "create_documents", { output: doc("z") })), 200);
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
    // 실측 모양: MCP content 조각(JSON · 📄 줄 · 알림 줄)을 줄바꿈으로 이은 글 하나
    const created = `${JSON.stringify({ created: [{ uuid: "a".repeat(32), title: "t" }], count: 1 })}\n${doc("a")}\n${"a".repeat(32)} marked as being written.`;
    step(2, "DONE", mcp("ainecto-pc", "create_documents", { output: created }));
    step(2, "DONE", mcp("ainecto-pc", "create_documents", { output: created }));
    step(3, "ERROR", mcp("ainecto-pc", "update_documents", { output: doc("b"), error: { type: "TOOL_ERROR", message: "x" } }));
    step(4, "DONE", mcp("ainecto-pc", "not_a_public_tool", { output: doc("c") }));
    step(5, "DONE", mcp("ainecto-pc", "search", { output: doc("d") }));
    reply("wrote");
    return;
  }
  reply(`got ${text}`);
});
