import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pcPlan, pcRemoteSetup, runPcParts, runPcRemote } from "../src/adapters/cli/pcRemote";
import { accountKey } from "../src/core/pc/pcSettings";
import type { RemoteResult } from "../src/core/term/remote";
import { termPaths } from "../src/core/term/paths";
import { FakeRemoteServer } from "./support/fakeRemoteServer";
import { LONG, ok, rig, until, useTermRig } from "./termRig";

describe("pc 프로세스 = Agent + 원격 다리(runPcParts)", () => {
  it("무엇을 돌리나 — Agent 가 없어도 원격이 허용이면 다리만 · 둘 다 없으면 시작하지 않는다", () => {
    expect(pcPlan({ agents: 1, remoteEnabled: true })).toBe("agent-and-remote");
    expect(pcPlan({ agents: 2, remoteEnabled: false })).toBe("agent-and-remote");
    expect(pcPlan({ agents: 0, remoteEnabled: true })).toBe("remote-only");
    expect(pcPlan({ agents: 0, remoteEnabled: false })).toBe("nothing");
  });

  it("Agent 가 끝나도(다른 PC 가 Agent 를 가져감) 원격은 계속 — 둘 다 끝나야 끝난다 · 코드는 Agent 가 0 이 아니면 그것", async () => {
    let finishRemote: (result: RemoteResult) => void = () => undefined;
    const remote = new Promise<RemoteResult>((resolve) => {
      finishRemote = resolve;
    });
    let ended = false;
    const done = runPcParts(Promise.resolve(1), () => remote, new AbortController().signal).then((code) => {
      ended = true;
      return code;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ended).toBe(false);
    finishRemote({ exitCode: 0, reason: "Stopped." });
    expect(await done).toBe(1);
  });

  it("Agent 가 시작부터 던지면 다리를 멈추고 그 오류를 던진다(start 가 사유를 본다)", async () => {
    let stopped = false;
    const failure = new Error("Neither Claude Code nor Codex is on PATH.");
    await expect(runPcParts(Promise.reject(failure), (stop) => new Promise<RemoteResult>((resolve) => {
      stop.addEventListener("abort", () => {
        stopped = true;
        resolve({ exitCode: 0, reason: "Stopped." });
      });
    }), new AbortController().signal)).rejects.toBe(failure);
    expect(stopped).toBe(true);
  });

  it("멈춤 신호는 다리에도 간다 · 다리가 먼저 끝나도(REPLACED) Agent 를 기다린다", async () => {
    const user = new AbortController();
    let agentDone: (code: number) => void = () => undefined;
    const agent = new Promise<number>((resolve) => {
      agentDone = resolve;
    });
    let remoteSignal: AbortSignal | undefined;
    const done = runPcParts(agent, async (stop) => {
      remoteSignal = stop;
      return { exitCode: 0, reason: "Another remote terminal bridge on this PC took over (REPLACED)." };
    }, user.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    user.abort();
    expect(remoteSignal?.aborted).toBe(true);
    agentDone(0);
    expect(await done).toBe(0);
  });
});

describe("pc run 의 원격 다리 — pc.json(pcId·계정별 원격 허용) → open", () => {
  useTermRig();
  let fake: FakeRemoteServer;
  beforeEach(async () => {
    fake = new FakeRemoteServer();
    await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  const PC_ID = "6f2c1d3e-0000-4000-8000-000000000002";

  function writeSettings(accounts: Record<string, { consentedAt: string; remoteTerminal: boolean }>): string {
    const path = join(rig.home, ".ainecto", "pc.json");
    mkdirSync(join(rig.home, ".ainecto"), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ pcId: PC_ID, hostName: "test-host", accounts }), { mode: 0o600 });
    return path;
  }

  function run(settingsPath: string, account: () => Promise<{ userId?: string }>) {
    const stop = new AbortController();
    const err: string[] = [];
    const done = pcRemoteSetup({
      endpoint: fake.endpoint,
      auth: { getAccessToken: async () => "t", refreshAfterUnauthorized: async () => "t" },
      account,
      io: {
        stdin: new PassThrough() as unknown as NodeJS.ReadStream,
        stdout: { write: () => true } as unknown as NodeJS.WriteStream,
        stderr: { write: (text: string) => { err.push(text); return true; } } as unknown as NodeJS.WriteStream,
      },
      settingsPath,
      paths: termPaths(rig.home),
      sessionsDir: join(rig.home, "app", "sessions"),
      hostName: "test-host",
      env: Object.fromEntries(Object.entries(rig.env).filter((e): e is [string, string] => typeof e[1] === "string")),
    }).then((setup) => runPcRemote(setup, stop.signal));
    return { done, stop, err };
  }

  it("허용한 계정 → pc.json 의 pcId 로 remoteEnabled=true · 목록에서 자기 pc 세션은 뺀다", async () => {
    await ok("term", "new", "work", "--", "cat");
    await ok("term", "new", "ainecto-pc", "--", "/bin/sh", "-c", "sleep 600");
    const path = writeSettings({ [accountKey(fake.endpoint, "u1")]: { consentedAt: "2026-11-17T00:00:00Z", remoteTerminal: true } });
    const bridge = run(path, async () => ({ userId: "u1" }));
    await until(() => fake.ops().includes("open"), "open");
    expect(fake.calls[0]?.body).toMatchObject({ pcId: PC_ID, hostName: "test-host", remoteEnabled: true });
    expect(fake.listedNames()).toEqual(["work"]);
    bridge.stop.abort();
    expect((await bridge.done).exitCode).toBe(0);
  }, LONG);

  it("막은 계정·동의 없음·계정을 못 읽음 → remoteEnabled=false(웹에는 «이 PC 에서 막음»)", async () => {
    await ok("term", "new", "work", "--", "cat");
    const blocked = writeSettings({ [accountKey(fake.endpoint, "u1")]: { consentedAt: "2026-11-17T00:00:00Z", remoteTerminal: false } });
    for (const account of [async () => ({ userId: "u1" }), async () => ({ userId: "someone-else" }), async () => {
      throw new Error("offline");
    }]) {
      const before = fake.calls.length;
      const bridge = run(blocked, account);
      await until(() => fake.calls.slice(before).some((call) => call.op === "open"), "open");
      expect(fake.calls.slice(before).find((call) => call.op === "open")?.body).toMatchObject({ pcId: PC_ID, remoteEnabled: false, sessions: [] });
      bridge.stop.abort();
      await bridge.done;
    }
  }, LONG);
});
