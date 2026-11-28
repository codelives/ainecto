import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { executePcStart, type PcDeps } from "../src/adapters/cli/pcCommand";
import { SERVE_CONNECTED_PREFIX } from "../src/core/agent/serve";
import type { MachineStatus } from "../src/core/setup/machineStatus";
import { systemCommandRunner } from "../src/core/setup/commandRunner";
import { accountKey, loadPcSettings, savePcSettings, withConsent } from "../src/core/pc/pcSettings";
import { daemonCaps, termRequest } from "../src/core/term/client";
import { termPaths } from "../src/core/term/paths";
import { daemonPids, holderPids, json, LONG, ok, rig, ROOT, sessions, startOuterAt, TERM_AT, TSX, until, useTermRig } from "./termRig";

/** 넣는 고장 하나 — 연결 명령의 kill-server 요청만 옛 데몬에 닿지 않게(리뷰 r2 P0-2 «종료 요청 직전 연결 실패»). 나머지 요청은 진짜. */
const fault = vi.hoisted(() => ({ dropKillServer: false }));
vi.mock("../src/core/term/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/core/term/client")>();
  const termRequest: typeof real.termRequest = async (paths, body, options) => (fault.dropKillServer && body.op === "kill-server"
    ? { daemon: false } as Awaited<ReturnType<typeof real.termRequest>>
    : await real.termRequest(paths, body, options));
  return { ...real, termRequest };
});

/**
 * term 데몬을 이 판으로 맞추기(upgradeDaemon — 연결 명령·자동 업데이트의 앞단계 · 세션 유지 구조 3-4·5절) — 실물.
 *   새 구조: 바깥이 낮은 판이면 묻지 않고 넘겨받는다 — 세션(PTY PID·uuid) 그대로.
 *   옛 구조(진짜 0.16.6 — 이 가지의 바탕 커밋 코드를 꺼내 돌린다): 세션이 있으면 첫 전환은 대화형 «예» 한 번으로만 · 비대화면 그대로 ·
 *   바꾸면 옛 데몬이 끝나고 daemon.json 이 지워지고 다음 명령이 새 구조로 띄운다.
 * 이 시험의 «CLI» 는 fixtures/termAt.ts upgrade(판은 $HOME/term-version) — 넘기기에서 띄우는 바깥도 같은 진입·같은 판이다.
 */
useTermRig();

/** 바탕 커밋(origin/release/latest-0.16.6) — 옛 구조 데몬의 실제 코드. */
const OLD_COMMIT = "15b49077bbf18ccb62e809264e6ee40fd2fcab51";
let oldRoot = "";

beforeAll(async () => {
  // git 작업 트리를 만들지 않고 파일만 꺼낸다(저장소 메타데이터를 건드리지 않는다). 의존성은 지금 것을 링크 — 0.16.6 과 package.json 이 같다.
  oldRoot = await mkdtemp(join(tmpdir(), "aterm-old-"));
  execFileSync("/bin/sh", ["-c", `git -C "${ROOT}" archive ${OLD_COMMIT} | tar -x -C "${oldRoot}"`]);
  symlinkSync(join(ROOT, "node_modules"), join(oldRoot, "node_modules"));
});

afterAll(async () => {
  if (oldRoot) await rm(oldRoot, { recursive: true, force: true });
});

/** 옛 판(0.16.6) CLI 로 한 번 — 그 CLI 가 옛 구조 데몬을 띄운다(표지가 붙어 시험 정리가 그 데몬도 거둔다). */
function oldCli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, ["--import", TSX, `--conditions=${rig.marker}`, join(oldRoot, "src/bin/ainecto.ts"), ...args],
      { env: rig.env, cwd: rig.home }, (error, stdout, stderr) => done({ code: error && typeof error.code === "number" ? error.code : 0, stdout, stderr }));
  });
}

/** 판 `version` 의 CLI 로 upgradeDaemon 하나 — 안내 줄들. `answer` 가 있으면 대화형으로 그 답을 준다. */
function upgradeAt(version: string, answer?: string): Promise<string[]> {
  writeFileSync(join(rig.home, "term-version"), `${version}\n`);
  return new Promise((done, fail) => {
    const child = execFile(process.execPath, ["--import", TSX, `--conditions=${rig.marker}`, TERM_AT, "upgrade", ...(answer !== undefined ? ["--interactive"] : [])],
      { env: rig.env, cwd: rig.home }, (error, stdout, stderr) => {
        if (error) fail(new Error(`upgrade ${version} failed: ${stderr}`));
        else done((JSON.parse(stdout.trim().split("\n").pop()!) as { notes: string[] }).notes);
      });
    child.stdin?.end(answer !== undefined ? `${answer}\n` : "");
  });
}

/** 대화형 upgradeDaemon 을 띄워 둔다 — 안내 줄(stderr)을 보며 답을 하나씩 준다(묻는 동안 세션을 여는 시험). */
function upgradeLive(version: string) {
  writeFileSync(join(rig.home, "term-version"), `${version}\n`);
  const child = spawn(process.execPath, ["--import", TSX, `--conditions=${rig.marker}`, TERM_AT, "upgrade", "--interactive"], { env: rig.env, cwd: rig.home });
  let err = "";
  let out = "";
  child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  const done = new Promise<{ notes: string[]; outcome: string }>((resolve, reject) => child.on("exit", (code) => (code === 0
    ? resolve(JSON.parse(out.trim().split("\n").pop()!) as { notes: string[]; outcome: string })
    : reject(new Error(`upgrade failed: ${err}`)))));
  return {
    done,
    /** `text` 가 n 번 보일 때까지(묻는 중). */
    seen: async (text: string, nth: number) => {
      await until(() => err.split(text).length - 1 >= nth, `«${text}» ×${nth}\n--- stderr ---\n${err}`);
    },
    say: (line: string) => {
      child.stdin.write(`${line}\n`);
    },
  };
}

const ENDPOINT = "https://example.test/mcp";
const KEY = accountKey(ENDPOINT, "u1");
const CONNECTED = `console.log(${JSON.stringify(`${SERVE_CONNECTED_PREFIX}test-host.`)});`;
const GRACEFUL = "if (process.argv.includes('--version')) process.exit(0);"
  + `process.on('SIGINT', () => process.exit(0)); ${CONNECTED} setInterval(() => undefined, 1000);`;

/** 연결 명령(executePcStart) 하나 — 이 PC 는 이미 동의했다(묻는 것은 첫 전환뿐). pc 세션 명령은 대역(Ctrl+C 에 0 으로 끝남). */
async function pcStart(interactive: boolean, answer?: string, stopDeadlineMs = 10_000): Promise<{ code: number; out: string; err: string }> {
  const settingsPath = join(rig.home, ".ainecto", "pc.json");
  await savePcSettings(settingsPath, withConsent(await loadPcSettings(settingsPath, "test-host"), KEY, true, new Date()));
  const stdin = new PassThrough();
  let out = "";
  let err = "";
  const env = Object.fromEntries(Object.entries(rig.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const signedIn: MachineStatus = {
    cliVersion: "0.16.8", endpoint: ENDPOINT, env: "dev", token: { state: "signed-in" },
    account: { userId: "u1", displayName: "Ryan", projectCount: 1 }, agents: [], legacyEnv: [], legacyCodexProfiles: [],
  };
  const deps: PcDeps = {
    io: {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: { write: (text: string) => { out += text; return true; } } as unknown as NodeJS.WriteStream,
      stderr: { write: (text: string) => { err += text; return true; } } as unknown as NodeJS.WriteStream,
    },
    json: false, interactive, paths: termPaths(rig.home), settingsPath, keysPath: join(rig.home, ".ainecto", "pc-keys.json"),
    hostName: "test-host", endpoint: ENDPOINT, cwd: rig.home, sessionEnv: env, flags: { env: "dev" }, cliVersion: "0.16.8",
    managedCommand: (args) => [process.execPath, "-e", GRACEFUL, "--", "--package", "@ainecto/mcp@0.16.8", "ainecto", ...args],
    runner: systemCommandRunner({ cwd: rig.home, env: rig.env }), termProblem: undefined,
    agentLog: join(rig.home, ".ainecto/agent/agent.log"), stopDeadlineMs, readyDeadlineMs: 10_000,
    machine: async () => signedIn, account: async () => ({ userId: "u1", displayName: "Ryan" }), setup: async () => 0,
  };
  const done = executePcStart(deps);
  if (answer !== undefined) {
    await until(() => err.includes("Switch now? [y/N]"), `switch question\n--- stderr ---\n${err}`);
    stdin.write(`${answer}\n`);
  }
  return { code: await done, out, err };
}

/** 옛 구조 데몬(진짜 0.16.6)에 사용자 세션 keep + 옛 판 PC 연결(종류 pc-bridge · @ainecto/mcp@0.16.6) — 그 PC 연결의 pid·uuid. */
async function oldDaemonWithPc(): Promise<{ pid: number; instance: string }> {
  expect((await oldCli("term", "new", "keep", "--", "/bin/sh")).code).toBe(0);
  await termRequest(termPaths(rig.home), { op: "new", name: "ainecto-pc", cwd: rig.home, kind: "pc-bridge", env: {},
    command: [process.execPath, "-e", GRACEFUL, "--", "--package", "@ainecto/mcp@0.16.6", "ainecto", "pc", "run"] }, { start: false });
  const pc = (await sessions()).find((session) => session.name === "ainecto-pc") as { pid: number; instance?: string } | undefined;
  expect(pc?.instance).toMatch(/^[0-9a-f-]{36}$/);
  return { pid: pc!.pid, instance: pc!.instance! };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const ASK = "The terminal structure on this PC changed, so this one time the 1 open terminal session(s) will close: legacy. From the next update on they stay open.";

describe("term 데몬을 이 판으로(upgradeDaemon) — 실물", () => {
  it("새 구조 · 바깥이 낮은 판 → 묻지 않고 넘겨받는다(비대화 · 사용자 세션이 있어도) — PTY PID·uuid 그대로 · 같은 판이면 아무것도 안 함", async () => {
    const first = await startOuterAt("0.16.7");
    await ok("term", "new", "work", "--", "cat");
    const before = await sessions();

    expect(await upgradeAt("0.16.7")).toEqual([]);
    expect(alive(first.pid)).toBe(true);

    expect(await upgradeAt("0.16.8")).toEqual(["Updated the AiNecto terminal service on this PC to 0.16.8 — open sessions stay open."]);
    await until(() => !alive(first.pid), "old outer ended");
    expect(await sessions()).toEqual(before);
    const found = await daemonCaps(termPaths(rig.home));
    expect(found.daemon && found.caps?.version).toBe("0.16.8");
  }, LONG);

  it("옛 구조(진짜 0.16.6) · 세션이 있으면 비대화는 그대로 · 대화형 «아니오»도 그대로 · «예»면 한 번 닫히고 daemon.json 을 지운 뒤 새 구조로", async () => {
    expect((await oldCli("term", "new", "legacy", "--", "/bin/sh")).code).toBe(0);
    const paths = termPaths(rig.home);
    expect(existsSync(paths.daemonInfo)).toBe(true);
    const [oldDaemon] = daemonPids();
    expect(await daemonCaps(paths)).toEqual({ daemon: true, caps: undefined });

    expect(await upgradeAt("0.16.8")).toEqual([]);
    expect(await upgradeAt("0.16.8", "n")).toEqual([ASK]);
    expect(alive(oldDaemon!)).toBe(true);
    expect((await sessions()).map((session) => session.name)).toEqual(["legacy"]);

    expect(await upgradeAt("0.16.8", "y")).toEqual([ASK, "Switching the AiNecto terminal service on this PC to the new structure…"]);
    await until(() => !alive(oldDaemon!), "old daemon gone");
    expect(existsSync(paths.daemonInfo)).toBe(false);

    // 다음 명령은 새 구조 — 세션은 uuid·종류를 가진다
    await ok("term", "new", "fresh", "--", "/bin/sh");
    expect(holderPids()).toHaveLength(1);
    const listed = (await json("term", "ls")).data as { sessions: Array<{ name: string; instance?: string; kind?: string }> };
    expect(listed.sessions).toEqual([expect.objectContaining({ name: "fresh", kind: "user", instance: expect.stringMatching(/^[0-9a-f-]{36}$/) })]);
  }, LONG);

  it("★리뷰 r1 P0-2 — 연결 명령에서 첫 전환에 «아니오» · 비대화면 옛 데몬도 옛 PC 연결(pid·uuid)도 그대로 · «바뀐 것 없음»을 알린다", async () => {
    const before = await oldDaemonWithPc();
    const [oldDaemon] = daemonPids();

    const declined = await pcStart(true, "n");
    expect(declined.code).toBe(0);
    expect(declined.out).toContain("Nothing was changed — the AiNecto terminal service on this PC keeps its old structure");
    expect(declined.err).not.toContain("Replacing the PC connection");
    const quiet = await pcStart(false);
    expect(quiet.code).toBe(0);
    expect(quiet.err).not.toContain("Switch now?");
    expect(quiet.out).toContain("Nothing was changed");

    expect(alive(oldDaemon!)).toBe(true);
    const pc = (await sessions()).find((session) => session.name === "ainecto-pc") as { pid: number; instance?: string } | undefined;
    expect({ pid: pc?.pid, instance: pc?.instance }).toEqual(before);
    expect((await sessions()).map((session) => session.name).sort()).toEqual(["ainecto-pc", "keep"]);
  }, LONG);

  it("★리뷰 r1 P0-2 — 세션 0 인 옛 데몬(연결 하나가 붙잡고 있음)도 비대화면 그대로 · 대화형이면 묻는다", async () => {
    expect((await oldCli("term", "new", "gone", "--", "/bin/sh")).code).toBe(0);
    const [oldDaemon] = daemonPids();
    // 옛 데몬은 세션 0 · 연결 0 이면 스스로 끝난다 — 맨 연결 하나로 붙잡아 둔다(옛 데몬의 주소는 ctl.sock 하나).
    const holdOpen = createConnection(join(rig.home, ".ainecto/term/ctl.sock"));
    await new Promise<void>((resolve, reject) => holdOpen.once("connect", resolve).once("error", reject));
    try {
      await ok("term", "kill", "gone");
      expect(await sessions()).toEqual([]);
      expect(await upgradeAt("0.16.8")).toEqual([]);
      expect(alive(oldDaemon!)).toBe(true);
      expect(await upgradeAt("0.16.8", "n")).toEqual(["The terminal structure on this PC changed. No terminal sessions are open, so none will close. From the next update on they stay open."]);
      expect(alive(oldDaemon!)).toBe(true);
    } finally {
      holdOpen.destroy();
    }
  }, LONG);

  it("★리뷰 r1 P0-3 — 묻는 동안 생긴 세션은 이름을 보이고 다시 묻는다 · «예»면 동의한 둘 다 끝 기록(새 holder 의 책)", async () => {
    expect((await oldCli("term", "new", "early", "--", "/bin/sh")).code).toBe(0);
    const [oldDaemon] = daemonPids();
    writeFileSync(join(rig.home, "term-destination"), "https://example.test/mcp#u1\n");
    const run = upgradeLive("0.16.8");
    await run.seen("Switch now? [y/N]", 1);
    expect((await oldCli("term", "new", "late", "--", "/bin/sh")).code).toBe(0);
    run.say("y");
    await run.seen("Switch now? [y/N]", 2);
    run.say("y");
    const result = await run.done;
    expect(result.outcome).toBe("ready");
    expect(result.notes).toEqual([
      "The terminal structure on this PC changed, so this one time the 1 open terminal session(s) will close: early. From the next update on they stay open.",
      "While you were answering, 1 more terminal session(s) opened: late.",
      "The terminal structure on this PC changed, so this one time the 2 open terminal session(s) will close: early, late. From the next update on they stay open.",
      "Switching the AiNecto terminal service on this PC to the new structure…",
    ]);
    await until(() => !alive(oldDaemon!), "old daemon gone");
    const pending = JSON.parse(readFileSync(termPaths(rig.home).endedPending, "utf8")) as { ended: Array<{ name: string; to?: string }> };
    expect(pending.ended.map((record) => record.name).sort()).toEqual(["early", "late"]);
    expect(pending.ended.every((record) => record.to === "https://example.test/mcp#u1")).toBe(true);
  }, LONG);

  it("KAN-1616 — 첫 전환으로 닫힌 세션은 끝 기록을 남긴다(옛 데몬은 남기지 않는다) · 방금 본 uuid · exited · 지금 계정 수신처 → 새 holder 의 책", async () => {
    expect((await oldCli("term", "new", "legacy", "--", "/bin/sh")).code).toBe(0);
    const seen = (await sessions()).find((session) => session.name === "legacy") as { instance?: string } | undefined;
    expect(seen?.instance).toMatch(/^[0-9a-f-]{36}$/);
    const [oldDaemon] = daemonPids();
    writeFileSync(join(rig.home, "term-destination"), "https://example.test/mcp#u1\n");

    await upgradeAt("0.16.8", "y");
    await until(() => !alive(oldDaemon!), "old daemon gone");
    await ok("term", "new", "fresh", "--", "/bin/sh");
    const ended = ((await json("term", "ls")).data as { ended?: Array<Record<string, unknown>> }).ended ?? [];
    expect(ended).toEqual([expect.objectContaining({ instance: seen?.instance, name: "legacy", reason: "exited", to: "https://example.test/mcp#u1" })]);
  }, LONG);
  /** 새 holder 를 띄워(다음 명령) 그 책의 끝 기록 — 이름순. */
  async function endedAfterSwitch(): Promise<Array<Record<string, unknown>>> {
    await ok("term", "new", "fresh", "--", "/bin/sh");
    const ended = ((await json("term", "ls")).data as { ended?: Array<Record<string, unknown>> }).ended ?? [];
    return [...ended].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  it("★리뷰 r2 P0-1 — 다른 계정(A)이 받던 세션의 끝 기록은 A 것 그대로 · 전환한 계정(B)은 수신처 없는 기록만 채운다", async () => {
    const A = "https://example.test/mcp#a";
    const B = "https://example.test/mcp#b";
    expect((await oldCli("term", "new", "seen-by-a", "--", "/bin/sh")).code).toBe(0);
    expect((await oldCli("term", "new", "unseen", "--", "/bin/sh")).code).toBe(0);
    const before = (await sessions()) as Array<{ name: string; instance?: string }>;
    const seenByA = before.find((session) => session.name === "seen-by-a")?.instance;
    const unseen = before.find((session) => session.name === "unseen")?.instance;
    // 0.16.6 다리가 목록을 올리기 전에 하는 표시 그대로(진짜 옛 데몬의 listed-to)
    await termRequest(termPaths(rig.home), { op: "listed-to", to: A, instances: [seenByA!] }, { start: false });
    const [oldDaemon] = daemonPids();
    writeFileSync(join(rig.home, "term-destination"), `${B}\n`);

    await upgradeAt("0.16.8", "y");
    await until(() => !alive(oldDaemon!), "old daemon gone");
    expect(await endedAfterSwitch()).toEqual([
      expect.objectContaining({ instance: seenByA, name: "seen-by-a", to: A }),
      expect.objectContaining({ instance: unseen, name: "unseen", to: B }),
    ]);
  }, LONG);

  it("★리뷰 r2 P0-2 — 끄기 요청이 옛 데몬에 닿지 않아 전환이 멈추면 끝 기록을 미리 남기지 않는다 · 나중에 실제로 끝난 사유(killed)가 그대로", async () => {
    expect((await oldCli("term", "new", "work", "--", "/bin/sh")).code).toBe(0);
    const instance = ((await sessions()) as Array<{ name: string; instance?: string }>).find((session) => session.name === "work")?.instance;
    const [oldDaemon] = daemonPids();
    const paths = termPaths(rig.home);

    fault.dropKillServer = true;
    try {
      await expect(pcStart(true, "y", 1_500)).rejects.toThrow(/is still running and did not stop/);
    } finally {
      fault.dropKillServer = false;
    }
    expect(alive(oldDaemon!)).toBe(true);
    expect((await sessions()).map((session) => session.name)).toEqual(["work"]);
    expect(existsSync(paths.endedPending)).toBe(false);

    // 그 뒤 사람이 옛 CLI 로 그 세션을 지웠다 — 옛 데몬이 확정한 사유는 killed
    expect((await oldCli("term", "kill", "work")).code).toBe(0);
    await until(() => !alive(oldDaemon!), "old daemon gone (no sessions left)");
    expect(await endedAfterSwitch()).toEqual([expect.objectContaining({ instance, name: "work", reason: "killed" })]);
  }, LONG);

  it("★리뷰 r2 P0-3 — 옛 데몬이 대기 책(ended.pending.json)을 복구해 둔 채 전환해도 방금 닫은 세션의 수신처가 남는다", async () => {
    const A = "https://example.test/mcp#a";
    const B = "https://example.test/mcp#b";
    const paths = termPaths(rig.home);
    const prev = randomUUID();
    mkdirSync(dirname(paths.endedPending), { recursive: true });
    writeFileSync(paths.endedPending, `${JSON.stringify({ ended: [{ instance: prev, name: "prev", kind: "user", command: ["/bin/sh"],
      endedAt: new Date().toISOString(), reason: "exited", to: A }] })}\n`);
    expect((await oldCli("term", "new", "work", "--", "/bin/sh")).code).toBe(0);
    const work = ((await sessions()) as Array<{ name: string; instance?: string }>).find((session) => session.name === "work")?.instance;
    const [oldDaemon] = daemonPids();
    writeFileSync(join(rig.home, "term-destination"), `${B}\n`);

    await upgradeAt("0.16.8", "y");
    await until(() => !alive(oldDaemon!), "old daemon gone");
    expect(await endedAfterSwitch()).toEqual([
      expect.objectContaining({ instance: prev, name: "prev", to: A }),
      expect.objectContaining({ instance: work, name: "work", to: B }),
    ]);
  }, LONG);
});
