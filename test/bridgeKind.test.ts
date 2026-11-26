import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { startPcSession, type PcDeps } from "../src/adapters/cli/pcCommand";
import { SERVE_CONNECTED_PREFIX } from "../src/core/agent/serve";
import { bridgeKind, PC_SESSION_NAME } from "../src/core/pc/bridgeKind";
import { daemonUpgrade, runningPcs } from "../src/core/pc/pcSession";
import { termPaths } from "../src/core/term/paths";
import { waitForMatch } from "../src/core/term/wait";
import { json, LONG, ok, rig, useTermRig } from "./termRig";

/**
 * 세션 종류 판정 한 곳(bridgeKind) + P1-1 입구 ②(startPcSession 이 종류를 찍고 그 인스턴스로만 준비를 본다).
 * 설계 term-ledger-cli-unit-prep 2-1·3절.
 */
const PC_RUN = ["npx", "-y", "--package", "@ainecto/mcp@0.16.3", "ainecto", "pc", "run"];

describe("bridgeKind — 종류 판정 한 곳", () => {
  it("kind 칸이 있으면 그 값 · 옛 줄은 이름+pc run 둘 다일 때만 pc-bridge", () => {
    expect(bridgeKind({ name: "anything", command: null, kind: "pc-bridge" })).toBe("pc-bridge");
    expect(bridgeKind({ name: PC_SESSION_NAME, command: PC_RUN, kind: "user" })).toBe("user");
    expect(bridgeKind({ name: PC_SESSION_NAME, command: PC_RUN })).toBe("pc-bridge");
    // r3 P0-1 — 이름이 다른 사용자 작업 `node tasks.js pc run` 은 사용자 세션
    expect(bridgeKind({ name: "job", command: ["node", "tasks.js", "pc", "run"] })).toBe("user");
    // 이름만 같은 사용자 셸
    expect(bridgeKind({ name: PC_SESSION_NAME, command: null })).toBe("user");
    expect(bridgeKind({ name: PC_SESSION_NAME, command: ["/bin/zsh"] })).toBe("user");
  });

  it("runningPcs·daemonUpgrade 가 같은 판정 — 사용자 `pc run` 작업을 PC 연결로 세지 않는다(stopPc 가 끄지 않는다)", () => {
    const pc = { name: PC_SESSION_NAME, cwd: "/w", command: PC_RUN };
    const job = { name: "job", cwd: "/w", command: ["node", "tasks.js", "pc", "run"] };
    const stamped = { name: "renamed", cwd: "/w", command: PC_RUN, kind: "pc-bridge" as const };
    expect(runningPcs([pc, job, stamped]).map((item) => item.session)).toEqual([PC_SESSION_NAME, "renamed"]);
    expect(daemonUpgrade("0.16.3", "0.16.5", [pc, job], false)).toEqual({ kind: "ask", sessions: ["job"] });
  });
});

describe("P1-1 입구 ② — startPcSession · 준비는 그 인스턴스로만", () => {
  useTermRig();

  it("startPcSession 의 new 가 kind pc-bridge 를 찍는다(ls 에 그대로)", async () => {
    await ok("term", "new", "keep", "--", "cat");
    const sink = { write: () => true } as unknown as NodeJS.WriteStream;
    const env = Object.fromEntries(Object.entries(rig.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const connected = `console.log(${JSON.stringify(`${SERVE_CONNECTED_PREFIX}test-host.`)}); setInterval(() => undefined, 1000);`;
    const deps = {
      io: { stdin: new PassThrough() as unknown as NodeJS.ReadStream, stdout: sink, stderr: sink },
      json: false,
      interactive: false,
      paths: termPaths(rig.home),
      cwd: rig.home,
      sessionEnv: env,
      flags: { env: "dev" },
      managedCommand: (args: string[]) => [process.execPath, "-e", connected, "--", ...args],
      agentLog: join(rig.home, "agent.log"),
      readyDeadlineMs: 10_000,
    } as unknown as PcDeps;
    expect((await startPcSession(deps)).kind).toBe("connected");
    const sessions = ((await json("term", "ls")).data as { sessions: Array<{ name: string; kind?: string }> }).sessions;
    expect(sessions.find((s) => s.name === PC_SESSION_NAME)?.kind).toBe("pc-bridge");
    expect(sessions.find((s) => s.name === "keep")?.kind, "로컬 term new 는 user").toBe("user");
  }, LONG);

  it("waitForMatch(instance) — 화면이 맞아도 다른 인스턴스면 SESSION_REPLACED · 같은 인스턴스면 맞음", async () => {
    await ok("term", "new", "w", "--", "/bin/sh", "-c", "echo READY; cat");
    const instance = ((await json("term", "ls")).data as { sessions: Array<{ name: string; instance: string }> }).sessions
      .find((s) => s.name === "w")!.instance;
    const paths = termPaths(rig.home);
    await expect(waitForMatch(paths, "w", /^READY/, { scrollback: true }, 5_000, randomUUID()))
      .rejects.toMatchObject({ code: "SESSION_REPLACED" });
    expect((await waitForMatch(paths, "w", /^READY/, { scrollback: true }, 5_000, instance)).line).toBe("READY");
  }, LONG);
});
