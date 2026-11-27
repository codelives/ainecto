import { spawn } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { termRequest } from "../src/core/term/client";
import { termPaths } from "../src/core/term/paths";
import { daemonPids, holderPids, json, LONG, ok, rig, TSX, until, useTermRig } from "./termRig";

/**
 * 바깥 넘기기(세션 유지 구조 설계 3-4 · 단위 U2) — ★핵심 인수: 바깥 N → N+1 뒤 PTY PID·화면·uuid 그대로 · 구판 CLI kill-server 거절.
 * 진짜 바깥 두 벌(같은 소스 · 판만 파일로 다르게 — fixtures/termAt.ts)·진짜 holder·진짜 PTY. 세션은 보통 CLI(`ainecto term …`)로 만든다.
 */
useTermRig();

const AT = join(__dirname, "fixtures/termAt.ts");

/** 판 `version` 의 바깥을 띄우고 준비 한 줄과 pid 를 받는다. */
async function startOuter(version: string): Promise<{ status: string; pid: number }> {
  writeFileSync(join(rig.home, "term-version"), `${version}\n`);
  const child = spawn(process.execPath, ["--import", TSX, `--conditions=${rig.marker}`, AT, "term", "daemon", "--ready-fd", "3"], {
    cwd: rig.home, env: rig.env, stdio: ["ignore", "ignore", "pipe", "pipe"], detached: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const line = await new Promise<string>((resolve, reject) => {
    let text = "";
    child.stdio[3]!.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.includes("\n")) resolve(text.split("\n")[0]!);
    });
    child.once("exit", (code) => reject(new Error(`outer ${version} exited ${code} before ready: ${stderr}`)));
  });
  child.unref();
  return { ...(JSON.parse(line) as { status: string }), pid: child.pid! };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const listed = async (): Promise<Array<{ name: string; pid: number; instance: string; kind?: string }>> =>
  ((await json("term", "ls")).data as { sessions: never[] }).sessions;
const screenText = async (name: string): Promise<string> => ((await json("term", "read", name)).data as { lines: string[] }).lines.join("\n");
const pointer = (): string => readlinkSync(termPaths(rig.home).socket);

describe("바깥 넘기기 — 판이 바뀌어도 PTY 가 산다(U2)", () => {
  it("바깥 0.16.7 → 0.16.8: PTY PID·uuid·화면 그대로 · 포인터는 새 바깥 · 옛 바깥은 끝남 · 같은/낮은 판은 넘기지 않음 · 구판 kill-server 거절", async () => {
    const first = await startOuter("0.16.7");
    expect(first.status).toBe("ready");
    const paths = termPaths(rig.home);
    expect(lstatSync(paths.socket).isSymbolicLink()).toBe(true);
    const firstPointer = pointer();
    expect(firstPointer).toMatch(/^outer-[0-9a-f]{8}\.sock$/);

    await ok("term", "new", "keep", "--", "cat");
    await ok("term", "send", "keep", "before-handover");
    await ok("term", "key", "keep", "Enter");
    await until(async () => (await screenText("keep")).split("before-handover").length === 3, "echo before");
    const [before] = await listed();
    expect(before).toMatchObject({ name: "keep", kind: "user" });

    const second = await startOuter("0.16.8");
    expect(second.status).toBe("ready");
    await until(() => !alive(first.pid), "old outer ended");
    expect(pointer()).not.toBe(firstPointer);
    expect(existsSync(join(paths.dir, firstPointer))).toBe(false);
    expect(existsSync(join(paths.dir, pointer()))).toBe(true);

    // ★같은 PTY · 같은 uuid · 같은 화면 — 그리고 계속 쓸 수 있다
    const [after] = await listed();
    expect(after).toEqual(before);
    expect(alive(before!.pid)).toBe(true);
    expect(await screenText("keep")).toContain("before-handover");
    await ok("term", "send", "keep", "after-handover");
    await ok("term", "key", "keep", "Enter");
    await until(async () => (await screenText("keep")).split("after-handover").length === 3, "echo after");

    // 같은 판·낮은 판의 바깥은 넘겨받지 않는다(이미 있음) — 지금 바깥이 그대로 받는다
    expect((await startOuter("0.16.8")).status).toBe("locked");
    expect((await startOuter("0.16.7")).status).toBe("locked");
    expect(alive(second.pid)).toBe(true);

    // 구판 CLI 의 kill-server(holder uuid 없음)는 거절 — 세션은 그대로 · daemon.json 은 없다
    await expect(termRequest(paths, { op: "kill-server" }, { start: false })).rejects.toMatchObject({ code: "TERM_CLI_OUTDATED" });
    expect(alive(before!.pid)).toBe(true);
    expect(existsSync(paths.daemonInfo)).toBe(false);

    await ok("term", "kill-server");
    await until(() => daemonPids().length + holderPids().length === 0, "outer and holder gone");
    expect(alive(before!.pid)).toBe(false);
    expect(existsSync(paths.socket)).toBe(false);
  }, LONG);
});
