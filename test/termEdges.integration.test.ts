import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openTermClient, type TermClient } from "../src/core/term/client";
import { termPaths } from "../src/core/term/paths";
import { attachInPty, cli, daemonPids, LONG, ok, rig, screen, sessions, sleep, until, useTermRig } from "./termRig";

/**
 * 리뷰 #81 T1–T7 — 순서·경계 조건을 실물로 고정한다(진짜 CLI·데몬·PTY).
 * 순서를 고정해야 하는 경우는 한 연결에 요청 둘을 이어 보낸다 — 데몬은 첫 요청이 await 에서 양보하는 사이 둘째를 받는다.
 */
useTermRig();

/** 세션 명령에 붙이는 표지 — `ps` 로 PTY 프로세스를 센다. `; :` 는 셸이 마지막 명령으로 exec 해 표지가 사라지지 않게. */
function marked(tag: string): string[] {
  return ["/bin/sh", "-c", `sleep 3000; : ${tag}-${rig.marker}`];
}

function processesWith(tag: string): number {
  return execFileSync("ps", ["-axo", "command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(`${tag}-${rig.marker}`)).length;
}

async function rawClient(): Promise<TermClient> {
  const client = await openTermClient(termPaths(rig.home), { start: false });
  if (!client) {
    throw new Error("no daemon");
  }
  return client;
}

function env(): Record<string, string> {
  return Object.fromEntries(Object.entries(rig.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/**
 * 앱이 커서 위치(CSI 6 n)를 묻고, 1.5초 동안 받은 응답(CSI r;c R) 수를 `ANSWERS-<회차>=<수>` 로 찍는 작은 실제 프로그램.
 * 표준입력에 `go<회차>` 가 오면 묻는다.
 */
const CPR_PROBE = [
  "process.stdin.setRawMode(true);",
  "let seen = '';",
  "process.stdin.on('data', (chunk) => {",
  "  seen += chunk.toString('latin1');",
  "  const round = /go(\\d)/.exec(seen);",
  "  if (!round) return;",
  "  seen = '';",
  "  process.stdout.write('\\x1b[6n');",
  "  setTimeout(() => {",
  "    const answers = (seen.match(/\\x1b\\[\\d+;\\d+R/g) || []).length;",
  "    seen = '';",
  "    process.stdout.write('\\r\\nANSWERS-' + round[1] + '=' + answers + '\\r\\n');",
  "  }, 1500);",
  "});",
].join("\n");

async function answersFor(name: string, round: number): Promise<number> {
  await ok("term", "send", name, `go${round}`);
  await ok("term", "wait", name, "--match", `^ANSWERS-${round}=`, "--timeout", "10");
  const line = (await screen(name)).find((text) => text.startsWith(`ANSWERS-${round}=`)) ?? "";
  return Number(line.split("=")[1]);
}

describe("ainecto term — review #81 edge cases", () => {
  it("T1: two new requests for the same name start one PTY; the second is refused", async () => {
    await ok("term", "new", "base", "--", "/bin/sh");
    const client = await rawClient();
    const request = { op: "new" as const, name: "dup", cwd: rig.home, command: marked("dup"), env: env() };
    const results = await Promise.allSettled([client.request(request), client.request(request)]);
    client.close();
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((result) => result.status === "rejected");
    expect(refused?.status === "rejected" ? (refused.reason as { code: string }).code : "").toBe("TERM_SESSION_EXISTS");
    expect((await sessions()).filter((session) => session.name === "dup")).toHaveLength(1);
    await until(() => processesWith("dup") === 1, "one dup PTY");
    await sleep(300);
    expect(processesWith("dup")).toBe(1);
  }, LONG);

  it("T2: a query from the app is answered exactly once — detached, one attach, two attaches", async () => {
    await ok("term", "new", "cpr", "--", process.execPath, "-e", CPR_PROBE);
    await sleep(500);
    expect(await answersFor("cpr", 1)).toBe(1);

    const first = attachInPty("cpr", 80, 24);
    await until(() => first.text().includes("ANSWERS-1"), "first attach drew the screen");
    expect(await answersFor("cpr", 2)).toBe(1);

    const second = attachInPty("cpr", 80, 24);
    await until(() => second.text().includes("ANSWERS-2"), "second attach drew the screen");
    expect(await answersFor("cpr", 3)).toBe(1);
    first.pty.kill();
    second.pty.kill();
  }, LONG);

  it("T3: a character split across two attach input chunks reaches the PTY whole", async () => {
    await ok("term", "new", "utf8", "--", "/bin/sh", "-c", "stty raw -echo; od -An -tx1 -N 3; sleep 1000");
    const outer = attachInPty("utf8", 80, 24);
    await until(async () => (await sessions())[0]?.clients === 1, "attached");
    // attach 는 응답을 받은 «뒤» 터미널을 raw 로 바꾼다 — 그 전에 친 글자는 줄 단위로 묶인다.
    await sleep(500);
    const bytes = Buffer.from("한", "utf8");
    outer.pty.write(bytes.subarray(0, 1));
    await sleep(300);
    outer.pty.write(bytes.subarray(1));
    // od 의 칸 띄움은 BSD(맥)·GNU 가 다르다 — 공백 수는 보지 않는다.
    await ok("term", "wait", "utf8", "--match", "[0-9a-f]{2} +[0-9a-f]{2} +[0-9a-f]{2}", "--timeout", "10");
    expect((await screen("utf8")).join(" ").trim().split(/\s+/)).toEqual(["ed", "95", "9c"]);
    outer.pty.kill();
  }, LONG);

  it("T4: if the daemon it just started stops before it is ready, new still ends in finite time", async () => {
    const startedAt = Date.now();
    const pending = cli("term", "new", "t4", "--", "/bin/sh");
    let stopped = 0;
    await until(() => {
      const [pid] = daemonPids();
      if (pid !== undefined) {
        process.kill(pid, "SIGSTOP");
        stopped = pid;
      }
      return stopped !== 0;
    }, "the daemon child appears");
    // 잠금을 잡기 전에 멈췄다 — 아직 daemon.json 이 없다.
    expect(existsSync(join(rig.home, ".ainecto/term/daemon.json"))).toBe(false);
    try {
      const run = await pending;
      expect([run.code, run.stderr]).toEqual([0, ""]);
      expect(Date.now() - startedAt).toBeLessThan(30_000);
      expect((await sessions()).map((session) => session.name)).toEqual(["t4"]);
    } finally {
      process.kill(stopped, "SIGCONT");
    }
    await until(() => !daemonPids().includes(stopped), "the stopped child leaves on the lock after SIGCONT");
  }, LONG);

  it("T5: when the daemon dies under an attach, the user's terminal modes are restored", async () => {
    await ok("term", "new", "modes", "--", "/bin/sh", "-c", "printf '\\033[?1049h\\033[?1000h\\033[?2004h\\033[?25lMODES-ON'; sleep 1000");
    await ok("term", "wait", "modes", "--match", "MODES-ON", "--timeout", "10");
    const outer = attachInPty("modes", 80, 24);
    await until(() => outer.bufferType() === "alternate" && outer.modes().mouseTrackingMode !== "none", "modes on in the attached terminal");
    const before = outer.raw().length;
    for (const pid of daemonPids()) {
      process.kill(pid, "SIGKILL");
    }
    expect(await outer.exit).toBe(1);
    await until(() => outer.bufferType() === "normal", "back on the normal screen");
    expect(outer.modes().mouseTrackingMode).toBe("none");
    expect(outer.modes().bracketedPasteMode).toBe(false);
    expect(outer.raw().slice(before)).toContain("\x1b[?25h");
  }, LONG);

  it("T7: kill-server that arrives while a new is starting kills that session too and leaves an empty manifest", async () => {
    await ok("term", "new", "base", "--", "/bin/sh");
    const client = await rawClient();
    const [created, stopped] = await Promise.all([
      client.request({ op: "new", name: "late", cwd: rig.home, command: marked("late"), env: env() }),
      client.request({ op: "kill-server" }),
    ]);
    client.close();
    expect(created).toMatchObject({ name: "late" });
    expect((stopped as { killed: string[] }).killed.sort()).toEqual(["base", "late"]);
    await until(() => daemonPids().length === 0, "daemon gone");
    await until(() => processesWith("late") === 0, "late PTY gone");
    const manifest = JSON.parse(await readFile(join(rig.home, ".ainecto/term/sessions.json"), "utf8")) as { sessions: unknown[] };
    expect(manifest.sessions).toEqual([]);
  }, LONG);
});
