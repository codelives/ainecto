import { mkdtemp, rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executePair } from "../src/adapters/cli/pairCommand";
import { listed, runningPcGroups, turnOffPcs, type PcDeps } from "../src/adapters/cli/pcCommand";
import { loadPcKeys, updatePcKeys, withBrowser } from "../src/core/pc/pcKeys";
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
    const pcKey = await generateSigningJwk();
    await updatePcKeys(deps.keysPath, (keys) => withBrowser(keys, KEY, pcKey,
      { keyId: "k1", publicJwk: publicJwkOf(pcKey), name: "Work", pairedAt: "2026-11-21T00:00:00.000Z" }));
    let out = "";
    const removal = executePair({
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
    }, ["--remove", "k1"]);
    await expect(removal).rejects.toMatchObject({ code: "PAIR_REMOVE_STOP_FAILED", message: expect.stringContaining("ECONNRESET") });
    expect(out).toBe("");
    expect((await loadPcKeys(deps.keysPath)).accounts[KEY]).toMatchObject({ browsers: [], pendingTurnOff: { groups: [] } });
  });
});
