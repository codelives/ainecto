import { execFile, execFileSync } from "node:child_process";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { daemonCaps } from "../src/core/term/client";
import { termPaths } from "../src/core/term/paths";
import { daemonPids, holderPids, json, LONG, ok, rig, ROOT, sessions, startOuterAt, TERM_AT, TSX, until, useTermRig } from "./termRig";

/**
 * term 데몬을 이 판으로 맞추기(upgradeDaemon — 연결 명령·자동 업데이트의 앞단계 · 세션 유지 구조 3-4·5절) — 실물.
 *   새 구조: 바깥이 낮은 판이면 묻지 않고 넘겨받는다 — 세션(PTY PID·uuid) 그대로.
 *   옛 구조(진짜 0.16.6 — 이 가지의 바탕 커밋 코드를 꺼내 돌린다): 세션이 있으면 첫 전환은 대화형 «예» 한 번으로만 · 비대화면 그대로 ·
 *   바꾸면 옛 데몬이 끝나고 daemon.json 이 지워지고 다음 명령이 새 구조로 띄운다.
 * 이 시험의 «CLI» 는 fixtures/termAt.ts upgrade(판은 $HOME/term-version) — 넘기기에서 띄우는 바깥도 같은 진입·같은 판이다.
 */
useTermRig();

/** 바탕 커밋(origin/release/latest-0.16.6) — 옛 구조 데몬의 실제 코드. */
const OLD_COMMIT = "15b49077bbf18ccb62e809264e6ee40fd2fcab51";
let oldRoot = "";

beforeAll(async () => {
  // git 작업 트리를 만들지 않고 파일만 꺼낸다(저장소 메타데이터를 건드리지 않는다). 의존성은 지금 것을 링크 — 0.16.6 과 package.json 이 같다.
  oldRoot = await mkdtemp(join(tmpdir(), "aterm-old-"));
  execFileSync("/bin/sh", ["-c", `git -C "${ROOT}" archive ${OLD_COMMIT} | tar -x -C "${oldRoot}"`]);
  symlinkSync(join(ROOT, "node_modules"), join(oldRoot, "node_modules"));
});

afterAll(async () => {
  if (oldRoot) await rm(oldRoot, { recursive: true, force: true });
});

/** 옛 판(0.16.6) CLI 로 한 번 — 그 CLI 가 옛 구조 데몬을 띄운다(표지가 붙어 시험 정리가 그 데몬도 거둔다). */
function oldCli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, ["--import", TSX, `--conditions=${rig.marker}`, join(oldRoot, "src/bin/ainecto.ts"), ...args],
      { env: rig.env, cwd: rig.home }, (error, stdout, stderr) => done({ code: error && typeof error.code === "number" ? error.code : 0, stdout, stderr }));
  });
}

/** 판 `version` 의 CLI 로 upgradeDaemon 하나 — 안내 줄들. `answer` 가 있으면 대화형으로 그 답을 준다. */
function upgradeAt(version: string, answer?: string): Promise<string[]> {
  writeFileSync(join(rig.home, "term-version"), `${version}\n`);
  return new Promise((done, fail) => {
    const child = execFile(process.execPath, ["--import", TSX, `--conditions=${rig.marker}`, TERM_AT, "upgrade", ...(answer !== undefined ? ["--interactive"] : [])],
      { env: rig.env, cwd: rig.home }, (error, stdout, stderr) => {
        if (error) fail(new Error(`upgrade ${version} failed: ${stderr}`));
        else done((JSON.parse(stdout.trim().split("\n").pop()!) as { notes: string[] }).notes);
      });
    child.stdin?.end(answer !== undefined ? `${answer}\n` : "");
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const ASK = "The terminal structure on this PC changed, so this one time the 1 open terminal session(s) will close: legacy. From the next update on they stay open.";

describe("term 데몬을 이 판으로(upgradeDaemon) — 실물", () => {
  it("새 구조 · 바깥이 낮은 판 → 묻지 않고 넘겨받는다(비대화 · 사용자 세션이 있어도) — PTY PID·uuid 그대로 · 같은 판이면 아무것도 안 함", async () => {
    const first = await startOuterAt("0.16.7");
    await ok("term", "new", "work", "--", "cat");
    const before = await sessions();

    expect(await upgradeAt("0.16.7")).toEqual([]);
    expect(alive(first.pid)).toBe(true);

    expect(await upgradeAt("0.16.8")).toEqual(["Updated the AiNecto terminal service on this PC to 0.16.8 — open sessions stay open."]);
    await until(() => !alive(first.pid), "old outer ended");
    expect(await sessions()).toEqual(before);
    const found = await daemonCaps(termPaths(rig.home));
    expect(found.daemon && found.caps?.version).toBe("0.16.8");
  }, LONG);

  it("옛 구조(진짜 0.16.6) · 세션이 있으면 비대화는 그대로 · 대화형 «아니오»도 그대로 · «예»면 한 번 닫히고 daemon.json 을 지운 뒤 새 구조로", async () => {
    expect((await oldCli("term", "new", "legacy", "--", "/bin/sh")).code).toBe(0);
    const paths = termPaths(rig.home);
    expect(existsSync(paths.daemonInfo)).toBe(true);
    const [oldDaemon] = daemonPids();
    expect(await daemonCaps(paths)).toEqual({ daemon: true, caps: undefined });

    expect(await upgradeAt("0.16.8")).toEqual([]);
    expect(await upgradeAt("0.16.8", "n")).toEqual([ASK]);
    expect(alive(oldDaemon!)).toBe(true);
    expect((await sessions()).map((session) => session.name)).toEqual(["legacy"]);

    expect(await upgradeAt("0.16.8", "y")).toEqual([ASK, "Switching the AiNecto terminal service on this PC to the new structure…"]);
    await until(() => !alive(oldDaemon!), "old daemon gone");
    expect(existsSync(paths.daemonInfo)).toBe(false);

    // 다음 명령은 새 구조 — 세션은 uuid·종류를 가진다
    await ok("term", "new", "fresh", "--", "/bin/sh");
    expect(holderPids()).toHaveLength(1);
    const listed = (await json("term", "ls")).data as { sessions: Array<{ name: string; instance?: string; kind?: string }> };
    expect(listed.sessions).toEqual([expect.objectContaining({ name: "fresh", kind: "user", instance: expect.stringMatching(/^[0-9a-f-]{36}$/) })]);
  }, LONG);

  it("KAN-1616 — 첫 전환으로 닫힌 세션은 끝 기록을 남긴다(옛 데몬은 남기지 않는다) · 방금 본 uuid · exited · 지금 계정 수신처 → 새 holder 의 책", async () => {
    expect((await oldCli("term", "new", "legacy", "--", "/bin/sh")).code).toBe(0);
    const seen = (await sessions()).find((session) => session.name === "legacy") as { instance?: string } | undefined;
    expect(seen?.instance).toMatch(/^[0-9a-f-]{36}$/);
    const [oldDaemon] = daemonPids();
    writeFileSync(join(rig.home, "term-destination"), "https://example.test/mcp#u1\n");

    await upgradeAt("0.16.8", "y");
    await until(() => !alive(oldDaemon!), "old daemon gone");
    await ok("term", "new", "fresh", "--", "/bin/sh");
    const ended = ((await json("term", "ls")).data as { ended?: Array<Record<string, unknown>> }).ended ?? [];
    expect(ended).toEqual([expect.objectContaining({ instance: seen?.instance, name: "legacy", reason: "exited", to: "https://example.test/mcp#u1" })]);
  }, LONG);
});
