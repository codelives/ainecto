import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import headless from "@xterm/headless";
import type { TermEvent } from "../src/core/term/protocol";
import { TermSession, type SessionSink } from "../src/core/term/session";

/** 세션 하나를 데몬 없이 직접 — 진짜 PTY + 헤드리스 화면 + 직렬화(설계 2-2·2-3). */
async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/** 세션은 명령을 친 셸의 환경을 받는다 — 시험도 같게(LANG 이 없으면 셸이 한글 입력을 메타 키로 읽는다). */
const ENV = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

class RecordingSink implements SessionSink {
  readonly events: TermEvent[] = [];
  send(event: TermEvent): void {
    this.events.push(event);
  }
}

describe("TermSession (real PTY)", () => {
  it("runs the command with the session name in the environment, reads the screen, and ends with the exit code", async () => {
    const exits: number[] = [];
    const session = await TermSession.start(
      { name: "unit", cwd: await realpath(tmpdir()), command: ["/bin/sh"], env: ENV, createdAt: new Date().toISOString() },
      (_ended, exitCode) => exits.push(exitCode),
    );
    await session.send('echo "세션=$AINECTO_TERM_SESSION"', false);
    await session.key("enter");
    await until(async () => (await session.read({ scrollback: false })).includes("세션=unit"), "echo output");

    await session.send("exit 7", false);
    await session.key("enter");
    await until(() => exits.length === 1, "session exit");
    expect(exits).toEqual([7]);
  }, 30_000);

  it("an attach gets the serialized screen first, then only newer output", async () => {
    const session = await TermSession.start(
      { name: "attach", cwd: await realpath(tmpdir()), command: ["/bin/sh"], env: ENV, createdAt: new Date().toISOString() },
      () => undefined,
    );
    await session.send("printf '\\033[1;32mGREEN-BEFORE\\033[0m\\n'", false);
    await session.key("enter");
    await until(async () => (await session.read({ scrollback: false })).includes("GREEN-BEFORE"), "first output");

    const sink = new RecordingSink();
    session.attach(sink, 80, 24);
    await session.send("echo AFTER-ATTACH", false);
    await session.key("enter");
    await until(async () => (await session.read({ scrollback: false })).includes("AFTER-ATTACH"), "second output");

    expect(sink.events[0]?.event).toBe("screen");
    const view = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    for (const event of sink.events) {
      if (event.event === "screen" || event.event === "out") {
        await new Promise<void>((done) => view.write(Buffer.from(event.d, "base64").toString("utf8"), done));
      }
    }
    const lines: string[] = [];
    for (let index = 0; index < view.buffer.active.length; index += 1) {
      lines.push(view.buffer.active.getLine(index)?.translateToString(true) ?? "");
    }
    expect(lines.filter((line) => line === "GREEN-BEFORE")).toHaveLength(1);
    expect(lines).toContain("AFTER-ATTACH");
    const green = view.buffer.active.getLine(lines.indexOf("GREEN-BEFORE"))?.getCell(0);
    expect(green?.isBold()).toBeTruthy();
    expect(green?.getFgColor()).toBe(2);
    session.kill();
  }, 30_000);
});
