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
});
