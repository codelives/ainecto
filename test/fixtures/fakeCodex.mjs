// 시험용 «codex app-server» — 진짜 자식 프로세스, 줄 하나 = JSON-RPC 메시지 하나(실측 모양: jsonrpc 칸 없음).
// 받은 인자를 FAKE_CODEX_ARGS_LOG 에 한 줄씩 남긴다. `--version` 은 한 줄 출력하고 끝난다.
// account/read 는 FAKE_CODEX_ACCOUNT=none 이면 로그인 안 됨. config/read 는 사용자 설정의 MCP 서버 셋(ainecto(url)·node_repl·openaiDeveloperDocs)에
// 인자의 브리지(`-c mcp_servers.<이름>.command`)를 진짜 Codex 처럼 깊게 합쳐 돌려준다 — 같은 이름에 url·command 가 겹치면 진짜처럼 거절(KAN-1617 실측).
// FAKE_CODEX_RESUME_AS 가 있으면 thread/resume 이 그 id 를 돌려준다(다른 thread 로 이어짐). thread/start·resume 은 config 칸에서 `mcp_servers.<이름>.enabled=false` 로 끄지 않은 서버만 띄운다(startupStatus). thread/resume 의 threadId 가 "thr-gone" 이면 오류.
// turn/start 의 글로 동작을 고른다:
//   "write-card" → 읽기 하나 · 만들기(created) · 고치기 · 칸반 카드 · 다른 MCP 서버 도구 결과 뒤 답
//   "write-failed" → 실패한 쓰기(status failed — 결과 글에 📄·카드가 있어도) + 성공한 고치기 하나 뒤 답
//   "find-open"  → 읽기 둘(문서 찾기·카드 목록) + 실패한 읽기 + 다른 MCP 서버 결과 뒤, 본 것·실패한 것·없는 것을 open* 에 싣고
//                  reply = «열기» 규칙 줄을 받았는가
//   "approval"   → 우리에게 mcpServer/elicitation/request 를 묻고, 받은 답을 그대로 답 글에 싣는다
//   "bad-schema" → 답 글이 JSON 이 아니다
//   "fail"       → turn 이 failed 로 끝난다
//   "hang"       → 끝내지 않는다(turn/interrupt 가 오면 interrupted 로 끝낸다)
//   "crash"      → code 3 으로 끝난다
//   그 밖        → {"reply":"got <글> #<이 프로세스의 차례 수> in <threadId>","openDocumentUuids":[],"openCardUuids":[]}
// 글 맨 앞의 «열기» 규칙 줄([AiNecto rule] …)은 떼고 본다.
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_ARGS_LOG) appendFileSync(process.env.FAKE_CODEX_ARGS_LOG, `${JSON.stringify(args)}\n`);
if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.0.0-fake\n");
  process.exit(0);
}

/** 이 CLI 브리지 이름 — 프로세스 인자 `-c mcp_servers.<이름>.command=…` 에서. */
const BRIDGE = args.map((arg) => /^mcp_servers\.([^.=]+)\.command=/.exec(arg)?.[1]).find(Boolean);
/** 사용자 Codex 설정 — setup 의 `codex mcp add ainecto --url` 그대로(KAN-1617). */
const USER_SERVERS = { ainecto: { url: "https://dev.ainecto.com/mcp" }, node_repl: { command: "node" }, openaiDeveloperDocs: { url: "https://x" } };
/** 진짜 Codex 0.171.0 실측: `-c` 는 사용자 표와 깊게 합쳐져 같은 항목에 url·command → 설정 읽기·thread 시작 모두 거절. */
const CONFLICT = BRIDGE && USER_SERVERS[BRIDGE]?.url ? `url is not supported for stdio\nin \`mcp_servers.${BRIDGE}\`\n` : null;

const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let thread;
let turns = 0;
let hangingTurn;
let answerWaiter;
const doc = (tag) => `📄 Open in AiNecto: https://dev.ainecto.com/app/docs/${tag.repeat(32)}`;
const item = (turnId, value) => out({ method: "item/completed", params: { threadId: thread, turnId, item: value } });
const toolCall = (turnId, server, tool, texts, status = "completed") =>
  item(turnId, { type: "mcpToolCall", id: `call-${tool}`, server, tool, status,
    result: { content: texts.map((text) => ({ type: "text", text })), structuredContent: null },
    error: status === "failed" ? { message: "tool failed" } : null });
const complete = (turnId, status, text, error = null) => {
  if (text !== undefined) item(turnId, { type: "agentMessage", id: `msg-${turnId}`, text });
  out({ method: "turn/completed", params: { threadId: thread, turn: { id: turnId, status, error, items: [] } } });
};
const reply = (text, openDocumentUuids = [], openCardUuids = []) => JSON.stringify({ reply: text, openDocumentUuids, openCardUuids });

function startServers(config = {}) {
  for (const name of [...new Set([BRIDGE, ...Object.keys(USER_SERVERS)])].filter(Boolean)) {
    if (config?.[`mcp_servers.${name}.enabled`] === false) continue;
    out({ method: "mcpServer/startupStatus/updated", params: { threadId: thread, name, status: "starting", error: null } });
    out({ method: "mcpServer/startupStatus/updated", params: { threadId: thread, name, status: "ready", error: null } });
  }
}

/** FAKE_CODEX_HOLD_THREAD 파일이 있으면 그 파일을 지우고 thread/start·resume 에 답하지 않는다(한 번 · 준비 단계 기한·멈춤 시험). */
function holdThread() {
  const marker = process.env.FAKE_CODEX_HOLD_THREAD;
  if (!marker || !existsSync(marker)) return false;
  unlinkSync(marker);
  return true;
}

function act(turnId, raw) {
  const text = raw.replace(/^\[AiNecto rule\][^\n]*\n\n?/, "");
  // 새 글 알림 줄([AiNecto chat] — 설계 connect C2)이 있으면 그 뒤가 명령이다. 답 글(got …)에는 받은 글을 그대로 싣는다.
  const command = text.replace(/^\[AiNecto chat\][^\n]*\n\n?/, "");
  if (command === "crash") process.exit(3);
  if (command === "hang") {
    hangingTurn = turnId;
    return;
  }
  if (command === "fail") {
    complete(turnId, "failed", undefined, { message: "model said no" });
    return;
  }
  if (command === "bad-schema") {
    complete(turnId, "completed", "not json at all");
    return;
  }
  if (command === "approval") {
    answerWaiter = (answer) => complete(turnId, "completed", reply(`answer ${JSON.stringify(answer)}`));
    out({ id: 900, method: "mcpServer/elicitation/request",
      params: { threadId: thread, turnId, serverName: BRIDGE, message: "Allow create_documents?" } });
    return;
  }
  if (command === "write-card") {
    toolCall(turnId, BRIDGE, "list_documents", ['{"documents":[]}', doc("a")]);
    toolCall(turnId, BRIDGE, "create_documents", [`{"count":1,"created":[{"uuid":"${"c".repeat(32)}","type":"markdown","title":"새 문서"}]}`, doc("c")]);
    toolCall(turnId, BRIDGE, "update_documents", [`{"updated":[{"uuid":"${"d".repeat(32)}","type":"markdown","title":"고친 문서"}]}`, doc("d")]);
    toolCall(turnId, BRIDGE, "kanban_apply_changes", [`{"documentUuid":"${"e".repeat(32)}","results":[{"index":0,"op":"create","cardUuid":"${"f".repeat(32)}"}]}`, doc("e")]);
    toolCall(turnId, "other", "create_documents", [`{"created":[{"uuid":"${"9".repeat(32)}","type":"x","title":"y"}]}`, doc("9")]);
  }
  if (command === "write-failed") {
    toolCall(turnId, BRIDGE, "kanban_apply_changes", [`{"documentUuid":"${"e".repeat(32)}","results":[{"index":0,"op":"create","cardUuid":"${"f".repeat(32)}"}]}`, doc("e")], "failed");
    toolCall(turnId, BRIDGE, "update_documents", [`{"updated":[{"uuid":"${"d".repeat(32)}","type":"markdown","title":"고친 문서"}]}`, doc("d")]);
  }
  if (command === "find-open") {
    toolCall(turnId, BRIDGE, "search_documents", [`{"documents":[{"uuid":"${"a".repeat(32)}","title":"찾은 문서"}]}`, doc("a")]);
    toolCall(turnId, BRIDGE, "kanban_list_cards", [`{"cards":[{"card":{"uuid":"${"f".repeat(32)}","key":"KAN-1"}}]}`]);
    toolCall(turnId, BRIDGE, "get_document", [`{"uuid":"${"b".repeat(32)}"}`, doc("b")], "failed");
    toolCall(turnId, "other", "search", [`{"uuid":"${"9".repeat(32)}"}`]);
    complete(turnId, "completed", reply(`ruled=${raw.startsWith("[AiNecto rule]")}`,
      ["a".repeat(32), "b".repeat(32), "9".repeat(32)], ["f".repeat(32), "1".repeat(32)]));
    return;
  }
  complete(turnId, "completed", reply(`got ${text} #${turns} in ${thread}`));
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined && msg.id !== undefined) {
    // 우리가 물은 것(승인)에 대한 클라이언트 답.
    const waiter = answerWaiter;
    answerWaiter = undefined;
    waiter?.(msg.result ?? msg.error);
    return;
  }
  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize":
      out({ id, result: { userAgent: "fake-codex/0.0.0", platformOs: "test" } });
      return;
    case "initialized":
      return;
    case "account/read":
      // FAKE_CODEX_ACCOUNT: none(로그인 안 됨) · apiKey(API 키 로그인) · 기본 ChatGPT.
      out({ id, result: { requiresOpenaiAuth: true, account: process.env.FAKE_CODEX_ACCOUNT === "none" ? null
        : process.env.FAKE_CODEX_ACCOUNT === "apiKey" ? { type: "apiKey" }
        : { type: "chatgpt", email: "someone@example.com", planType: "pro" } } });
      return;
    case "config/read":
      // FAKE_CODEX_CONFIG_ERROR — 사용자 설정이 깨진 PC(KAN-1617: url 항목 위에 command)처럼 config/read 가 그 글로 실패한다.
      if (process.env.FAKE_CODEX_CONFIG_ERROR) {
        out({ id, error: { code: -32603, message: process.env.FAKE_CODEX_CONFIG_ERROR } });
        return;
      }
      if (CONFLICT) {
        out({ id, error: { code: -32603, message: `invalid configuration: ${CONFLICT}` } });
        return;
      }
      out({ id, result: { config: { mcp_servers: { ...USER_SERVERS, ...(BRIDGE ? { [BRIDGE]: { command: "node" } } : {}) } } } });
      return;
    case "thread/start":
      if (holdThread()) return;
      if (CONFLICT) {
        out({ id, error: { code: -32600, message: `failed to load configuration: ${CONFLICT}` } });
        return;
      }
      thread = `thr-${process.pid}`;
      startServers(params.config);
      out({ id, result: { thread: { id: thread }, approvalPolicy: params.approvalPolicy, sandbox: params.sandbox } });
      return;
    case "thread/resume":
      if (holdThread()) return;
      if (CONFLICT) {
        out({ id, error: { code: -32600, message: `failed to load configuration: ${CONFLICT}` } });
        return;
      }
      if (params.threadId === "thr-gone") {
        out({ id, error: { code: -32600, message: "thread not found: thr-gone" } });
        return;
      }
      thread = process.env.FAKE_CODEX_RESUME_AS || params.threadId;   // 시험: 재개가 다른 thread 로 이어짐
      startServers(params.config);
      out({ id, result: { thread: { id: thread } } });
      return;
    case "turn/start": {
      turns += 1;
      const turnId = `turn-${turns}`;
      out({ id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      out({ method: "turn/started", params: { threadId: thread, turn: { id: turnId, status: "inProgress" } } });
      act(turnId, params.input?.[0]?.text);
      return;
    }
    case "turn/interrupt":
      out({ id, result: {} });
      if (hangingTurn === params.turnId) {
        hangingTurn = undefined;
        complete(params.turnId, "interrupted");
      }
      return;
    default:
      out({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
// FAKE_CODEX_EXIT_DELAY_MS — stdin 이 닫힌 뒤 그만큼 정리하다 끝난다(진짜 app-server 처럼 · 멈춘 자식 재사용 시험).
process.stdin.on("end", () => setTimeout(() => process.exit(0), Number(process.env.FAKE_CODEX_EXIT_DELAY_MS ?? 0)));
