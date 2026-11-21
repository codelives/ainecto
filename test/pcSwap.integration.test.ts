import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { swapArgsOf, upgradeWatch } from "../src/adapters/cli/pcAutoUpgrade";
import { startPcSession, type PcDeps } from "../src/adapters/cli/pcCommand";
import { executePcSwap, type SwapDeps } from "../src/adapters/cli/pcSwap";
import type { AgentLogRecord } from "../src/core/agent/log";
import { SERVE_CONNECTED_PREFIX } from "../src/core/agent/serve";
import { pcRunArgs, skipUpgradeOf } from "../src/core/pc/pcSession";
import type { CommandResult } from "../src/core/setup/commandRunner";
import { DaemonLog } from "../src/core/term/daemonLog";
import { termPaths } from "../src/core/term/paths";
import { attestationBundle } from "./support/attestation";
import { LONG, ok, rig, sessions, useTermRig } from "./termRig";

/**
 * 자동 업그레이드 도우미(`pc swap`) — 실 데몬·실 PTY. pc 세션 명령만 대역(판마다 스크립트: Ctrl+C 를 받으면 0 으로 끝나는 «연결됨» pc,
 * 또는 바로 죽는 판). npm·npx·registry 는 대역 runner·fetch(바깥 호출 0) — 실 npm 은 따로 손으로 확인(4절).
 */
const FROM = "0.14.0-next.10";
const TO = "0.14.0-next.11";
const CONNECTED = `process.on('SIGINT', () => process.exit(0)); console.log(${JSON.stringify(`${SERVE_CONNECTED_PREFIX}test-host.`)});`
  + " setInterval(() => undefined, 1000);";
const DIES = "console.error('boom'); process.exit(3);";
const FORK = { repository: "https://github.com/someone/fork", path: ".github/workflows/publish.yml" };

useTermRig();

interface Scenario {
  /** 판마다 pc 세션 스크립트(기본: 연결됨). */
  scripts?: Record<string, string>;
  /** `--version` 이 내는 판(기본: 그 판). */
  reports?: string;
  audit?: { exitCode: number; stdout: string };
  /** 판마다 증명 workflow — 없으면 증명 없음(next.8 같은 토큰 게시판). */
  workflows?: Record<string, { repository: string; path: string } | undefined>;
}

const OURS = { repository: "https://github.com/codelives/ainecto", path: ".github/workflows/publish.yml" };
const VERIFIED = { exitCode: 0, stdout: "audited 3 packages in 1s\n\n3 packages have verified registry signatures\n\n1 package has a verified attestation\n" };

function swap(scenario: Scenario = {}): { deps: SwapDeps; records: () => Promise<Array<Record<string, unknown>>> } {
  const logPath = join(rig.home, "agent.log");
  const env = Object.fromEntries(Object.entries(rig.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const sink = { write: () => true } as unknown as NodeJS.WriteStream;
  const pc = (version: string, skip?: string): PcDeps => ({
    io: { stdin: new PassThrough() as unknown as NodeJS.ReadStream, stdout: sink, stderr: sink },
    json: false,
    interactive: false,
    paths: termPaths(rig.home),
    settingsPath: join(rig.home, ".ainecto", "pc.json"),
    keysPath: join(rig.home, ".ainecto", "pc-keys.json"),
    hostName: "test-host",
    endpoint: "https://example.test/mcp",
    cwd: rig.home,
    sessionEnv: env,
    flags: { env: "dev", ...(skip ? { skipUpgrade: skip } : {}) },
    cliVersion: version,
    managedCommand: (args) => [process.execPath, "-e", scenario.scripts?.[version] ?? CONNECTED, "--", "--package", `@ainecto/mcp@${version}`, "ainecto", ...args],
    runner: async () => ({ exitCode: 0, stdout: "", stderr: "", missing: false }),
    termProblem: undefined,
    agentLog: logPath,
    stopDeadlineMs: 10_000,
    readyDeadlineMs: 5_000,
    machine: async () => { throw new Error("not used"); },
    account: async () => ({ userId: "u1", displayName: "Ryan" }),
    setup: async () => 0,
  });
  const workflows = scenario.workflows ?? { [FROM]: OURS, [TO]: OURS };
  const deps: SwapDeps = {
    from: FROM,
    to: TO,
    packageName: "@ainecto/mcp",
    pc,
    runner: () => async (command, args): Promise<CommandResult> => {
      const done = (stdout: string, exitCode = 0): CommandResult => ({ exitCode, stdout, stderr: "", missing: false });
      if (args.includes("--version")) {
        const version = args[args.indexOf("--package") + 1]?.split("@").pop() ?? "";
        return done(`{\n  "version": "${scenario.reports ?? version}"\n}\n`);
      }
      if (command === "npm" && args[0] === "install") return done("added 3 packages");
      if (command === "npm" && args[0] === "audit") return done(scenario.audit?.stdout ?? VERIFIED.stdout, scenario.audit?.exitCode ?? 0);
      if (command === "npm" && args[0] === "view") {
        const version = args[1]?.split("@").pop() ?? "";
        return done(workflows[version] ? `https://registry.test/attestations/${version}\n` : "");
      }
      return done("", 127);
    },
    fetchJson: async (url) => {
      const version = url.split("/").pop() ?? "";
      const workflow = workflows[version];
      return workflow ? attestationBundle(version, workflow) : { attestations: [] };
    },
    makeTempDir: () => mkdtemp(join(rig.home, "upgrade-")),
    removeDir: (path) => rm(path, { recursive: true, force: true }),
    home: rig.home,
    log: new DaemonLog<AgentLogRecord>(logPath, `${logPath}.1`),
  };
  const records = async () => (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  return { deps, records };
}

const pcCommand = async () => (await sessions()).find((s) => s.name === "ainecto-pc")?.command ?? [];

/** 바깥 호출마다 요청 1줄 + 응답 1줄(같은 callId). */
function expectCallPairs(records: Array<Record<string, unknown>>): void {
  const calls = records.filter((r) => r.event === "upgrade_call").map((r) => r.callId);
  const answered = new Set(records.filter((r) => r.event === "upgrade_call_response").map((r) => r.callId));
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.filter((id) => !answered.has(id))).toEqual([]);
}

describe("자동 업그레이드 도우미 — 실 데몬", () => {
  beforeEach(async () => {
    await ok("term", "new", "warm", "--", "sleep", "600");
  });

  it("성공 — 확인 1·2 통과 → 옛 pc 끄고 새 판(@TO 고정)으로 띄움 · 시작·끝 이벤트", async () => {
    const { deps, records } = swap();
    expect(await startPcSession(deps.pc(FROM))).toEqual({ kind: "connected", agentMissing: false });
    expect(await executePcSwap(deps)).toBe(0);
    const command = await pcCommand();
    expect(command).toContain(`@ainecto/mcp@${TO}`);
    expect(command).not.toContain("--skip-upgrade");
    const logged = await records();
    expect(logged.map((r) => r.event).filter((e) => e === "upgrade_start" || e === "upgrade_done")).toEqual(["upgrade_start", "upgrade_done"]);
    expect(logged.find((r) => r.event === "upgrade_start")).toMatchObject({ from: FROM, to: TO });
    expectCallPairs(logged);
  }, LONG);

  it("3 — 그 사이 사람이 pc 를 껐으면 다시 켜지 않는다 · 실패(stop)", async () => {
    const { deps, records } = swap();
    expect(await executePcSwap(deps)).toBe(1);
    expect(await pcCommand()).toEqual([]);
    expect((await records()).find((r) => r.event === "upgrade_failed")).toMatchObject({ from: FROM, to: TO, step: "stop" });
  }, LONG);

  it("1 실패 — --version 이 다른 판 → 실패(install) · 아무것도 끄지 않음", async () => {
    const { deps, records } = swap({ reports: "0.14.0-next.9" });
    await startPcSession(deps.pc(FROM));
    expect(await executePcSwap(deps)).toBe(1);
    expect(await pcCommand()).toContain(`@ainecto/mcp@${FROM}`);
    expect((await records()).find((r) => r.event === "upgrade_failed")).toMatchObject({ from: FROM, to: TO, step: "install" });
  }, LONG);

  it("2 거절 — workflow 다름 · 증명 없음(토큰 게시판) · audit 미검증 → 거절 · 아무것도 끄지 않음", async () => {
    const cases: Array<[Scenario, string]> = [
      [{ workflows: { [FROM]: OURS, [TO]: FORK } }, "workflow-differs"],
      [{ workflows: { [FROM]: OURS, [TO]: undefined } }, "no-attestation"],
      [{ audit: { exitCode: 0, stdout: "3 packages have verified registry signatures\n" } }, "audit-failed"],
    ];
    const first = swap();
    await startPcSession(first.deps.pc(FROM));
    for (const [scenario, reason] of cases) {
      const { deps, records } = swap(scenario);
      expect(await executePcSwap(deps)).toBe(1);
      expect(await pcCommand()).toContain(`@ainecto/mcp@${FROM}`);
      expect((await records()).filter((r) => r.event === "upgrade_refused").pop()).toMatchObject({ from: FROM, to: TO, reason });
    }
  }, LONG);

  it("4 실패 → 되돌림 — 새 판이 바로 죽음 → 옛 판을 --skip-upgrade TO 로 다시 띄움 · 실패(start·rolledBack)", async () => {
    const { deps, records } = swap({ scripts: { [TO]: DIES } });
    await startPcSession(deps.pc(FROM));
    expect(await executePcSwap(deps)).toBe(1);
    const command = await pcCommand();
    expect(command).toContain(`@ainecto/mcp@${FROM}`);
    expect(command.slice(-2)).toEqual(["--skip-upgrade", TO]);
    expect((await records()).find((r) => r.event === "upgrade_failed")).toMatchObject({ from: FROM, to: TO, step: "start", rolledBack: true });
  }, LONG);
});

describe("자동 업그레이드 감시 — pc run", () => {
  const answer = (next: string | undefined, watching = 0) => ({ tags: next ? { next } : undefined, watching });

  it("같은 목표는 한 번만 · 바쁘거나 보는 세션이 있으면 기다림 · 꼬리표가 바뀌면 새 목표 · 되돌림 표시는 건너뜀 · 로컬 빌드는 안 함", () => {
    let busy = true;
    const launched: string[] = [];
    const watch = upgradeWatch({ current: FROM, release: true, skip: undefined, agentBusy: () => busy, launch: (t) => launched.push(t) });
    watch(answer(TO));
    busy = false;
    watch(answer(TO, 1));
    expect(launched).toEqual([]);
    watch(answer(TO));
    watch(answer(TO));
    expect(launched).toEqual([TO]);
    watch(answer("0.14.0-next.12"));
    expect(launched).toEqual([TO, "0.14.0-next.12"]);

    const skipped: string[] = [];
    const rolledBack = upgradeWatch({ current: FROM, release: true, skip: TO, agentBusy: () => false, launch: (t) => skipped.push(t) });
    rolledBack(answer(TO));
    expect(skipped).toEqual([]);

    const local: string[] = [];
    upgradeWatch({ current: FROM, release: false, skip: undefined, agentBusy: () => false, launch: (t) => local.push(t) })(answer(TO));
    expect(local).toEqual([]);
  });

  it("인자 — pc run 의 건너뛰기 표시 · pc swap 의 from·to", () => {
    const args = pcRunArgs({ env: "dev", skipUpgrade: TO });
    expect(args).toEqual(["pc", "run", "--env", "dev", "--skip-upgrade", TO]);
    expect(skipUpgradeOf(args.slice(2))).toBe(TO);
    expect(skipUpgradeOf(["--env", "dev"])).toBeUndefined();
    expect(swapArgsOf(["--from", FROM, "--to", TO])).toEqual({ from: FROM, to: TO });
    expect(swapArgsOf(["--from", FROM])).toBeUndefined();
  });
});
