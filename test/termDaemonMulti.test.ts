import { readFile } from "node:fs/promises";
import { openTermClient, termRequest, type TermClient } from "../src/core/term/client";
import { termPaths } from "../src/core/term/paths";
import type { TermEvent } from "../src/core/term/protocol";
import { daemonPids, LONG, ok, rig, sessions, until, useTermRig } from "./termRig";

/**
 * 데몬 op — 원격 터미널 여러 세션(KAN-738 next.10)이 쓰는 것: ls 의 lastOutputAt·label · read 의 modes · label · watch-sessions.
 * ★실 데몬·실 PTY(termRig).
 */
useTermRig();

async function rawClient(): Promise<TermClient> {
  const client = await openTermClient(termPaths(rig.home), { start: false });
  if (!client) throw new Error("no daemon");
  return client;
}

describe("ainecto term — 여러 세션용 데몬 op", () => {
  it("ls 는 세션의 마지막 출력 시각을 싣는다(출력이 있으면)", async () => {
    await ok("term", "new", "quiet", "--", "/bin/sh", "-c", "sleep 600");
    await ok("term", "new", "loud", "--", "/bin/sh", "-c", "echo hello; sleep 600");
    await until(async () => typeof (await sessions()).find((s) => s.name === "loud")?.lastOutputAt === "string", "loud has output");
    const loud = (await sessions()).find((s) => s.name === "loud");
    expect(Date.parse(String(loud?.lastOutputAt))).toBeGreaterThan(Date.now() - 60_000);
    expect((await sessions()).find((s) => s.name === "quiet")?.lastOutputAt).toBeUndefined();
  }, LONG);

  it("read 는 화면 모드를 싣는다 — alternate 화면·커서키 앱 모드·bracketed paste", async () => {
    await ok("term", "new", "plain", "--", "/bin/sh", "-c", "echo plain; sleep 600");
    await ok("term", "new", "app", "--", "/bin/sh", "-c", "printf '\\033[?1049h\\033[?1h\\033[?2004h'; echo app; sleep 600");
    await ok("term", "wait", "app", "--match", "app", "--timeout", "10");
    await ok("term", "wait", "plain", "--match", "plain", "--timeout", "10");
    const app = await termRequest(termPaths(rig.home), { op: "read", name: "app", scrollback: false }, { start: false });
    expect(app).toMatchObject({ daemon: true, data: { modes: { altScreen: true, appCursor: true, bracketedPaste: true } } });
    const plain = await termRequest(termPaths(rig.home), { op: "read", name: "plain", scrollback: false }, { start: false });
    expect(plain).toMatchObject({ daemon: true, data: { modes: { altScreen: false, appCursor: false, bracketedPaste: false } } });
  }, LONG);

  it("label — 보이는 이름만(데몬 이름은 그대로) · ls 에 · 매니페스트에 남아 restore 가 되살린다", async () => {
    await ok("term", "new", "work", "--", "/bin/sh", "-c", "sleep 600");
    const result = await termRequest(termPaths(rig.home), { op: "label", name: "work", label: "백엔드 서버" }, { start: false });
    expect(result).toMatchObject({ daemon: true, data: { name: "work", label: "백엔드 서버" } });
    expect((await sessions()).find((s) => s.name === "work")?.label).toBe("백엔드 서버");
    await until(async () => (await readFile(termPaths(rig.home).manifest, "utf8")).includes("백엔드 서버"), "manifest has the label");

    // 데몬이 갑자기 죽으면(신호) 세션은 매니페스트에 남는다 → restore 가 label 까지 되살린다.
    for (const pid of daemonPids()) process.kill(pid, "SIGKILL");
    await until(() => daemonPids().length === 0, "daemon gone");
    await ok("term", "restore");
    expect((await sessions()).find((s) => s.name === "work")?.label).toBe("백엔드 서버");

    await expect(termRequest(termPaths(rig.home), { op: "label", name: "nope", label: "x" }, { start: false }))
      .rejects.toMatchObject({ code: "TERM_NO_SESSION" });
  }, LONG);

  it("new 의 project(KAN-1238) — 실제 ls 에 · label 을 바꿔도 · 데몬이 죽은 뒤 restore 에도 그대로 · UUID 아니면 거절", async () => {
    const project = "0b9a8c7d-1111-4222-8333-444455556666";
    const env = Object.fromEntries(Object.entries(rig.env).filter((e): e is [string, string] => typeof e[1] === "string"));
    await ok("term", "new", "plain", "--", "/bin/sh", "-c", "sleep 600");
    const created = await termRequest(termPaths(rig.home),
      { op: "new", name: "tagged", cwd: rig.home, command: ["/bin/sh", "-c", "sleep 600"], env, project }, { start: false });
    expect(created).toMatchObject({ daemon: true, data: { name: "tagged", project } });
    expect((await sessions()).find((s) => s.name === "tagged")?.project).toBe(project);
    expect((await sessions()).find((s) => s.name === "plain")).not.toHaveProperty("project");

    await termRequest(termPaths(rig.home), { op: "label", name: "tagged", label: "백엔드" }, { start: false });
    expect((await sessions()).find((s) => s.name === "tagged")).toMatchObject({ label: "백엔드", project });
    await until(async () => (await readFile(termPaths(rig.home).manifest, "utf8")).includes("백엔드"), "manifest has the label");

    for (const pid of daemonPids()) process.kill(pid, "SIGKILL");
    await until(() => daemonPids().length === 0, "daemon gone");
    await ok("term", "restore");
    expect((await sessions()).find((s) => s.name === "tagged")).toMatchObject({ label: "백엔드", project });
    expect((await sessions()).find((s) => s.name === "plain")).not.toHaveProperty("project");

    // 모양이 틀린 줄 — 데몬은 기존 규칙대로 그 연결을 끊고 bad_message(TERM_BAD_REQUEST) 한 줄을 남긴다. 세션은 생기지 않는다.
    await expect(termRequest(termPaths(rig.home),
      { op: "new", name: "bad", cwd: rig.home, command: ["/bin/sh", "-c", "sleep 600"], env, project: project.toUpperCase() }, { start: false }))
      .rejects.toThrow();
    await until(async () => (await readFile(termPaths(rig.home).log, "utf8")).split("\n")
      .some((line) => line.includes('"bad_message"') && line.includes("TERM_BAD_REQUEST") && line.includes("project")), "bad_message logged");
    expect((await sessions()).map((s) => s.name).sort()).toEqual(["plain", "tagged"]);
  }, LONG);

  it("watch-sessions — 세션이 생기고·끝나고·label 이 바뀌면 «sessions» 이벤트", async () => {
    await ok("term", "new", "base", "--", "/bin/sh", "-c", "sleep 600");
    const client = await rawClient();
    const events: TermEvent[] = [];
    client.onEvent((event) => events.push(event));
    try {
      await client.request({ op: "watch-sessions" });
      const count = () => events.filter((event) => event.event === "sessions").length;
      await ok("term", "new", "extra", "--", "/bin/sh", "-c", "sleep 600");
      await until(() => count() >= 1, "event on new");
      await termRequest(termPaths(rig.home), { op: "label", name: "extra", label: "더" }, { start: false });
      await until(() => count() >= 2, "event on label");
      await ok("term", "kill", "extra");
      await until(() => count() >= 3, "event on kill");
    } finally {
      client.close();
    }
  }, LONG);

  it("인스턴스 id(§14-6 4) — read·ls·new 가 같은 세션 객체의 값을 싣는다 · 같은 이름으로 다시 만들면 새 값 · 옛 값으로 겨눈 send·key·set-size·label·kill 은 SESSION_REPLACED(적용 안 함) · 값 없이 부르면 이름만", async () => {
    const paths = termPaths(rig.home);
    await ok("term", "new", "work", "--", "cat");
    const first = await termRequest(paths, { op: "read", name: "work", scrollback: false }, { start: false });
    const old = (first as { data: { instance: string } }).data.instance;
    expect(typeof old).toBe("string");
    expect((await sessions()).find((s) => s.name === "work")).toMatchObject({ instance: old });
    await ok("term", "kill", "work");
    await ok("term", "new", "work", "--", "cat");
    const now = (await sessions()).find((s) => s.name === "work") as { instance?: string } | undefined;
    expect(now?.instance).toBeDefined();
    expect(now?.instance).not.toBe(old);
    for (const body of [
      { op: "send", name: "work", text: "stale\r", paste: false, instance: old },
      { op: "key", name: "work", key: "enter", instance: old },
      { op: "set-size", name: "work", cols: 99, rows: 33, instance: old },
      { op: "label", name: "work", label: "stale", instance: old },
      { op: "kill", name: "work", instance: old },
    ] as const) {
      await expect(termRequest(paths, body, { start: false })).rejects.toMatchObject({ code: "SESSION_REPLACED" });
    }
    const after = (await sessions()).find((s) => s.name === "work");
    expect(after).toMatchObject({ instance: now?.instance, cols: expect.any(Number) });
    expect(after?.cols).not.toBe(99);
    expect(after?.label).toBeUndefined();
    expect((await termRequest(paths, { op: "read", name: "work", scrollback: false }, { start: false }) as { data: { lines: string[] } }).data.lines
      .join("\n")).not.toContain("stale");
    expect(await termRequest(paths, { op: "send", name: "work", text: "fresh", paste: false, instance: now!.instance! }, { start: false }))
      .toMatchObject({ daemon: true, data: { instance: now?.instance } });
    expect(await termRequest(paths, { op: "key", name: "work", key: "enter" }, { start: false })).toMatchObject({ daemon: true });
  }, LONG);
});

