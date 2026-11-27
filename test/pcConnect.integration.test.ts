import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { executePair } from "../src/adapters/cli/pairCommand";
import { executePcStart, executePcStop, executeRemoteSetting, runningPcGroups, turnOffPcs, type PcDeps } from "../src/adapters/cli/pcCommand";
import { accountKey } from "../src/core/pc/pcSettings";
import { generateSigningJwk, publicJwkOf } from "../src/core/term/e2e";
import { loadPcKeys, updatePcKeys, withBrowser } from "../src/core/pc/pcKeys";
import { AGENT_MISSING_LINE, SERVE_CONNECTED_PREFIX } from "../src/core/agent/serve";
import { REMOTE_OFF_BY_WEB_LINE, REMOTE_STATE_PREFIX } from "../src/core/term/remote";
import { systemCommandRunner } from "../src/core/setup/commandRunner";
import type { MachineStatus } from "../src/core/setup/machineStatus";
import { termPaths } from "../src/core/term/paths";
import { LONG, ok, rig, sessions, until, useTermRig } from "./termRig";

/**
 * «이 PC 연결»(`ainecto`·start·stop·remote) — 실 데몬·실 PTY. pc 세션 명령만 대역: `pc run` 처럼 Ctrl+C 를 받으면 코드 0 으로 끝나는
 * 프로세스(서버·로그인·npx 없이). 판 확인(--version)은 바로 0. 계정·점검은 고정값(로그인 상태 = 입력).
 * 입구는 이 시험 프로세스 안에서 돈다 — 데몬은 리그의 진짜 CLI 가 먼저 띄운다(여기서 띄우면 vitest 를 띄운다).
 */
const CONNECTED = `console.log(${JSON.stringify(`${SERVE_CONNECTED_PREFIX}test-host.`)});`;
const GRACEFUL = "if (process.argv.includes('--version')) process.exit(0);"
  + `process.on('SIGINT', () => process.exit(0)); ${CONNECTED} setInterval(() => undefined, 1000);`;
const STUBBORN = `process.on('SIGINT', () => undefined); ${CONNECTED} setInterval(() => undefined, 1000);`;
/** 연결됐고, 원격은 웹에서 꺼진 pc — 다리가 화면에 남기는 줄 그대로. */
const OFF_BY_WEB = "if (process.argv.includes('--version')) process.exit(0);"
  + `process.on('SIGINT', () => process.exit(0)); ${CONNECTED} console.log(${JSON.stringify(`${REMOTE_OFF_BY_WEB_LINE} Run it again.`)});`
  + " setInterval(() => undefined, 1000);";
/** Claude Code·Codex 가 없는 PC — Agent 없음 한 줄 뒤 다리만 연결(원격 허용). */
const REMOTE_ONLY = "if (process.argv.includes('--version')) process.exit(0);"
  + `process.on('SIGINT', () => process.exit(0)); console.error(${JSON.stringify(AGENT_MISSING_LINE)});`
  + ` console.error(${JSON.stringify(`${REMOTE_STATE_PREFIX}on — 1 session(s) from test-host are listed in AiNecto on the web.`)});`
  + " setInterval(() => undefined, 1000);";
/** 연결 줄을 찍지 않고 기다리기만 — 막 띄운(npx·준비 확인 중) pc 와 같다. */
const SILENT = "setInterval(() => undefined, 1000);";
const ENDPOINT = "https://example.test/mcp";
const KEY = accountKey(ENDPOINT, "u1");

const signedIn: MachineStatus = {
  cliVersion: "9.9.9", endpoint: ENDPOINT, env: "dev", token: { state: "signed-in" },
  account: { userId: "u1", displayName: "Ryan", projectCount: 1 }, agents: [], legacyEnv: [], legacyCodexProfiles: [],
};

useTermRig();

function sameDaemonVersion(version: string): void {
  const file = termPaths(rig.home).daemonInfo;
  if (!existsSync(file)) return;
  writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), version })}\n`);
}

function harness(overrides: Partial<PcDeps> & { version?: string; script?: string } = {}) {
  const stdin = new PassThrough();
  let out = "";
  let err = "";
  const version = overrides.version ?? "9.9.9";
  // 운영에서 데몬은 같은 CLI 가 띄워 판이 같다 — 여기 데몬(rig)은 소스 판이라, 가짜 판(9.9.x)과 맞춰 옛 데몬 교체(upgradeDaemon)가 끼지 않게.
  sameDaemonVersion(version);
  const env = Object.fromEntries(Object.entries(rig.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const deps: PcDeps = {
    io: {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: { write: (text: string) => { out += text; return true; } } as unknown as NodeJS.WriteStream,
      stderr: { write: (text: string) => { err += text; return true; } } as unknown as NodeJS.WriteStream,
    },
    json: false,
    interactive: true,
    paths: termPaths(rig.home),
    settingsPath: join(rig.home, ".ainecto", "pc.json"),
    keysPath: join(rig.home, ".ainecto", "pc-keys.json"),
    hostName: "test-host",
    endpoint: ENDPOINT,
    cwd: rig.home,
    sessionEnv: env,
    flags: { env: "dev" },
    cliVersion: version,
    managedCommand: (args) => [process.execPath, "-e", overrides.script ?? GRACEFUL, "--", "--package", `@ainecto/mcp@${version}`, "ainecto", ...args],
    runner: systemCommandRunner({ cwd: rig.home, env: rig.env }),
    termProblem: undefined,
    agentLog: join(rig.home, ".ainecto/agent/agent.log"),
    stopDeadlineMs: 10_000,
    readyDeadlineMs: 10_000,
    machine: async () => signedIn,
    account: async () => ({ userId: "u1", displayName: "Ryan" }),
    setup: async () => 0,
    ...overrides,
  };
  return {
    deps,
    out: () => out,
    err: () => err,
    /** 묻는 말이 나오면 답한다. */
    answer: async (question: string, line: string) => {
      await until(() => err.includes(question), `«${question}»\n--- stderr ---\n${err}`);
      stdin.write(`${line}\n`);
    },
  };
}

const settings = async () => JSON.parse(await readFile(join(rig.home, ".ainecto", "pc.json"), "utf8")) as {
  pcId: string; hostName: string; accounts: Record<string, { consentedAt: string; remoteTerminal: boolean }>;
};
const pcSessions = async () => (await sessions()).filter((s) => s.command?.includes("pc"));
const manifestNames = async () => (JSON.parse(await readFile(join(rig.home, ".ainecto/term/sessions.json"), "utf8")) as { sessions: { name: string }[] })
  .sessions.map((s) => s.name);

describe("이 PC 연결 — 실 데몬", () => {
  beforeEach(async () => {
    await ok("term", "new", "warm", "--", "sleep", "600");
  });

  it("처음 — 동의 두 물음 → pc.json(0600·계정별) → ainecto-pc 세션 · 다시 하면 «Already connected»(묻지 않음)", async () => {
    const first = harness();
    const done = executePcStart(first.deps);
    await first.answer("Connect this PC? [y/N]", "y");
    await first.answer("Also allow terminals from the web? [y/N]", "");
    expect(await done).toBe(0);
    expect(first.err()).toContain("This connects this PC to AiNecto as Ryan (https://example.test/mcp).");
    expect(first.err()).toContain("  · It keeps itself up to date — new AiNecto releases built and signed on AiNecto's GitHub are installed when this PC is idle.");
    expect(first.out()).toContain("This PC is now connected to AiNecto. From AiNecto on the web");

    const saved = await settings();
    expect(saved.hostName).toBe("test-host");
    expect(saved.pcId).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.accounts[KEY]?.remoteTerminal).toBe(false);
    expect((await stat(join(rig.home, ".ainecto", "pc.json"))).mode & 0o777).toBe(0o600);

    const [pc] = await pcSessions();
    expect(pc?.name).toBe("ainecto-pc");
    expect(pc?.cwd).toBe(rig.home);
    expect(pc?.command?.slice(-4)).toEqual(["pc", "run", "--env", "dev"]);
    // 입력 없음(결재 2026-11-21 A안) — 매니페스트에 남아 restore 로 다시 띄워도 같은 실행 계획이다.
    const manifest = JSON.parse(await readFile(join(rig.home, ".ainecto/term/sessions.json"), "utf8")) as { sessions: { name: string; input?: string }[] };
    expect(manifest.sessions.find((entry) => entry.name === "ainecto-pc")?.input).toBe("none");

    const again = harness();
    expect(await executePcStart(again.deps)).toBe(0);
    expect(again.out()).toContain("This PC is already connected to AiNecto (folder");
    expect(again.out()).toContain("version 9.9.9)");
    expect(again.err()).not.toContain("Connect this PC?");
    expect((await pcSessions()).length).toBe(1);
  }, LONG);

  it("옛 판이 떠 있으면 갈아끼운다 — Ctrl+C 로 끝내고 이 판으로 하나", async () => {
    const old = harness();
    const first = executePcStart(old.deps);
    await old.answer("Connect this PC?", "y");
    await old.answer("Also allow terminals", "y");
    await first;
    const next = harness({ version: "9.9.10" });
    expect(await executePcStart(next.deps)).toBe(0);
    expect(next.err()).toContain("Replacing the PC connection 9.9.9 (session ainecto-pc) with 9.9.10");
    const pcs = await pcSessions();
    expect(pcs.length).toBe(1);
    expect(pcs[0]?.command).toContain("@ainecto/mcp@9.9.10");
  }, LONG);

  it("stop — Ctrl+C 로 스스로 끝남(매니페스트에서도 빠짐) · 다시 stop 은 «not connected» · --forget 은 이 서버 동의를 지운다", async () => {
    const start = harness();
    const done = executePcStart(start.deps);
    await start.answer("Connect this PC?", "y");
    await start.answer("Also allow terminals", "n");
    await done;
    const stop = harness();
    expect(await executePcStop(stop.deps, [])).toBe(0);
    expect(stop.out()).toContain("Disconnected this PC (session ainecto-pc).");
    expect((await sessions()).map((s) => s.name)).toEqual(["warm"]);
    // 신호 없이(코드 0) 끝났으니 매니페스트에서도 빠진다 — 재부팅 뒤 restore 가 되살리지 않는다(쓰기는 데몬이 뒤에서 한다).
    await until(async () => (await manifestNames()).join() === "warm", "manifest without ainecto-pc");

    // 짝지은 키 — 이 서버의 것만 지운다(다른 서버의 짝짓기는 그대로).
    const keysPath = join(rig.home, ".ainecto", "pc-keys.json");
    const otherServer = accountKey("https://other.test/mcp", "u1");
    const pcKey = await generateSigningJwk();
    await updatePcKeys(keysPath, () => ({ accounts: { [KEY]: { pcKey, browsers: [] }, [otherServer]: { pcKey, browsers: [] } } }));
    const forget = harness();
    expect(await executePcStop(forget.deps, ["--forget"])).toBe(0);
    expect(forget.out()).toContain("This PC is not connected.");
    expect(forget.out()).toContain("Removed your approval for https://example.test/mcp on this PC");
    expect(forget.out()).toContain("Also removed this PC's terminal key and registered browsers for that server");
    expect((await settings()).accounts).toEqual({});
    expect(Object.keys((await loadPcKeys(keysPath)).accounts)).toEqual([otherServer]);
  }, LONG);

  it("stop — Ctrl+C 를 듣지 않으면 기한 뒤 kill", async () => {
    const start = harness({ script: STUBBORN, runner: async () => ({ exitCode: 0, stdout: "", stderr: "", missing: false }) });
    const done = executePcStart(start.deps);
    await start.answer("Connect this PC?", "y");
    await start.answer("Also allow terminals", "n");
    await done;
    const stop = harness({ stopDeadlineMs: 500 });
    expect(await executePcStop(stop.deps, [])).toBe(0);
    expect(stop.out()).toContain("Session ainecto-pc did not stop within 0.5 s after Ctrl+C — ended it.");
    await until(async () => (await sessions()).every((s) => s.name !== "ainecto-pc"), "pc session gone");
  }, LONG);

  it("비대화형 + 동의 없음 — 띄우지 않고 이유 한 줄 · 로그인 전 비대화형도 같다 · 첫 물음 N 이면 아무것도 쓰지 않는다", async () => {
    await expect(executePcStart(harness({ interactive: false }).deps)).rejects.toThrow("This PC (test-host) is not connected to AiNecto yet. Run `npx -y ainecto@latest` in a terminal on this PC first and approve the connection.");
    await expect(executePcStart(harness({ interactive: false, machine: async () => ({ ...signedIn, token: { state: "not-signed-in" }, account: undefined }) }).deps))
      .rejects.toThrow("Not signed in to AiNecto");
    const no = harness();
    const done = executePcStart(no.deps);
    await no.answer("Connect this PC?", "n");
    expect(await done).toBe(0);
    expect(no.err()).toContain("Not connected. Nothing was started.");
    expect(await pcSessions()).toEqual([]);
    await expect(stat(join(rig.home, ".ainecto", "pc.json"))).rejects.toThrow();
  }, LONG);

  it("remote on|off — 동의 전엔 거절 · 동의 뒤 계정별로 바뀐다 · term 못 쓰는 기기는 start 거절", async () => {
    await expect(executeRemoteSetting(harness().deps, ["off"])).rejects.toThrow("This PC (test-host) is not connected to AiNecto yet");
    const start = harness();
    const done = executePcStart(start.deps);
    await start.answer("Connect this PC?", "y");
    await start.answer("Also allow terminals", "y");
    await done;
    expect((await settings()).accounts[KEY]?.remoteTerminal).toBe(true);
    const off = harness();
    expect(await executeRemoteSetting(off.deps, ["off"])).toBe(0);
    expect(off.out()).toContain("Terminals from AiNecto on the web are blocked on this PC.");
    expect((await settings()).accounts[KEY]?.remoteTerminal).toBe(false);
    await expect(executeRemoteSetting(harness().deps, ["maybe"])).rejects.toThrow("Usage: ainecto remote on|off");
    await expect(executePcStart(harness({ termProblem: "not on win32" }).deps)).rejects.toThrow("Connecting this PC needs ainecto term: not on win32");
  }, LONG);

  it("remote on|off — 떠 있는 pc 는 다시 띄워 바로 반영한다(다리가 새 설정으로 다시 연다)", async () => {
    const start = harness();
    const done = executePcStart(start.deps);
    await start.answer("Connect this PC?", "y");
    await start.answer("Also allow terminals", "n");
    await done;
    const before = (await pcSessions())[0]?.pid;
    const on = harness();
    expect(await executeRemoteSetting(on.deps, ["on"])).toBe(0);
    expect((await settings()).accounts[KEY]?.remoteTerminal).toBe(true);
    expect(on.out()).toContain("Terminals from AiNecto on the web are allowed on this PC.");
    expect(on.err()).toContain("Reconnecting this PC so it takes effect");
    expect(on.out()).toContain("This PC is now connected to AiNecto. From AiNecto on the web");
    const after = await pcSessions();
    expect(after.length).toBe(1);
    expect(after[0]?.pid).not.toBe(before);
  }, LONG);

  it("runningPcGroups·turnOffPcs(pair --remove 가 쓴다) — 없으면 빈 목록 · 있으면 그 그룹을 끈 뒤 세션이 목록에서 빠지고 pid 가 사라진 것까지 확인 · 다시 띄우지 않는다", async () => {
    expect(await runningPcGroups(harness().deps)).toEqual([]);
    const start = harness();
    const done = executePcStart(start.deps);
    await start.answer("Connect this PC?", "y");
    await start.answer("Also allow terminals", "y");
    await done;
    const pid = (await pcSessions())[0]?.pid;
    expect(pid).toBeDefined();
    const groups = await runningPcGroups(harness().deps);
    expect(groups).toEqual([{ session: "ainecto-pc", pid, pgid: expect.any(Number) }]);
    await turnOffPcs(harness().deps, groups);
    expect(await pcSessions()).toEqual([]);
    expect(() => process.kill(pid ?? 0, 0)).toThrow();
  }, LONG);

  it("turnOffPcs — Ctrl+C 를 듣지 않는 pc 도 기한 뒤 kill 하고 끝난 것을 확인한다", async () => {
    const start = harness({ script: STUBBORN, runner: async () => ({ exitCode: 0, stdout: "", stderr: "", missing: false }) });
    const done = executePcStart(start.deps);
    await start.answer("Connect this PC?", "y");
    await start.answer("Also allow terminals", "n");
    await done;
    const deps = harness({ stopDeadlineMs: 500 }).deps;
    await turnOffPcs(deps, await runningPcGroups(deps));
    expect(await pcSessions()).toEqual([]);
  }, LONG);

  it("데몬을 못 쓰면(termProblem) «실행 중 PC 없음»이 아니라 PC_STOP_UNCONFIRMED", async () => {
    const blind = harness({ termProblem: "no pty on this machine" }).deps;
    await expect(runningPcGroups(blind)).rejects.toMatchObject({ code: "PC_STOP_UNCONFIRMED" });
    await expect(turnOffPcs(blind, [{ session: "ainecto-pc", pid: 1, pgid: 1 }])).rejects.toMatchObject({ code: "PC_STOP_UNCONFIRMED" });
  });

  /** pc 가 SIGINT·SIGHUP 을 무시하는 손자를 같은 그룹에 남기고 Ctrl+C 에 혼자 끝난다 — npx 아래 다리가 남는 경우. 핀 k1 을 넣고 pc pid 를 돌려준다. */
  async function orphanPc(): Promise<{ keysPath: string; pid: number }> {
    const ORPHAN = "if (process.argv.includes('--version')) process.exit(0);"
      + " const { spawn } = require('node:child_process');"
      + " const child = spawn(process.execPath, ['-e', \"process.on('SIGINT',()=>{});process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { stdio: 'ignore' });"
      + " console.log('grandchild=' + child.pid);"
      + ` process.on('SIGINT', () => process.exit(0)); ${CONNECTED} setInterval(() => undefined, 1000);`;
    const start = harness({ script: ORPHAN });
    const done = executePcStart(start.deps);
    await start.answer("Connect this PC?", "y");
    await start.answer("Also allow terminals", "n");
    await done;
    const keysPath = start.deps.keysPath;
    const pcKey = await generateSigningJwk();
    await updatePcKeys(keysPath, (keys) => withBrowser(keys, KEY, pcKey,
      { keyId: "k1", publicJwk: publicJwkOf(pcKey), name: "Work", pairedAt: "2026-11-21T00:00:00.000Z" }));
    return { keysPath, pid: (await pcSessions())[0]?.pid ?? 0 };
  }

  /** 실제 데몬·실제 그룹 확인으로 `pair --remove <name>`. */
  function removePair(keysPath: string, name: string): Promise<number> {
    const pc = harness({ stopDeadlineMs: 1_000 });
    return executePair({
      io: pc.deps.io, json: false,
      settingsPath: pc.deps.settingsPath, keysPath, hostName: "test-host", endpoint: ENDPOINT,
      account: async () => ({ userId: "u1" }),
      findPcs: () => runningPcGroups(pc.deps),
      turnOffPcs: (groups) => turnOffPcs(pc.deps, groups),
      now: () => new Date("2026-11-21T09:00:00Z"),
    }, ["--remove", name]);
  }

  function killGroup(pgid: number): void {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // 이미 비었다.
    }
  }

  it("pair --remove — pc 는 끝났어도 같은 그룹에 손자(다리)가 남으면 실패 · 데몬 목록에서 빠진 뒤의 재시도도 그 그룹이 살아 있으면 실패 · 그룹이 비어야 성공", async () => {
    const { keysPath, pid } = await orphanPc();
    try {
      await expect(removePair(keysPath, "k1")).rejects.toMatchObject({ code: "PAIR_REMOVE_STOP_FAILED" });
      const pending = (await loadPcKeys(keysPath)).accounts[KEY]?.pendingTurnOff;
      expect(pending?.groups).toEqual([{ session: "ainecto-pc", pid, pgid: expect.any(Number) }]);
      const pgid = pending?.groups[0]?.pgid ?? 0;
      // 세션은 데몬 목록에서 빠졌다 — 그래도 표지의 그룹으로 손자를 본다.
      expect(await pcSessions()).toEqual([]);
      await expect(removePair(keysPath, "k1")).rejects.toMatchObject({ code: "PAIR_REMOVE_STOP_FAILED", message: expect.stringContaining(`group ${pgid} is still alive`) });
      process.kill(-pgid, "SIGKILL");
      expect(await removePair(keysPath, "k1")).toBe(0);
      expect((await loadPcKeys(keysPath)).accounts[KEY]?.pendingTurnOff).toBeUndefined();
    } finally {
      killGroup(pid);
    }
  }, LONG);

  it("pair --remove — 첫 철회가 손자 때문에 실패한 뒤 다른 브라우저를 짝지어 저장해도 «끄기 미완료» 표지가 남아, 옛 핀의 재시도가 원래 그룹의 소멸까지 확인한다", async () => {
    const { keysPath, pid } = await orphanPc();
    try {
      await expect(removePair(keysPath, "k1")).rejects.toMatchObject({ code: "PAIR_REMOVE_STOP_FAILED" });
      const pending = (await loadPcKeys(keysPath)).accounts[KEY]?.pendingTurnOff;
      const pgid = pending?.groups[0]?.pgid ?? 0;
      expect(pgid).toBeGreaterThan(0);
      // 다른 브라우저 짝짓기의 저장 — pair 의 핀 저장과 같은 바꾸기(계정의 pcKey 로 withBrowser).
      await updatePcKeys(keysPath, async (keys) => {
        const stored = keys.accounts[KEY];
        if (!stored) throw new Error("the account was not saved");
        return withBrowser(keys, KEY, stored.pcKey,
          { keyId: "k2", publicJwk: publicJwkOf(await generateSigningJwk()), name: "Home", pairedAt: "2026-11-21T10:00:00.000Z" });
      });
      expect((await loadPcKeys(keysPath)).accounts[KEY]?.pendingTurnOff).toEqual(pending);
      await expect(removePair(keysPath, "k1")).rejects.toMatchObject({ code: "PAIR_REMOVE_STOP_FAILED", message: expect.stringContaining(`group ${pgid} is still alive`) });
      process.kill(-pgid, "SIGKILL");
      expect(await removePair(keysPath, "k1")).toBe(0);
      const account = (await loadPcKeys(keysPath)).accounts[KEY];
      expect(account?.pendingTurnOff).toBeUndefined();
      expect(account?.browsers.map((item) => item.keyId)).toEqual(["k2"]);
    } finally {
      killGroup(pid);
    }
  }, LONG);

  it("Agent(Claude Code·Codex) 없이 원격만 허용 — 다리 연결 줄로 «연결됨» · 무엇이 붙었는지 그대로 말한다", async () => {
    const start = harness({ script: REMOTE_ONLY });
    const done = executePcStart(start.deps);
    await start.answer("Connect this PC?", "y");
    await start.answer("Also allow terminals", "y");
    expect(await done).toBe(0);
    expect(start.out()).toContain("No Claude Code, Codex or Antigravity was found");
    expect(start.out()).toContain("install one, then run `ainecto` again");
  }, LONG);

  it("KAN-1613 리뷰 r1 P0-1 — pc 세션이 찍은 Agent 마다의 이유가 `ainecto start` 를 친 터미널에도 온다(다리만 · 아무것도 없음 두 길 모두)", async () => {
    const log = join(rig.home, ".ainecto/agent/agent.log");
    // pc run 처럼: 검사 결과를 serve_start 에 남기고(같은 줄을 화면에도) 그다음 길로 간다.
    const lines = ["Claude Code was not found on this PC, or did not run (spawn claude ENOENT). reason-cc",
      "Codex is installed, but it could not be confirmed as ready (account read failed). reason-codex"];
    const startRecord = "require('node:fs').mkdirSync(require('node:path').dirname(" + JSON.stringify(log) + "), { recursive: true });"
      + "require('node:fs').appendFileSync(" + JSON.stringify(log) + ", JSON.stringify({ ts: new Date().toISOString(), event: 'serve_start',"
      + ` agents: ${JSON.stringify(lines.map((line, i) => ({ id: i === 0 ? "claude-code" : "codex", installed: i === 1, ready: false, line })))} }) + '\\n');`
      + ` for (const l of ${JSON.stringify(lines)}) console.error(l);`;
    const remoteOnly = harness({ script: "if (process.argv.includes('--version')) process.exit(0);"
      + `process.on('SIGINT', () => process.exit(0)); ${startRecord} console.error(${JSON.stringify(AGENT_MISSING_LINE)});`
      + ` console.error(${JSON.stringify(`${REMOTE_STATE_PREFIX}on — 1 session(s) from test-host are listed in AiNecto on the web.`)});`
      + " setInterval(() => undefined, 1000);" });
    const done = executePcStart(remoteOnly.deps);
    await remoteOnly.answer("Connect this PC?", "y");
    await remoteOnly.answer("Also allow terminals", "y");
    expect(await done).toBe(0);
    for (const line of lines) expect(remoteOnly.out(), "다리만 — 호출한 터미널(stdout)").toContain(line);
    await executePcStop(harness().deps, []);

    const noRunner = async () => ({ exitCode: 0, stdout: "", stderr: "", missing: false });
    const nothing = harness({ runner: noRunner, script: `${startRecord} console.error('Error: None of Claude Code is on PATH.'); setTimeout(() => process.exit(1), 300);` });
    await expect(executePcStart(nothing.deps)).rejects.toThrow("The PC connection could not start — Error: None of Claude Code is on PATH.");
    for (const line of lines) expect(nothing.err(), "아무것도 없음 — 오류 앞에 이유").toContain(line);
  }, LONG);

  it("ainecto 재실행 — 원격이 웹에서 꺼진 pc 는(같은 판이어도) «Already» 대신 다시 띄워 원격을 켠다", async () => {
    const first = harness({ script: OFF_BY_WEB });
    const done = executePcStart(first.deps);
    await first.answer("Connect this PC?", "y");
    await first.answer("Also allow terminals", "y");
    await done;
    const before = (await pcSessions())[0]?.pid;
    await ok("term", "wait", "ainecto-pc", "--match", "turned off from the web", "--timeout", "10");

    const again = harness();
    expect(await executePcStart(again.deps)).toBe(0);
    expect(again.err()).toContain("The remote terminal was turned off from the web — reconnecting this PC to turn it back on");
    expect(again.out()).toContain("This PC is now connected to AiNecto. From AiNecto on the web");
    expect(again.out()).not.toContain("Already connected");
    expect((await pcSessions())[0]?.pid).not.toBe(before);
  }, LONG);

  it("start 는 «연결됨» 줄을 기다린다 — 오류 줄로 끝남·말없이 끝남은 사유와 함께 실패 · 기한 안에 없으면 «Still connecting»(실패 아님)", async () => {
    const approve = harness();
    const first = executePcStart(approve.deps);
    await approve.answer("Connect this PC?", "y");
    await approve.answer("Also allow terminals", "n");
    await first;
    await executePcStop(harness().deps, []);

    const noRunner = async () => ({ exitCode: 0, stdout: "", stderr: "", missing: false });
    await expect(executePcStart(harness({ runner: noRunner, script: "console.error('Error: Unknown command pc.'); setTimeout(() => process.exit(1), 300);" }).deps))
      .rejects.toThrow("The PC connection could not start — Error: Unknown command pc.");
    await until(async () => (await sessions()).every((s) => s.name !== "ainecto-pc"), "failed pc gone");
    await expect(executePcStart(harness({ runner: noRunner, script: "process.exit(3);" }).deps))
      .rejects.toThrow("The PC connection stopped right after it started");

    const slow = harness({ runner: noRunner, script: SILENT, readyDeadlineMs: 300 });
    expect(await executePcStart(slow.deps)).toBe(0);
    expect(slow.out()).toContain("Still connecting this PC to AiNecto — run `ainecto status` to see when it is up.");

    // 아직 연결 줄을 찍지 않은 pc 는 Ctrl+C 대신 바로 kill — 매니페스트에서도 빠진다(재부팅 뒤 되살아나지 않는다).
    const stop = harness();
    expect(await executePcStop(stop.deps, [])).toBe(0);
    expect(stop.out()).toContain("Session ainecto-pc was still starting — ended it.");
    expect((await sessions()).map((s) => s.name)).toEqual(["warm"]);
    await until(async () => (await manifestNames()).join() === "warm", "manifest without ainecto-pc");
  }, LONG);
});
