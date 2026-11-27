import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { TermClient } from "../src/core/term/client";
import { holderCaps } from "../src/core/term/holderTalk";
import { termPaths } from "../src/core/term/paths";
import { holderPids, LONG, rig, until, useTermRig } from "./termRig";

/**
 * holder 한 벌(세션 유지 구조 설계 3-1 · 단위 U1) — 바깥 없이 holder 에 직접 붙어 세션을 만들고 읽고 쓴다. 진짜 holder 프로세스·진짜 PTY.
 * 바깥이 하는 일(임대·via)을 이 시험이 손으로 한다.
 */
useTermRig();

/** `term holder --ready-fd 3` 을 띄우고 준비 한 줄을 받는다. */
async function startHolder(): Promise<{ status: string }> {
  const child = spawn(process.execPath, [...rig.nodeArgs, "term", "holder", "--ready-fd", "3"], {
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
    child.once("exit", (code) => reject(new Error(`holder exited ${code} before ready: ${stderr}`)));
  });
  child.unref();
  return JSON.parse(line) as { status: string };
}

const env = (): Record<string, string> => Object.fromEntries(Object.entries(rig.env).filter((e): e is [string, string] => typeof e[1] === "string"));
const holderClient = async (): Promise<TermClient> => TermClient.connect(termPaths(rig.home), termPaths(rig.home).holderSocket);
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("term holder — 바깥 없이 세션을 쥔다(U1)", () => {
  it("caps → 임대 → new(uuid·종류 user) → send·key·read 가 같은 PTY · 임대 없는 연결은 거절 · kill-server 는 holder uuid 를 실어야", async () => {
    expect(await startHolder()).toEqual({ status: "ready" });
    const paths = termPaths(rig.home);
    // ★daemon.json 을 쓰지 않는다 — 구판 CLI 가 그 판으로 업데이트 길에 들어가지 않게(설계 3-4)
    expect(existsSync(paths.daemonInfo)).toBe(false);
    const info = JSON.parse(readFileSync(paths.holderInfo, "utf8")) as { pid: number; holder: string; version: string };

    const control = await holderClient();
    const caps = holderCaps(await control.request({ op: "caps" }));
    expect(caps).toMatchObject({ holder: info.holder, pid: info.pid, lease: null });
    expect(Object.keys(caps!.talk)).toEqual(expect.arrayContaining(["new", "read", "send", "key", "lease", "via", "kill-server"]));

    // 임대 없이는 세션 요청을 적용하지 않는다
    await expect(control.request({ op: "ls" })).rejects.toMatchObject({ code: "TERM_HOLDER_NO_LEASE" });
    const outer = randomUUID();
    expect(await control.request({ op: "lease", outer, version: "0.0.1", pid: process.pid })).toMatchObject({ granted: true, holder: { holder: info.holder } });
    // holder.json 은 임대 바깥의 pid 를 안내용으로 적는다(멈춘 데몬 안내 — 판정에는 안 쓴다)
    await until(() => (JSON.parse(readFileSync(paths.holderInfo, "utf8")) as { outer?: { outer: string; pid: number } }).outer?.outer === outer,
      "holder.json names the lease outer");
    expect((JSON.parse(readFileSync(paths.holderInfo, "utf8")) as { outer: { pid: number } }).outer.pid).toBe(process.pid);

    const created = await control.request({ op: "new", name: "a", cwd: rig.home, command: ["cat"], env: env() }) as
      { name: string; instance: string; kind: string; pid: number };
    expect(created).toMatchObject({ name: "a", kind: "user" });
    expect(created.instance).toMatch(/^[0-9a-f-]{36}$/);
    expect(alive(created.pid)).toBe(true);

    await control.request({ op: "send", name: "a", text: "holder-hello", paste: false, instance: created.instance });
    await control.request({ op: "key", name: "a", key: "Enter" });
    await until(async () => ((await control.request({ op: "read", name: "a", scrollback: false })) as { lines: string[] }).lines
      .filter((line) => line.includes("holder-hello")).length === 2, "cat echoed the line");

    // 다른 바깥의 연결(via)은 임대가 없어 거절 · 같은 바깥의 via 는 적용 · 두 번째 임대는 쥔 바깥을 알려 준다
    const stranger = await holderClient();
    await stranger.request({ op: "via", outer: randomUUID() });
    await expect(stranger.request({ op: "ls" })).rejects.toMatchObject({ code: "TERM_HOLDER_NO_LEASE" });
    expect(await stranger.request({ op: "lease", outer: randomUUID(), version: "9.9.9", pid: process.pid })).toEqual({ granted: false, outer, version: "0.0.1" });
    const piped = await holderClient();
    await piped.request({ op: "via", outer });
    const listed = await piped.request({ op: "ls" }) as { sessions: Array<{ instance: string; pid: number; kind: string }> };
    expect(listed.sessions).toEqual([expect.objectContaining({ instance: created.instance, pid: created.pid, kind: "user" })]);

    // kill-server — uuid 없음(구판 CLI) · 다른 uuid → 거절, 세션은 그대로
    await expect(piped.request({ op: "kill-server" })).rejects.toMatchObject({ code: "TERM_CLI_OUTDATED" });
    await expect(piped.request({ op: "kill-server", holder: randomUUID() })).rejects.toMatchObject({ code: "TERM_HOLDER_CHANGED" });
    expect(alive(created.pid)).toBe(true);

    // 두 번째 holder 는 잠금에 진다
    expect(await startHolder()).toEqual({ status: "locked" });

    expect(await piped.request({ op: "kill-server", holder: info.holder })).toEqual({ killed: ["a"] });
    await until(() => holderPids().length === 0, "holder gone");
    await until(() => !alive(created.pid), "pty gone");
    for (const client of [control, stranger, piped]) client.close();
  }, LONG);

  it("임대를 쥔 연결이 끊기면 임대가 풀리고 다음 바깥이 잡는다 · 세션·PTY 는 그대로", async () => {
    expect(await startHolder()).toEqual({ status: "ready" });
    const first = await holderClient();
    const one = randomUUID();
    await first.request({ op: "lease", outer: one, version: "0.0.1", pid: process.pid });
    const created = await first.request({ op: "new", name: "keep", cwd: rig.home, command: ["cat"], env: env() }) as { instance: string; pid: number };
    await first.request({ op: "send", name: "keep", text: "before-switch", paste: false });
    first.close();

    const two = randomUUID();
    const second = await holderClient();
    await until(async () => ((await second.request({ op: "lease", outer: two, version: "0.0.2", pid: process.pid })) as { granted: boolean }).granted, "lease free");
    const listed = await second.request({ op: "ls" }) as { sessions: Array<{ instance: string; pid: number }> };
    expect(listed.sessions).toEqual([expect.objectContaining({ instance: created.instance, pid: created.pid })]);
    const screen = await second.request({ op: "read", name: "keep", scrollback: false }) as { lines: string[]; instance: string };
    expect(screen.instance).toBe(created.instance);
    expect(screen.lines.join("\n")).toContain("before-switch");
    const caps = holderCaps(await second.request({ op: "caps" }));
    await second.request({ op: "kill-server", holder: caps!.holder });
    await until(() => holderPids().length === 0, "holder gone");
    second.close();
  }, LONG);
});
