import { mkdtemp, rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executePair, type PairDeps } from "../src/adapters/cli/pairCommand";
import { listed, runningPcGroups, turnOffPcs, type PcDeps } from "../src/adapters/cli/pcCommand";
import { loadPcKeys, updatePcKeys, withBrowser, type PcGroup } from "../src/core/pc/pcKeys";
import { accountKey } from "../src/core/pc/pcSettings";
import { generateSigningJwk, publicJwkOf } from "../src/core/term/e2e";
import { termPaths } from "../src/core/term/paths";

/**
 * `pair --remove` 의 조회에서 최초 IPC 연결이 ECONNRESET 으로 끊기면 «데몬 없음 → 빈 목록 → 성공»이 아니라 재시도할 실패다(리뷰 impl-2 #1).
 * 소켓을 진짜로 리셋시키기 어려워 연결(net.connect)만 대역 — 그 위의 목록·그룹·끄기 확인·철회는 실제 코드와 실제 pc-keys.json.
 */
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return { ...actual, connect: vi.fn(actual.connect) };
});

const ENDPOINT = "https://example.test/mcp";
const KEY = accountKey(ENDPOINT, "u1");

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pc-reset-"));
  // 붙자마자 상대가 연결을 리셋한다(connect 전에 ECONNRESET).
  vi.mocked(net.connect).mockImplementation(((): net.Socket => {
    const socket = new net.Socket();
    process.nextTick(() => socket.emit("error", Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" })));
    return socket;
  }) as typeof net.connect);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function pcDeps(): PcDeps {
  const io = {
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stdout: { write: () => true } as unknown as NodeJS.WriteStream,
    stderr: { write: () => true } as unknown as NodeJS.WriteStream,
  };
  return {
    io, json: false, interactive: false, paths: termPaths(home),
    settingsPath: join(home, ".ainecto", "pc.json"), keysPath: join(home, ".ainecto", "pc-keys.json"),
    hostName: "test-host", endpoint: ENDPOINT, cwd: home, sessionEnv: {}, flags: { env: "dev" }, cliVersion: "9.9.9",
    managedCommand: () => { throw new Error("must not start a PC connection"); },
    runner: async () => { throw new Error("must not run anything"); },
    termProblem: undefined, agentLog: join(home, "agent.log"), stopDeadlineMs: 300, readyDeadlineMs: 300,
    machine: async () => { throw new Error("not used"); },
    account: async () => ({ userId: "u1", displayName: "Ryan" }),
    setup: async () => 0,
  };
}

/** 철회 명령의 의존 — 기본은 실제 그룹 조회·끄기 확인(runningPcGroups·turnOffPcs, 연결만 ECONNRESET). */
function removeDeps(deps: PcDeps, overrides: Partial<PairDeps> = {}): { value: PairDeps; out: () => string } {
  let out = "";
  const value: PairDeps = {
    io: { ...deps.io, stdout: { write: (text: string) => { out += text; return true; } } as unknown as NodeJS.WriteStream },
    json: false, interactive: false, insideTermSession: false,
    openTty: () => { throw new Error("no tty"); },
    settingsPath: deps.settingsPath, keysPath: deps.keysPath, hostName: "test-host", endpoint: ENDPOINT,
    account: async () => ({ userId: "u1" }),
    transport: () => { throw new Error("no transport"); },
    notifyPaired: async () => undefined,
    findPcs: () => runningPcGroups(deps),
    turnOffPcs: (groups) => turnOffPcs(deps, groups),
    waitMs: 1_000,
    now: () => new Date("2026-11-21T09:00:00Z"),
    ...overrides,
  };
  return { value, out: () => out };
}

async function seed(deps: PcDeps, ...browsers: Array<{ keyId: string; name: string }>): Promise<void> {
  const pcKey = await generateSigningJwk();
  await updatePcKeys(deps.keysPath, (keys) => browsers.reduce((next, item) => withBrowser(next, KEY, pcKey,
    { ...item, publicJwk: publicJwkOf(pcKey), pairedAt: "2026-11-21T00:00:00.000Z" }), keys));
}

describe("pair --remove — 철회 경로의 IPC ECONNRESET 은 «데몬 없음»이 아니다", () => {
  it("다른 명령의 목록(listed)은 그대로 «데몬 없음 → 빈 목록» · 철회의 그룹 조회·끄기 확인은 실패", async () => {
    const deps = pcDeps();
    expect(await listed(deps)).toEqual([]);
    await expect(runningPcGroups(deps)).rejects.toThrow("ECONNRESET");
    // 지난 실행이 남긴 그룹(이미 끝난 pid·pgid)도 목록을 확인하지 못하면 끝났다고 보지 않는다.
    await expect(turnOffPcs(deps, [{ session: "ainecto-pc", pid: 999_999, pgid: 999_999 }])).rejects.toThrow("ECONNRESET");
  });

  it("첫 철회(표지에 그룹 없음) 중 ECONNRESET → 성공이 아니라 PAIR_REMOVE_STOP_FAILED · 핀은 지워지고 표지가 남아 다시 실행할 수 있다", async () => {
    const deps = pcDeps();
    await seed(deps, { keyId: "k1", name: "Work" });
    const removal = removeDeps(deps);
    await expect(executePair(removal.value, ["--remove", "k1"])).rejects
      .toMatchObject({ code: "PAIR_REMOVE_STOP_FAILED", message: expect.stringContaining("ECONNRESET") });
    expect(removal.out()).toBe("");
    expect((await loadPcKeys(deps.keysPath)).accounts[KEY]).toMatchObject({ browsers: [], pendingTurnOff: { groups: [] } });
  });

  it("겹친 철회 — 나중 철회의 최초 조회가 ECONNRESET 으로 실패한 뒤 먼저 철회가 끝나도, 같은 명령은 PAIR_NOT_FOUND 가 아니라 조회·종료로 다시 들어간다(리뷰 impl-3 #1)", async () => {
    const deps = pcDeps();
    await seed(deps, { keyId: "k1", name: "Work" }, { keyId: "k2", name: "Home" });
    const GROUP: PcGroup = { session: "ainecto-pc", pid: 4242, pgid: 4242 };
    let firstIn!: () => void;
    const firstInTurnOff = new Promise<void>((resolve) => { firstIn = resolve; });
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const first = executePair(removeDeps(deps, {
      findPcs: async () => [GROUP],
      turnOffPcs: async () => { firstIn(); await firstGate; },
    }).value, ["--remove", "k1"]);
    await firstInTurnOff;
    await expect(executePair(removeDeps(deps).value, ["--remove", "k2"])).rejects
      .toMatchObject({ code: "PAIR_REMOVE_STOP_FAILED", message: expect.stringContaining("ECONNRESET") });
    finishFirst();
    expect(await first).toBe(0);

    // 연결이 아직 리셋된다 — 다시 실행하면 조회에 들어가 같은 이유로 실패한다(표지 그대로).
    await expect(executePair(removeDeps(deps).value, ["--remove", "k2"])).rejects
      .toMatchObject({ code: "PAIR_REMOVE_STOP_FAILED", message: expect.stringContaining("ECONNRESET") });
    expect((await loadPcKeys(deps.keysPath)).accounts[KEY]?.pendingTurnOff)
      .toEqual({ removedAt: "2026-11-21T09:00:00.000Z", groups: [], removals: [{ keyId: "k2", name: "Home" }] });

    // 연결이 풀리면(데몬 소켓 없음 = 떠 있는 PC 연결 없음) 같은 명령이 조회·끄기 확인을 마치고 표지를 지운다.
    const actualNet = await vi.importActual<typeof import("node:net")>("node:net");
    vi.mocked(net.connect).mockImplementation(actualNet.connect);
    const retry = removeDeps(deps);
    expect(await executePair(retry.value, ["--remove", "k2"])).toBe(0);
    expect(retry.out()).toContain("Finished the earlier removal.");
    expect((await loadPcKeys(deps.keysPath)).accounts[KEY]?.pendingTurnOff).toBeUndefined();
  });
});
