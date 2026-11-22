import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { executePcStart, executePcStop, type PcDeps } from "../../src/adapters/cli/pcCommand";
import { SERVE_CONNECTED_PREFIX } from "../../src/core/agent/serve";
import { systemCommandRunner } from "../../src/core/setup/commandRunner";
import type { MachineStatus } from "../../src/core/setup/machineStatus";
import { alive, descendants, LONG, ok, rig, until, useWinRig, WINDOWS } from "./winRig";

/**
 * W4 ⓑⓒ(설계 windows-pc r3 5-1) — «이 PC 연결» 상태·끄기 대역 시험. ★pc 세션 명령은 `node -e` 대역이다(서버·로그인·npx 없음)
 * — 관리 세션(내부 npx)의 증거로 세지 않는다. 그것은 managed.win.test.ts. 끄기 길(stopPc)은 자동 업그레이드 swap 3단계와 같은 함수다.
 */
const CONNECTED = `console.log(${JSON.stringify(`${SERVE_CONNECTED_PREFIX}test-host.`)});`;
const GRACEFUL = "if (process.argv.includes('--version')) process.exit(0);"
  + `process.on('SIGINT', () => process.exit(0)); ${CONNECTED} setInterval(() => undefined, 1000);`;
const STUBBORN = "if (process.argv.includes('--version')) process.exit(0);"
  + `process.on('SIGINT', () => undefined); ${CONNECTED} setInterval(() => undefined, 1000);`;
const ENDPOINT = "https://example.test/mcp";
const signedIn: MachineStatus = {
  cliVersion: "9.9.9", endpoint: ENDPOINT, env: "dev", token: { state: "signed-in" },
  account: { userId: "u1", displayName: "Ryan", projectCount: 1 }, agents: [], legacyEnv: [], legacyCodexProfiles: [],
};

function harness(script: string, managedCommand?: PcDeps["managedCommand"]) {
  const stdin = new PassThrough();
  let out = "";
  let err = "";
  const env = Object.fromEntries(Object.entries(rig.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const deps: PcDeps = {
    io: {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: { write: (text: string) => { out += text; return true; } } as unknown as NodeJS.WriteStream,
      stderr: { write: (text: string) => { err += text; return true; } } as unknown as NodeJS.WriteStream,
    },
    json: false,
    interactive: true,
    paths: rig.paths,
    settingsPath: join(rig.home, ".ainecto", "pc.json"),
    keysPath: join(rig.home, ".ainecto", "pc-keys.json"),
    hostName: "test-host",
    endpoint: ENDPOINT,
    cwd: rig.home,
    sessionEnv: env,
    flags: { env: "dev" },
    cliVersion: "9.9.9",
    managedCommand: managedCommand ?? ((args) => [process.execPath, "-e", script, "--", "--package", "@ainecto/mcp@9.9.9", "ainecto", ...args]),
    runner: systemCommandRunner({ cwd: rig.home, env: rig.env }),
    termProblem: undefined,
    agentLog: join(rig.home, ".ainecto/agent/agent.log"),
    stopDeadlineMs: 10_000,
    readyDeadlineMs: 20_000,
    machine: async () => signedIn,
    account: async () => ({ userId: "u1", displayName: "Ryan" }),
    setup: async () => 0,
  };
  return {
    deps,
    out: () => out,
    answer: async (question: string, line: string) => {
      await until(() => err.includes(question), `«${question}»\n--- stderr ---\n${err}`);
      stdin.write(`${line}\n`);
    },
  };
}

async function pcSessions(): Promise<{ name: string; pid: number }[]> {
  const listed = JSON.parse(await ok("term", "ls", "--json")) as { data: { sessions: { name: string; pid: number; command: string[] | null }[] } };
  return listed.data.sessions.filter((session) => session.command?.includes("pc"));
}

async function pcSessionNames(): Promise<string[]> {
  return (await pcSessions()).map((session) => session.name);
}

describe.runIf(WINDOWS)("W4 이 PC 연결 — 실 데몬·ConPTY(대역 명령)", () => {
  useWinRig();
  beforeEach(async () => {
    // 데몬은 리그의 진짜 CLI 가 먼저 띄운다(입구가 이 시험 프로세스 안에서 띄우면 vitest 를 띄운다).
    await ok("term", "new", "warm", "--", rig.shell);
  });

  it("연결 → stop: ^C 로 끝난다(정상 끄기 — swap 3단계와 같은 stopPc)", async () => {
    const start = harness(GRACEFUL);
    const done = executePcStart(start.deps);
    await start.answer("Connect this PC? [y/N]", "y");
    await start.answer("Also allow terminals from the web? [y/N]", "");
    expect(await done).toBe(0);
    expect(await pcSessionNames()).toEqual(["ainecto-pc"]);
    const stop = harness(GRACEFUL);
    expect(await executePcStop(stop.deps, [])).toBe(0);
    expect(stop.out()).toContain("Disconnected this PC (session ainecto-pc).");
    expect(await pcSessionNames()).toEqual([]);
  }, LONG);

  it("실제 npx(npx.cmd → cmd 배치) 로 띄운 pc — stop 의 ^C 뒤 «일괄 작업» 확인 없이 바로 끝나고 남은 프로세스 0(결재 A안)", async () => {
    // 관리 명령과 같은 모양(npx → 패키지 bin) — 패키지는 홈의 로컬 의존성(내부 npx 가 고르는 자리, managed.win 과 같은 방법).
    const pkg = join(rig.home, "pc-stub");
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "pc-stub", version: "1.0.0", bin: { "pc-stub": "stub.js" } }));
    await writeFile(join(pkg, "stub.js"), `#!/usr/bin/env node\n${GRACEFUL}\n`);
    await writeFile(join(rig.home, "package.json"), JSON.stringify({ name: "h", version: "1.0.0", private: true }));
    execFileSync("npm", ["install", "--no-audit", "--no-fund", pkg], { cwd: rig.home, shell: true, windowsHide: true, env: rig.env });
    // `--` 뒤는 npx 가 읽지 않고 bin 에 넘긴다 — 세션 명령의 --package 값(판 표기)은 진짜 관리 명령과 같은 자리에 남는다.
    const viaNpx: PcDeps["managedCommand"] = (args) => ["npx", "--no-install", "pc-stub", "--", "--package", "@ainecto/mcp@9.9.9", "ainecto", ...args];
    const start = harness(GRACEFUL, viaNpx);
    const done = executePcStart(start.deps);
    await start.answer("Connect this PC? [y/N]", "y");
    await start.answer("Also allow terminals from the web? [y/N]", "");
    expect(await done).toBe(0);
    const [pc] = await pcSessions();
    expect(pc?.name).toBe("ainecto-pc");
    const tree = [pc?.pid ?? 0, ...descendants(pc?.pid ?? 0)];
    expect(tree.length).toBeGreaterThan(2);
    const stop = harness(GRACEFUL, viaNpx);
    const sent = Date.now();
    expect(await executePcStop(stop.deps, [])).toBe(0);
    const ms = Date.now() - sent;
    console.log(JSON.stringify({ measure: "pc-stop-via-npx", ms, tree: tree.length }));
    expect(stop.out()).toContain("Disconnected this PC (session ainecto-pc).");
    expect(ms).toBeLessThan(stop.deps.stopDeadlineMs);
    await until(() => tree.every((pid) => !alive(pid)), `tree gone: ${tree.filter(alive).join(",")}`, 10_000);
    expect(await pcSessionNames()).toEqual([]);
  }, LONG);

  it("^C 를 무시하는 pc 는 기한 뒤 강제로 끈다", async () => {
    const start = harness(STUBBORN);
    const done = executePcStart(start.deps);
    await start.answer("Connect this PC? [y/N]", "y");
    await start.answer("Also allow terminals from the web? [y/N]", "");
    expect(await done).toBe(0);
    const stop = harness(STUBBORN);
    expect(await executePcStop(stop.deps, [])).toBe(0);
    expect(stop.out()).toMatch(/did not stop within 10 s after Ctrl\+C — ended it/);
    expect(await pcSessionNames()).toEqual([]);
  }, LONG);
});
