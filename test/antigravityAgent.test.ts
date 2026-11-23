import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentReplySchema, type AgentSession, type TurnOutcome } from "../src/core/agent/agents";
import { antigravityAdapter, antigravityAuth } from "../src/core/agent/antigravity";
import { antigravityAgentArgs, antigravityMcpConfig, antigravitySettings } from "../src/core/agent/antigravityArgs";
import { antigravityMcpPolicy, writeWorkspaceMcpConfig } from "../src/core/agent/antigravityPolicy";
import type { AgentSpawn } from "../src/core/agent/child";
import type { AgentLogRecord } from "../src/core/agent/log";
import { DaemonLog } from "../src/core/term/daemonLog";

/** 설계 `_workspace/design/windows-pc/ecobit/antigravity-pc-agent.md` r3 §3 단위 — 모델 호출 0(가짜 agy). */

const FAKE_AGY = join(__dirname, "fixtures", "fakeAgy.mjs");
const OURS = antigravityMcpConfig({ command: "node", args: ["bridge.js"] });

function tempRoot(): { root: string; home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "agy-policy-"));
  const home = join(root, "home");
  mkdirSync(home);
  return { root, home, cwd: join(root, "app", "antigravity", "chat") };
}

function put(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

async function policy(t: { home: string; cwd: string }, plugins: string | null = "[]") {
  mkdirSync(t.cwd, { recursive: true });
  await writeWorkspaceMcpConfig(t.cwd, OURS);
  return await antigravityMcpPolicy({ cwd: t.cwd, home: t.home,
    pluginList: async () => (plugins === null ? { ok: false, detail: "exit 2" } : { ok: true, stdout: plugins }) });
}

describe("Antigravity 서버 이름 모으기(r3 §2-2 1~6)", () => {
  it("우리 파일만 있고 다른 원천이 없으면 거절할 이름 0 · 빈 전역 파일 = 없음", async () => {
    const t = tempRoot();
    put(join(t.home, ".gemini", "config", "mcp_config.json"), "");
    expect(await policy(t)).toEqual({ ok: true, deny: [] });
  });

  it("(b) 저장소 안 작업 폴더 → 시작 안 함", async () => {
    const t = tempRoot();
    mkdirSync(join(t.root, "app", ".git"), { recursive: true });
    expect(await policy(t)).toMatchObject({ ok: false, reason: "work folder is inside a git repository" });
  });

  it.each([".agent", "_agents", "_agent"])("(a) 작업 폴더 별칭 %s → 시작 안 함", async (alias) => {
    const t = tempRoot();
    put(join(t.cwd, alias, "mcp_config.json"), JSON.stringify({ mcpServers: { other: { command: "node" } } }));
    expect(await policy(t)).toMatchObject({ ok: false, reason: "work folder holds something other than our config" });
  });

  it.each([["AGENTS.md"], ["GEMINI.md"], [join(".agents", "plugins.json")], [join(".agents", "skills", "x.md")]])(
    "작업 폴더에 우리 것 밖(%s) → 시작 안 함", async (extra) => {
      const t = tempRoot();
      put(join(t.cwd, extra), "x");
      expect(await policy(t)).toMatchObject({ ok: false, reason: "work folder holds something other than our config" });
    });

  it("(c) 부모 폴더의 별칭 폴더 넷 이름은 전부 deny 에", async () => {
    const t = tempRoot();
    put(join(t.root, "app", "_agents", "mcp_config.json"), JSON.stringify({ mcpServers: { other: { command: "node" } } }));
    put(join(t.root, ".agent", "mcp_config.json"), JSON.stringify({ mcpServers: { far: { url: "https://x" } } }));
    put(join(t.home, ".gemini", "config", "mcp_config.json"), JSON.stringify({ mcpServers: { ainecto: { serverUrl: "https://a" } } }));
    expect(await policy(t)).toEqual({ ok: true, deny: ["ainecto", "far", "other"] });
  });

  it("플러그인: 목록의 이름 + 그 폴더 mcp_config.json(꺼진 플러그인도)", async () => {
    const t = tempRoot();
    const plugin = join(t.home, ".gemini", "config", "plugins", "p1");
    put(join(plugin, "mcp_config.json"), JSON.stringify({ mcpServers: { fromfile: { command: "node" } } }));
    const listed = JSON.stringify([{ name: "p1", enabled: false, path: plugin, mcpServers: ["listed"] }, { name: "p2", enabled: true, path: join(t.root, "none") }]);
    expect(await policy(t, listed)).toEqual({ ok: true, deny: ["fromfile", "listed"] });
  });

  it("④ 전역 plugins.json(바깥 폴더 플러그인 — plugin list 에 안 보임) → 시작 안 함", async () => {
    const t = tempRoot();
    put(join(t.home, ".gemini", "config", "plugins.json"), JSON.stringify({ entries: [{ path: "/elsewhere" }] }));
    expect(await policy(t)).toMatchObject({ ok: false, reason: "global plugins.json adds plugins that agy plugin list does not show" });
  });

  it.each([
    ["해석 실패", "{not json", "unreadable mcp_config.json"],
    ["모르는 꼴", JSON.stringify({ mcpServers: ["x"] }), "unknown mcp_config.json shape"],
    ["규칙에 못 싣는 이름", JSON.stringify({ mcpServers: { "a)b": {} } }), "server name the deny rule cannot carry"],
    ["ainecto-pc 충돌", JSON.stringify({ mcpServers: { "ainecto-pc": {} } }), "another config also names ainecto-pc"],
  ])("전역 설정 %s → 시작 안 함", async (_name, text, reason) => {
    const t = tempRoot();
    put(join(t.home, ".gemini", "config", "mcp_config.json"), text);
    expect(await policy(t)).toMatchObject({ ok: false, reason });
  });

  it("부모 별칭 폴더의 ainecto-pc 충돌 · 플러그인 목록 실패 · 모르는 목록 꼴 → 시작 안 함", async () => {
    const a = tempRoot();
    put(join(a.root, "_agent", "mcp_config.json"), JSON.stringify({ mcpServers: { "ainecto-pc": {} } }));
    expect(await policy(a)).toMatchObject({ ok: false, reason: "another config also names ainecto-pc" });
    expect(await policy(tempRoot(), null)).toMatchObject({ ok: false, reason: "agy plugin list failed: exit 2" });
    expect(await policy(tempRoot(), JSON.stringify({ plugins: [] }))).toMatchObject({ ok: false, reason: "unknown agy plugin list shape" });
    const plugin = tempRoot();
    expect(await policy(plugin, JSON.stringify([{ path: plugin.root, mcpServers: ["ainecto-pc"] }])))
      .toMatchObject({ ok: false, reason: "another config also names ainecto-pc" });
  });
});

describe("Antigravity 고정 인자·인증(모델 호출 0)", () => {
  it("--settings: 브리지만 allow · 내장 다섯 + 모은 이름 deny · 재개는 --conversation", () => {
    const settings = antigravitySettings(["ainecto", "other"]);
    expect(settings).toEqual({ toolPermission: "request-review", permissions: { allow: ["mcp(ainecto-pc/*)"],
      deny: ["command(*)", "write_file(*)", "read_file(*)", "read_url(*)", "execute_url(*)", "mcp(ainecto/*)", "mcp(other/*)"] } });
    const args = antigravityAgentArgs({ schema: { type: "object" }, settings, conversationId: "c1" });
    expect(args.slice(0, 5)).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json"]);
    expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toEqual(settings);
    expect(args.slice(-2)).toEqual(["--conversation", "c1"]);
    expect(antigravityAgentArgs({ schema: {}, settings })).not.toContain("--conversation");
  });

  it("agy models 끝 코드 0 = 준비 · 과금 주체는 변수 유무로", () => {
    expect(antigravityAuth(1, {}, undefined)).toEqual({ ready: false, detail: "sign in — run `agy` once" });
    expect(antigravityAuth(0, {}, undefined)).toEqual({ ready: true, mode: "subscription", method: "google-account" });
    expect(antigravityAuth(0, { GEMINI_API_KEY: "k" }, "gemini")).toEqual({ ready: true, mode: "apiKey", method: "gemini-api-key" });
    expect(antigravityAuth(0, { GEMINI_API_KEY: "k" }, undefined)).toMatchObject({ mode: "subscription" });
    expect(antigravityAuth(0, { AGY_ADC_AUTH: "true" }, undefined)).toEqual({ ready: true, mode: "apiKey", method: "google-cloud-adc" });
  });
});

function world(env: Record<string, string> = {}) {
  const t = tempRoot();
  const argsLog = join(t.root, "agy-args.jsonl");
  const logPath = join(t.root, "agent.log");
  const spawnImpl: AgentSpawn = (command, args, opts) => spawn(command === "agy" ? process.execPath : command,
    command === "agy" ? [FAKE_AGY, ...args] : args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
  const adapter = antigravityAdapter({
    spawnImpl, home: t.home, log: new DaemonLog<AgentLogRecord>(logPath, `${logPath}.1`),
    env: { ...process.env, FAKE_AGY_ARGS_LOG: argsLog, ...env },
    writeTools: new Set(["create_documents", "update_documents"]),
    toolNames: new Set(["search", "create_documents", "update_documents"]),
    workDir: (name) => join(t.root, "app", "antigravity", name ? `agent-${name}` : "chat"),
    mcpConfig: () => OURS,
    schema: agentReplySchema,
  });
  const runs = () => (existsSync(argsLog) ? readFileSync(argsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; cwd: string }) : []);
  const logs = () => readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const open = (resumeRef?: string): AgentSession =>
    adapter.open({ conversationUuid: "conv-uuid", textMaxCharacters: 1000, documentsMax: 10, ...(resumeRef ? { resumeRef } : {}) });
  return { t, adapter, runs, logs, open };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function untilTrue(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("Antigravity 세션 — 이벤트 → 결과 계약(r2 표)", () => {
  it("SUCCESS: 브리지 DONE 단계만 · 같은 단계 한 번 · ACTIVE/ERROR/모르는 도구 제외 · 다음 차례는 같은 conversation 으로 · 작업 폴더 = 세션 폴더", async () => {
    const w = world();
    const session = w.open();
    const first = await session.send("write-doc", 10_000);
    expect(first.kind).toBe("result");
    const result = first as Extract<TurnOutcome, { kind: "result" }>;
    expect(result.result).toMatchObject({ isError: false, subtype: "SUCCESS", structuredOutput: { reply: "wrote" } });
    expect(result.facts.documents).toEqual(["a".repeat(32)]);
    expect(result.facts.seen).toEqual(["a".repeat(32), "d".repeat(32)]);
    const ref = session.sessionRef;
    expect(ref).toMatch(/^conv-\d+$/);
    expect(session.alive).toBe(true);
    await session.send("again", 10_000);
    const [one, two] = w.runs();
    expect(one!.args).not.toContain("--conversation");
    expect(two!.args.slice(-2)).toEqual(["--conversation", ref]);
    expect(one!.cwd.endsWith(join("antigravity", "chat"))).toBe(true);
    expect(JSON.parse(readFileSync(join(one!.cwd, ".agents", "mcp_config.json"), "utf8"))).toEqual(OURS);
    expect(w.logs().some((r) => r.event === "agent_usage" && r.inputTokens === 10)).toBe(true);
  });

  it("SUCCESS 아님 → result isError subtype = status · 결과 없이 끝남 → exited(code 3)", async () => {
    const w = world();
    const session = w.open();
    expect(await session.send("fail", 10_000)).toMatchObject({ kind: "result", result: { isError: true, subtype: "ERROR", resultText: "boom" } });
    expect(await session.send("crash", 10_000)).toMatchObject({ kind: "exited", code: 3 });
  });

  it("중단: init 받은 뒤 interrupt → result isError interrupted · ref 유지 · 떠 있는 앞 프로세스 0 · 다음 send 는 같은 ref 로 재개", async () => {
    const w = world();
    const session = w.open();   // 새 세션 — 재개 값은 init 에서만 온다
    const turn = session.send("hang", 10_000);
    await untilTrue(() => w.runs().length === 1 && session.pid > 0);
    const pid = session.pid;
    await new Promise((r) => setTimeout(r, 300));   // init 줄이 읽히게
    await session.interrupt();
    expect(await turn).toMatchObject({ kind: "result", result: { isError: true, subtype: "interrupted" } });
    expect(session.sessionRef).toBe(`conv-${pid}`);
    expect(alive(pid)).toBe(false);
    expect(await session.send("next", 10_000)).toMatchObject({ kind: "result", result: { structuredOutput: { reply: "got next" } } });
    expect(w.runs()[1]!.args.slice(-2)).toEqual(["--conversation", `conv-${pid}`]);
  });

  it("기한 넘김 → timeout · close 가 그 프로세스를 끈다", async () => {
    const w = world();
    const session = w.open();
    expect(await session.send("hang", 500)).toEqual({ kind: "timeout" });
    const pid = session.pid;
    await session.interrupt();   // serve 순서 그대로 — 차례가 없으니 아무것도 안 한다
    await session.close();
    expect(alive(pid)).toBe(false);
    expect(session.alive).toBe(false);
  });

  it("사후 대조: 브리지 밖 서버 도구가 DONE → 실패(policy_violation) + 경보 로그(서버·도구 이름만)", async () => {
    const w = world();
    const outcome = await w.open().send("foreign", 10_000);
    expect(outcome).toMatchObject({ kind: "result", result: { isError: true, subtype: "policy_violation" } });
    expect(w.logs().find((r) => r.event === "agent_policy_violation")).toMatchObject({ server: "other", tool: "ping" });
  });

  it("원천을 다 확인 못 하면 agy -p 를 띄우지 않고 refused(AGENT_POLICY_UNVERIFIED)", async () => {
    const w = world({ FAKE_AGY_PLUGINS_FAIL: "1" });
    const outcome = await w.open().send("hello", 10_000);
    expect(outcome).toEqual({ kind: "refused", errorCode: "AGENT_POLICY_UNVERIFIED", reason: "agy plugin list failed: exit 2" });
    expect(w.runs()).toEqual([]);
    expect(w.logs().find((r) => r.event === "agent_policy_unverified")).toMatchObject({ reason: "agy plugin list failed: exit 2" });
  });

  it("감지·인증: 판이 다르면 로그만 · 로그인 없음 = 준비 안 됨", async () => {
    const w = world({ FAKE_AGY_VERSION: "1.6.0", FAKE_AGY_AUTH: "out" });
    expect(await w.adapter.detect()).toEqual({ installed: true, version: "1.6.0" });
    expect(w.logs().find((r) => r.event === "agent_version_unverified")).toMatchObject({ version: "1.6.0", verified: "1.5.14" });
    expect(await w.adapter.authStatus()).toMatchObject({ ready: false });
  });
});
