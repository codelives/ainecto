import { execFileSync } from "node:child_process";
import { readManifest } from "../../src/core/term/manifest";
import { cli, daemonLog, LONG, ok, rig, until, useWinRig, WINDOWS } from "./winRig";

/**
 * 재부팅·로그오프 뒤 복원(manual-verify 8-2) — Windows 의 node-pty 는 끝남 신호를 주지 않아(늘 0) 0.15.0 은 바깥에서 끝난 세션도
 * «스스로 끝남»으로 sessions.json 에서 지웠다 → 재부팅 뒤 `term restore` 가 빈다. 이제 Windows 는 «끝 코드 0 이 아님»이면 남긴다
 * (launch.endedFromOutside). 재부팅 그 자체는 CI 에서 못 하므로 «바깥에서 강제로 끝남»(taskkill /F = 끝 코드 1)으로 본다.
 */
async function manifestNames(): Promise<string[]> {
  return (await readManifest(rig.paths.manifest)).map((entry) => entry.name);
}

async function sessionPid(name: string): Promise<number> {
  const listed = JSON.parse(await ok("term", "ls", "--json")) as { data: { sessions: { name: string; pid: number }[] } };
  const found = listed.data.sessions.find((session) => session.name === name);
  if (!found) throw new Error(`no session ${name}`);
  return found.pid;
}

async function exitRecord(name: string): Promise<Record<string, unknown>> {
  let record: Record<string, unknown> | undefined;
  await until(async () => {
    record = (await daemonLog()).find((line) => line.event === "session_exit" && line.name === name);
    return record !== undefined;
  }, `session_exit ${name}`);
  return record ?? {};
}

describe.runIf(WINDOWS)("Windows 세션 복원 — 바깥에서 끝난 세션은 남고, exit 로 끝낸 셸은 지운다", () => {
  useWinRig();

  it("taskkill 로 끝난 셸 → sessions.json 에 남음 → term restore 가 다시 띄움 · exit 로 끝낸 셸 → 지움", async () => {
    await ok("term", "new", "r1", "--", rig.shell);
    await ok("term", "new", "r2", "--", rig.shell);
    expect((await manifestNames()).sort()).toEqual(["r1", "r2"]);

    execFileSync("taskkill", ["/F", "/PID", String(await sessionPid("r1"))], { windowsHide: true });
    const killed = await exitRecord("r1");
    // 측정 기록 — 바깥에서 끝난 세션이 받은 끝 코드·신호.
    console.log(`[restore-measure] r1 session_exit exitCode=${String(killed.exitCode)} signal=${String(killed.signal)} kept=${String(killed.kept)}`);
    expect(killed.kept).toBe(true);
    expect(await manifestNames()).toContain("r1");

    await ok("term", "send", "r2", "--", "exit");
    await ok("term", "key", "r2", "enter");
    const exited = await exitRecord("r2");
    console.log(`[restore-measure] r2 session_exit exitCode=${String(exited.exitCode)} signal=${String(exited.signal)} kept=${String(exited.kept)}`);
    expect(exited.kept).toBe(false);
    expect(await manifestNames()).not.toContain("r2");

    const run = await cli("term", "restore", "--json");
    expect(run.code, run.stderr).toBe(0);
    const restored = (JSON.parse(run.stdout) as { data: { restored: string[] } }).data.restored;
    expect(restored).toEqual(["r1"]);
  }, LONG);
});
