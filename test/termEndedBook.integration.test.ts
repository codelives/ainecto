import { existsSync, readFileSync } from "node:fs";
import { termRequest } from "../src/core/term/client";
import { termPaths } from "../src/core/term/paths";
import { parseClientMessage } from "../src/core/term/protocol";
import { daemonPids, json, LONG, ok, rig, sleep, until, useTermRig } from "./termRig";

/**
 * 끝 기록 책 `ended.json`(설계 term-ledger-cli-unit-prep 1절) — 진짜 CLI·데몬·PTY. 서버 장부가 «끝났습니다(시각·코드)»를 보이게 하는 원자재.
 * 다리 쪽(올리기·2xx 뒤 지우기)은 termRemote.test.ts 의 «장부 끝 기록» 시험.
 */
useTermRig();

type Ended = { instance: string; name: string; kind?: string; command: string[] | null; endedAt: string; reason: string; exitCode?: number; signal?: string };

const book = (): Ended[] => {
  const path = termPaths(rig.home).ended;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { ended: Ended[] }).ended : [];
};
const listed = async (): Promise<{ sessions: Array<{ name: string; instance: string; kind?: string }>; ended?: Ended[] }> =>
  (await json("term", "ls")).data as never;
const instanceOf = async (name: string): Promise<string> => (await listed()).sessions.find((s) => s.name === name)!.instance;

describe("term 끝 기록 책 — 세션이 끝나는 네 곳이 한 줄씩", () => {
  it("스스로 끝(exit 3) → exited+코드 · 신호로 끝 → signal 글(코드 없음) · kill → killed 1건(뒤따른 PTY 끝이 와도 2건 아님) · ls 에 ended", async () => {
    await ok("term", "new", "keep", "--", "cat");
    await ok("term", "new", "three", "--", "/bin/sh", "-c", "sleep 0.3; exit 3");
    await ok("term", "new", "sig", "--", "/bin/sh", "-c", "sleep 0.3; kill -TERM $$");
    await ok("term", "new", "k", "--", "cat");
    const k = await instanceOf("k");
    await ok("term", "kill", "k");
    await until(() => book().length === 3, "three ends");
    await sleep(500);   // kill 뒤의 PTY 끝까지 지나가게
    const ended = book();
    // 스스로 끝나는 둘의 instance 는 책에서 — ls 보다 먼저 끝날 수 있다(바쁜 기계)
    const three = ended.find((r) => r.name === "three")!.instance;
    const sig = ended.find((r) => r.name === "sig")!.instance;
    expect(ended).toHaveLength(3);
    expect(ended.find((r) => r.instance === three)).toEqual({ instance: three, name: "three", command: ["/bin/sh", "-c", "sleep 0.3; exit 3"],
      endedAt: expect.any(String), reason: "exited", exitCode: 3 });
    expect(ended.find((r) => r.instance === sig)).toMatchObject({ name: "sig", reason: "exited", signal: "15" });
    expect(ended.find((r) => r.instance === sig)).not.toHaveProperty("exitCode");
    expect(ended.find((r) => r.instance === k)).toEqual({ instance: k, name: "k", command: ["cat"], endedAt: expect.any(String), reason: "killed" });
    expect((await listed()).ended?.map((r) => r.instance).sort()).toEqual([three, sig, k].sort());
  }, LONG);

  it("같은 이름이 두 번 끝나면 1건(새 것) · ended-ack 는 그 instance 만 지운다(같은 이름의 더 새 끝은 남음)", async () => {
    await ok("term", "new", "keep", "--", "cat");
    await ok("term", "new", "a", "--", "cat");
    const first = await instanceOf("a");
    await ok("term", "kill", "a");
    await ok("term", "new", "a", "--", "cat");
    const second = await instanceOf("a");
    await ok("term", "kill", "a");
    await until(() => book().some((r) => r.instance === second), "second end");
    expect(book().map((r) => r.instance)).toEqual([second]);
    // 다리가 옛 instance 를 ack 해도(늦게 온 2xx) 새 끝은 남는다
    const paths = termPaths(rig.home);
    const stale = await termRequest(paths, { op: "ended-ack", instances: [first] }, { start: false });
    expect(stale).toEqual({ daemon: true, data: { acked: 0 } });
    expect(book().map((r) => r.instance)).toEqual([second]);
    const acked = await termRequest(paths, { op: "ended-ack", instances: [second] }, { start: false });
    expect(acked).toEqual({ daemon: true, data: { acked: 1 } });
    await until(() => book().length === 0, "acked away");
    expect((await listed()).ended).toEqual([]);
  }, LONG);

  it("kill-server → 남은 세션마다 exited(코드 없음 — 사람이 세션마다 지운 것이 아니다) · 데몬이 다시 떠도 책은 남는다", async () => {
    await ok("term", "new", "a", "--", "cat");
    await ok("term", "new", "b", "--", "cat");
    const [a, b] = [await instanceOf("a"), await instanceOf("b")];
    await ok("term", "kill-server");
    await until(() => daemonPids().length === 0, "daemon gone");
    const ended = book();
    expect(ended.map((r) => [r.instance, r.reason]).sort()).toEqual([[a, "exited"], [b, "exited"]].sort());
    expect(ended.every((r) => r.exitCode === undefined && r.signal === undefined)).toBe(true);
    await ok("term", "new", "c", "--", "cat");
    expect((await listed()).ended?.map((r) => r.instance).sort()).toEqual([a, b].sort());
  }, LONG);

  it("종류 — new 의 kind 를 ls·매니페스트·끝 기록이 그대로 · 없이 만든 세션은 칸 없음 · 모르는 값은 요청 거절", async () => {
    await ok("term", "new", "plain", "--", "cat");
    const paths = termPaths(rig.home);
    await termRequest(paths, { op: "new", name: "bridge", cwd: rig.home, command: ["cat"], env: {}, kind: "pc-bridge" }, { start: false });
    const sessions = (await listed()).sessions;
    expect(sessions.find((s) => s.name === "bridge")?.kind).toBe("pc-bridge");
    expect(sessions.find((s) => s.name === "plain")).not.toHaveProperty("kind");
    const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as { sessions: Array<{ name: string; kind?: string }> };
    expect(manifest.sessions.find((s) => s.name === "bridge")?.kind).toBe("pc-bridge");
    await ok("term", "kill", "bridge");
    await until(() => book().some((r) => r.name === "bridge"), "bridge end");
    expect(book().find((r) => r.name === "bridge")).toMatchObject({ kind: "pc-bridge", reason: "killed" });
    expect(() => parseClientMessage(JSON.stringify({ id: "1", op: "new", name: "x", cwd: "/", command: null, env: {}, kind: "robot" })))
      .toThrow(/"kind" must be "user" or "pc-bridge"/);
    expect(() => parseClientMessage(JSON.stringify({ id: "1", op: "ended-ack", instances: "x" }))).toThrow(/"instances"/);
  }, LONG);
});
