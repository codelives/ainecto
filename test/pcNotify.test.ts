import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPcNotifier,
  notificationText,
  notifyFailureReason,
  NOTIFY_BATCH_MS,
  NotifyBatcher,
  type NotifyClock,
  type NotifyEvent,
} from "../src/core/pc/pcNotify";
import { notificationHint, notifyTool } from "../src/core/os/launch";
import { DaemonLog } from "../src/core/term/daemonLog";
import type { RemoteLogRecord } from "../src/core/term/remote";

/** 손으로 돌리는 시계 — 타이머는 advance 때 정해진 순서로 돈다. */
function manualClock(): NotifyClock & { advance(ms: number): void } {
  let now = 1_000_000;
  let timers: Array<{ at: number; run: () => void; id: number }> = [];
  let next = 1;
  return {
    now: () => now,
    setTimer: (run, ms) => {
      const id = next++;
      timers.push({ at: now + ms, run, id });
      return id;
    },
    clearTimer: (id) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
    advance(ms) {
      now += ms;
      const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at);
      timers = timers.filter((timer) => timer.at > now);
      for (const timer of due) timer.run();
    },
  };
}

const event = (kind: NotifyEvent["kind"], keyId = "k1", at = new Date(2026, 10, 21, 9, 5)): NotifyEvent =>
  ({ kind, keyId, browserName: "Chrome · macOS", at });

describe("PC 알림(설계 §4-6 · §11-7 · C-E3)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "anotify-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("묶음 간격은 결재한 60초(C-E3)", () => {
    expect(NOTIFY_BATCH_MS).toBe(60_000);
  });

  it("문구 — 브라우저 이름·무엇·시각·«ainecto remote off» · 묶인 수는 «+n more» · 키 id 는 싣지 않는다", () => {
    expect(notificationText(event("session"), 0)).toEqual({
      title: "AiNecto",
      body: "Chrome · macOS opened a terminal connection to this PC — 09:05. Not you? Run `ainecto remote off`.",
    });
    expect(notificationText(event("command"), 2).body).toBe(
      "Chrome · macOS started a command in a new terminal on this PC — 09:05 (+2 more). Not you? Run `ainecto remote off`.");
    expect(notificationText(event("paired"), 0).body).toContain("was paired with this PC");
    expect(notificationText(event("shell"), 0).body).not.toContain("k1");
  });

  it("도구 — macOS 는 고정 스크립트(on run argv)에 제목·본문을 인자로만 · Linux 는 notify-send -- 인자 · 그 밖은 없음 · 안내 한 줄은 macOS 만", () => {
    const quote = 'x" & do shell script "touch /tmp/pwned" & "';
    expect(notifyTool("darwin")?.args("AiNecto", quote)).toEqual(["-e", "on run argv", "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "AiNecto", quote]);
    expect(notifyTool("linux")?.args("AiNecto", "-x body")).toEqual(["--", "AiNecto", "-x body"]);
    expect(notifyTool("linux")?.file).toBe("notify-send");
    expect(notifyTool("win32")).toBeUndefined();
    expect(notificationHint("darwin")).toContain("Script Editor");
    expect(notificationHint("linux")).toBeUndefined();
    expect(notificationHint("win32")).toBeUndefined();
  });

  it("묶음 — 첫 사건은 바로 · 60초 안의 같은 키·같은 종류는 모았다가 창이 끝날 때 마지막 것에 +n · 다른 키·다른 종류는 따로 · flush 는 모은 것을 바로", () => {
    const clock = manualClock();
    const shown: Array<{ kind: string; keyId: string; more: number }> = [];
    const batcher = new NotifyBatcher((e, more) => shown.push({ kind: e.kind, keyId: e.keyId, more }), clock);
    batcher.add(event("session"));
    expect(shown).toEqual([{ kind: "session", keyId: "k1", more: 0 }]);
    clock.advance(1_000);
    batcher.add(event("session"));
    batcher.add(event("session"));
    batcher.add(event("shell"));
    batcher.add(event("session", "k2"));
    expect(shown).toHaveLength(3);
    clock.advance(NOTIFY_BATCH_MS - 1_001);
    expect(shown).toHaveLength(3);
    clock.advance(1);
    expect(shown.at(-1)).toEqual({ kind: "session", keyId: "k1", more: 1 });
    // 창이 끝나 내보낸 뒤 새 창 — 그 안의 것은 다시 모은다.
    batcher.add(event("session"));
    expect(shown).toHaveLength(4);
    batcher.flush();
    expect(shown.at(-1)).toEqual({ kind: "session", keyId: "k1", more: 0 });
    // 조용히 60초가 지나면 다음 것은 바로.
    clock.advance(NOTIFY_BATCH_MS);
    batcher.add(event("session"));
    expect(shown.at(-1)).toEqual({ kind: "session", keyId: "k1", more: 0 });
    expect(shown).toHaveLength(6);
  });

  it("도구 없음·실패 → 이유 코드 한 줄(stderr 원문 없음) · 던지지 않는다 · 그 밖 OS 는 로그만", async () => {
    const path = join(dir, "remote.log");
    const log = new DaemonLog<RemoteLogRecord>(path, `${path}.1`);
    const missing = Object.assign(new Error("spawn osascript ENOENT — secret stderr"), { code: "ENOENT" });
    await createPcNotifier({ log, platform: "darwin", run: async () => { throw missing; } }).notify({ kind: "session", keyId: "k1", browserName: "B" });
    await createPcNotifier({ log, platform: "linux", run: async () => { throw Object.assign(new Error("x"), { code: 1 }); } })
      .notify({ kind: "shell", keyId: "k1", browserName: "B" });
    await createPcNotifier({ log, platform: "win32" }).notify({ kind: "command", keyId: "k1", browserName: "B" });
    const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map(({ ts: _ts, ...rest }) => rest)).toEqual([
      { event: "pc_notify", kind: "session", browserKeyId: "k1", more: 0, tool: "osascript" },
      { event: "pc_notify_result", kind: "session", ok: false, tool: "osascript", reason: "not-found" },
      { event: "pc_notify", kind: "shell", browserKeyId: "k1", more: 0, tool: "notify-send" },
      { event: "pc_notify_result", kind: "shell", ok: false, tool: "notify-send", reason: "exit-1" },
      { event: "pc_notify", kind: "command", browserKeyId: "k1", more: 0, tool: "none" },
      { event: "pc_notify_result", kind: "command", ok: false, tool: "none", reason: "no-tool-on-this-os" },
    ]);
    expect(JSON.stringify(records)).not.toContain("secret stderr");
  });

  it("실제 execFile 의 실패도 같은 이유 코드 — 없는 도구는 not-found", async () => {
    const error = await new Promise<unknown>((resolve) => execFile("ainecto-no-such-notify-tool", [], (caught) => resolve(caught)));
    expect(notifyFailureReason(error)).toBe("not-found");
    const exit = await new Promise<unknown>((resolve) => execFile(process.execPath, ["-e", "process.exit(3)"], (caught) => resolve(caught)));
    expect(notifyFailureReason(exit)).toBe("exit-3");
  });
});
