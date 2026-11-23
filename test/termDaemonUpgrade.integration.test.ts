import { readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { upgradeDaemon, type PcDeps } from "../src/adapters/cli/pcCommand";
import { termPaths } from "../src/core/term/paths";
import { CLI_VERSION } from "../src/core/version";
import { daemonPids, LONG, ok, rig, sessions, until, useTermRig } from "./termRig";

/**
 * KAN-1348(11-23 Ryan 운영 시험) — 11-17 판 term 데몬이 남아 0.15.3 의 프로젝트 묶음을 버렸다.
 * 진짜 CLI·데몬으로: 옛 판 데몬은 PC 연결 세션뿐이면 내리고, 사용자 세션이 있으면(비대화) 그대로 둔다.
 */
useTermRig();

/** 데몬을 «옛 판»으로 보이게 — daemon.json 의 판만 바꾼다(데몬이 시작할 때 쓴 파일). */
function makeDaemonOld(): number {
  const file = termPaths(rig.home).daemonInfo;
  const info = JSON.parse(readFileSync(file, "utf8")) as { pid: number; version: string };
  writeFileSync(file, `${JSON.stringify({ ...info, version: "0.14.0-next.9.1" })}\n`);
  return info.pid;
}

function deps(): PcDeps {
  const stdin = new PassThrough();
  stdin.end();
  return {
    io: {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: { write: () => true } as unknown as NodeJS.WriteStream,
      stderr: { write: () => true } as unknown as NodeJS.WriteStream,
    },
    interactive: false,
    paths: termPaths(rig.home),
    cliVersion: CLI_VERSION,
    stopDeadlineMs: 10_000,
  } as unknown as PcDeps;
}

describe("옛 판 term 데몬 교체(upgradeDaemon) — 실물", () => {
  it("PC 연결 세션뿐 → 옛 데몬을 내린다(다음 start 가 이 판으로 새로 띄운다)", async () => {
    // pc run 을 도는 세션 흉내 — 명령 단어에 «pc run» 이 있으면 PC 연결 세션이다(runningPcs 와 같은 판정).
    await ok("term", "new", "ainecto-pc", "--", "/bin/sh", "-c", "sleep 300", "pc", "run");
    const oldPid = makeDaemonOld();
    const notes: string[] = [];
    await upgradeDaemon(deps(), (line) => notes.push(line));
    await until(() => !daemonPids().includes(oldPid), "old daemon gone");
    expect(notes).toEqual(["Updating the AiNecto terminal service on this PC…"]);
    await ok("term", "new", "after", "--", "/bin/sh");
    const info = JSON.parse(readFileSync(termPaths(rig.home).daemonInfo, "utf8")) as { pid: number; version: string };
    expect(info.version).toBe(CLI_VERSION);
    expect(info.pid).not.toBe(oldPid);
  }, LONG);

  it("사용자 세션이 있으면(비대화) 묻지 않고 그대로 둔다 — 세션이 살아 있다", async () => {
    await ok("term", "new", "work", "--", "/bin/sh");
    const oldPid = makeDaemonOld();
    const notes: string[] = [];
    await upgradeDaemon(deps(), (line) => notes.push(line));
    expect(notes).toEqual([]);
    expect(daemonPids()).toContain(oldPid);
    expect((await sessions()).map((item) => item.name)).toContain("work");
  }, LONG);
});
