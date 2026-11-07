import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { openTermClient, type TermClient } from "../src/core/term/client";
import { TERM_STRING_HOLD_MAX_CHARS } from "../src/core/term/limits";
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

/**
 * 시퀀스를 반으로 끊어 내보내는 작은 실제 프로그램(리뷰 #82 Q1·Q2). 표준입력 명령:
 *   half<n> → `ESC [` 만 · cpr<n> → `6n` 을 마저 내고 1.5초 동안 받은 커서 위치 답 수를 `CPR-<n>=<수>` 로
 *   red<n> → `31mRED-<n>` 을 마저 · osc<n> → 팔레트 1번 설정 + 2번 질의를 한 OSC 로 내고 답 수를 `OSC-<n>=<수>` 로.
 */
const SPLIT_PROBE = [
  "process.stdin.setRawMode(true);",
  "let input = ''; let counting = null;",
  "process.stdin.on('data', (chunk) => {",
  "  const text = chunk.toString('latin1');",
  "  if (counting) counting.seen += text;",
  "  input += text;",
  "  let m;",
  "  while ((m = /(half|cpr|red|osc)(\\d)/.exec(input))) {",
  "    input = input.slice(m.index + m[0].length);",
  "    const cmd = m[1], n = m[2];",
  "    if (cmd === 'half') process.stdout.write('\\x1b[');",
  "    if (cmd === 'red') process.stdout.write('31mRED-' + n + '\\x1b[0m\\r\\n');",
  "    if (cmd === 'cpr' || cmd === 'osc') {",
  "      counting = { seen: '' };",
  "      process.stdout.write(cmd === 'cpr' ? '6n' : '\\x1b]4;1;rgb:ff/00/00;2;?\\x07');",
  "      const answer = cmd === 'cpr' ? /\\x1b\\[\\d+;\\d+R/g : /\\x1b\\]4;2;[^\\x07]*\\x07/g;",
  "      setTimeout(() => {",
  "        const count = (counting.seen.match(answer) || []).length;",
  "        counting = null;",
  "        process.stdout.write('\\r\\n' + cmd.toUpperCase() + '-' + n + '=' + count + '\\r\\n');",
  "      }, 1500);",
  "    }",
  "  }",
  "});",
].join("\n");

/**
 * modifyOtherKeys 를 켜고(CSI > 4 ; 2 m) 커서 위치를 묻고(CSI 6 n) 다시 끄는(CSI > 4 n) 실제 프로그램(리뷰 #84 Q1).
 * 표준입력 `keys<n>` → 셋을 내고 1.5초 동안 받은 커서 위치 답 수를 `KEYS-<n>=<수>` 로.
 */
const MODKEYS_PROBE = [
  "process.stdin.setRawMode(true);",
  "let input = ''; let counting = null;",
  "process.stdin.on('data', (chunk) => {",
  "  const text = chunk.toString('latin1');",
  "  if (counting) counting.seen += text;",
  "  input += text;",
  "  let m;",
  "  while ((m = /keys(\\d)/.exec(input))) {",
  "    input = input.slice(m.index + m[0].length);",
  "    const n = m[1];",
  "    counting = { seen: '' };",
  "    process.stdout.write('\\x1b[>4;2m\\x1b[6n\\x1b[>4n');",
  "    setTimeout(() => {",
  "      const count = (counting.seen.match(/\\x1b\\[\\d+;\\d+R/g) || []).length;",
  "      counting = null;",
  "      process.stdout.write('\\r\\nKEYS-' + n + '=' + count + '\\r\\n');",
  "    }, 1500);",
  "  }",
  "});",
].join("\n");

async function probeCount(name: string, label: string, round: number): Promise<number> {
  await ok("term", "wait", name, "--match", `^${label}-${round}=`, "--timeout", "10");
  const line = (await screen(name)).find((text) => text.startsWith(`${label}-${round}=`)) ?? "";
  return Number(line.split("=")[1]);
}

/** 보이는 화면 줄(뒤 빈 줄 걷음) — read 결과와 대조한다. */
function visible(text: string, rows: number): string[] {
  const lines = text.split("\n").slice(-rows).map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

describe("ainecto term — review #82 follow-ups", () => {
  it("Q1: an attach that lands inside a split sequence still gets the whole sequence — one CPR answer, no tail text", async () => {
    await ok("term", "new", "split", "--", process.execPath, "-e", SPLIT_PROBE);
    await sleep(500);
    const a = attachInPty("split", 80, 24);
    await until(async () => (await sessions())[0]?.clients === 1, "A attached");

    await ok("term", "send", "split", "half1");
    await sleep(300);
    const b = attachInPty("split", 80, 24);
    await until(async () => (await sessions())[0]?.clients === 2, "B attached");
    await sleep(300);
    await ok("term", "send", "split", "cpr1");
    expect(await probeCount("split", "CPR", 1)).toBe(1);

    await ok("term", "send", "split", "half2");
    await sleep(300);
    const c = attachInPty("split", 80, 24);
    await until(async () => (await sessions())[0]?.clients === 3, "C attached");
    await sleep(300);
    await ok("term", "send", "split", "red2");
    await ok("term", "wait", "split", "--match", "^RED-2$", "--timeout", "10");
    await sleep(300);

    const read = await screen("split");
    for (const view of [a, b, c]) {
      expect(view.text()).not.toContain("6n");
      expect(view.text()).not.toContain("31m");
      expect(visible(view.text(), 24)).toEqual(read);
    }
    for (const view of [a, b, c]) {
      view.pty.kill();
    }
  }, LONG);

  it("Q2: an OSC that sets one colour and asks another keeps the setting on every screen and is answered once", async () => {
    await ok("term", "new", "palette", "--", process.execPath, "-e", SPLIT_PROBE);
    await sleep(500);
    const a = attachInPty("palette", 80, 24);
    await until(async () => (await sessions())[0]?.clients === 1, "A attached");
    const b = attachInPty("palette", 80, 24);
    await until(async () => (await sessions())[0]?.clients === 2, "B attached");
    await sleep(300);
    await ok("term", "send", "palette", "osc3");
    expect(await probeCount("palette", "OSC", 3)).toBe(1);
    expect(a.palette().get(1)).toBe("rgb:ff/00/00");
    expect(b.palette().get(1)).toBe("rgb:ff/00/00");
    a.pty.kill();
    b.pty.kill();
  }, LONG);

  it("Q1 (review #84): every screen gets modifyOtherKeys on and off (CSI > 4 n); only the CPR query is kept from the non-owner", async () => {
    await ok("term", "new", "modkeys", "--", process.execPath, "-e", MODKEYS_PROBE);
    await sleep(500);
    const a = attachInPty("modkeys", 80, 24);
    await until(async () => (await sessions())[0]?.clients === 1, "A attached");
    const b = attachInPty("modkeys", 80, 24);
    await until(async () => (await sessions())[0]?.clients === 2, "B attached");
    await sleep(300);
    await ok("term", "send", "modkeys", "keys1");
    expect(await probeCount("modkeys", "KEYS", 1)).toBe(1);
    for (const view of [a, b]) {
      expect(view.raw()).toContain("\x1b[>4;2m");
      expect(view.raw()).toContain("\x1b[>4n");
    }
    // 주인(마지막에 붙은 B)만 질의를 받는다.
    expect(b.raw()).toContain("\x1b[6n");
    expect(a.raw()).not.toContain("\x1b[6n");
    a.pty.kill();
    b.pty.kill();
  }, LONG);

  it("S1: a daemon that held the lock past its starter's wait and then resumes stops on its own and frees the lock", async () => {
    // 매니페스트 자리를 FIFO 로 — 데몬은 잠금·daemon.json 뒤, bind 전의 매니페스트 읽기에서 실제로 멈춘다(시험 훅 없음).
    const dir = join(rig.home, ".ainecto/term");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    execFileSync("mkfifo", [join(dir, "sessions.json")]);

    const failed = await cli("term", "new", "s1", "--json", "--", "/bin/sh");
    expect(failed.code).toBe(1);
    expect((JSON.parse(failed.stderr) as { error: { code: string } }).error.code).toBe("TERM_DAEMON_START");
    const [stuck] = daemonPids();
    expect(stuck).toBeDefined();
    expect(failed.stderr).toContain(`pid ${stuck}`);

    // 다시 움직이게 한다 — 기다리던 부모는 이미 떠났다.
    writeFileSync(join(dir, "sessions.json"), '{"sessions":[]}\n');
    await until(() => daemonPids().length === 0, "the resumed daemon stops on its own");
    expect(existsSync(join(dir, "ctl.sock"))).toBe(false);
    const log = await readFile(join(dir, "daemon.log"), "utf8");
    expect(log).toContain('"event":"ready_unread"');
    expect(log).toContain('"reason":"no sessions"');

    // 멈춤 장치(FIFO)를 걷고 — 잠금이 풀렸으니 새 데몬이 뜬다.
    await rm(join(dir, "sessions.json"));
    await ok("term", "new", "s2", "--", "/bin/sh");
    expect(daemonPids()).toHaveLength(1);
  }, LONG);
});

/**
 * 시퀀스를 앞·뒤로 나눠 내는 실제 프로그램(리뷰 #83 B1). 표준입력 `go<n>` → 사례 n 의 앞부분, `next<n>` → 뒷부분을 내고
 * 1.5초 동안 받은 답(사례의 answer 정규식) 수를 `DONE-<n>=<수>` 로(답을 세지 않는 사례는 -1).
 */
interface SplitCase {
  name: string;
  before: string;
  after: string;
  /** 화면에 있어야 할 글자. */
  shows: string;
  /** 화면에 있으면 안 되는 꼬리 글자. */
  notShown: string[];
  /** 질의 사례 — 받은 답을 세는 정규식. */
  answer?: string;
}

const SPLIT_CASES: SplitCase[] = [
  { name: "charset select ESC ( 0", before: "\x1b(", after: "0qqq\x1b(B LINE\r\n", shows: "─── LINE", notShown: ["0qqq"] },
  { name: "SGR with a BEL inside", before: "\x1b[31\x07", after: "mRED\x1b[0m\r\n", shows: "RED", notShown: ["mRED"] },
  { name: "CPR with a BEL inside", before: "\x1b[\x07", after: "6n", shows: "", notShown: ["6n"], answer: "\\x1b\\[\\d+;\\d+R" },
  { name: "OSC 8 link", before: "\x1b]8;;https://ainecto.com", after: "\x1b\\LINK\x1b]8;;\x1b\\\r\n", shows: "LINK", notShown: ["ainecto.com"] },
  { name: "DCS query DECRQSS", before: "\x1bP$q", after: "m\x1b\\", shows: "", notShown: ["$q", "m"], answer: "\\x1bP[01]\\$r[^\\x1b]*\\x1b\\\\" },
  { name: "CPR split after ESC [", before: "\x1b[", after: "6n", shows: "", notShown: ["6n"], answer: "\\x1b\\[\\d+;\\d+R" },
];

const CASE_PROBE = [
  `const CASES = ${JSON.stringify(SPLIT_CASES.map(({ before, after, answer }) => ({ before, after, answer })))};`,
  "process.stdin.setRawMode(true);",
  "let input = ''; let counting = null;",
  "process.stdin.on('data', (chunk) => {",
  "  const text = chunk.toString('latin1');",
  "  if (counting) counting.seen += text;",
  "  input += text;",
  "  let m;",
  "  while ((m = /(go|next)(\\d)/.exec(input))) {",
  "    input = input.slice(m.index + m[0].length);",
  "    const k = Number(m[2]); const c = CASES[k];",
  "    if (m[1] === 'go') { process.stdout.write(c.before); continue; }",
  "    counting = { seen: '' };",
  "    process.stdout.write(c.after);",
  "    setTimeout(() => {",
  "      const n = c.answer ? (counting.seen.match(new RegExp(c.answer, 'g')) || []).length : -1;",
  "      counting = null;",
  "      process.stdout.write('\\r\\nDONE-' + k + '=' + n + '\\r\\n');",
  "    }, 1500);",
  "  }",
  "});",
].join("\n");

describe("ainecto term — review #83 B1: a new attach between the two halves of a sequence", () => {
  SPLIT_CASES.forEach((splitCase, index) => {
    it(`${splitCase.name}: the old attach, the new attach and read agree — text and attributes, one answer`, async () => {
      const name = `b1-${index}`;
      await ok("term", "new", name, "--", process.execPath, "-e", CASE_PROBE);
      await sleep(500);
      const a = attachInPty(name, 80, 24);
      await until(async () => (await sessions())[0]?.clients === 1, "A attached");

      await ok("term", "send", name, `go${index}`);
      await sleep(300);
      const b = attachInPty(name, 80, 24);
      await until(async () => (await sessions())[0]?.clients === 2, "B attached");
      await sleep(300);
      await ok("term", "send", name, `next${index}`);
      await ok("term", "wait", name, "--match", `^DONE-${index}=`, "--timeout", "10");
      await sleep(300);

      const read = await screen(name);
      const done = read.find((line) => line.startsWith(`DONE-${index}=`)) ?? "";
      if (splitCase.answer) {
        expect(Number(done.split("=")[1])).toBe(1);
      }
      for (const view of [a, b]) {
        expect(visible(view.text(), 24)).toEqual(read);
        for (const tail of splitCase.notShown) {
          expect(view.text()).not.toContain(tail);
        }
        if (splitCase.shows) {
          expect(view.text()).toContain(splitCase.shows);
        }
      }
      expect(b.cells()).toEqual(a.cells());
      a.pty.kill();
      b.pty.kill();
    }, LONG);
  });
});

/** 상한을 넘는 OSC 52(클립보드 설정)를 끝 없이 낸 뒤(`head<n>`), 나중에 꼬리·끝·표지 줄을 내는(`tail<n>`) 실제 프로그램(리뷰 #84 M1). */
const OVER_LIMIT = TERM_STRING_HOLD_MAX_CHARS + 1000;
const BIG_PROBE = [
  "process.stdin.setRawMode(true);",
  "let input = '';",
  "process.stdin.on('data', (chunk) => {",
  "  input += chunk.toString('latin1');",
  "  let m;",
  "  while ((m = /(head|tail)(\\d)/.exec(input))) {",
  "    input = input.slice(m.index + m[0].length);",
  `    if (m[1] === 'head') process.stdout.write('\\x1b]52;c;' + 'A'.repeat(${OVER_LIMIT}));`,
  "    else process.stdout.write('TAILMARK\\x07\\r\\nAFTER-' + m[2] + '\\r\\n');",
  "  }",
  "});",
].join("\n");

describe("ainecto term — review #84 M1: a string longer than the hold limit", () => {
  it("reaches the attached screen before it ends; an attach that joins after its head does not print its tail", async () => {
    await ok("term", "new", "big", "--", process.execPath, "-e", BIG_PROBE);
    await sleep(500);
    const a = attachInPty("big", 80, 24);
    await until(async () => (await sessions())[0]?.clients === 1, "A attached");
    await sleep(300);

    await ok("term", "send", "big", "head1");
    const head = "\x1b]52;c;" + "A".repeat(OVER_LIMIT);
    await until(() => a.raw().includes(head), "A got the unfinished string");

    const b = attachInPty("big", 80, 24);
    await until(async () => (await sessions())[0]?.clients === 2, "B attached");
    await sleep(300);
    await ok("term", "send", "big", "tail1");
    await ok("term", "wait", "big", "--match", "^AFTER-1$", "--timeout", "10");
    await sleep(300);

    const read = await screen("big");
    expect(a.raw()).toContain(head + "TAILMARK\x07");
    expect(b.raw()).not.toContain("TAILMARK");
    expect(b.raw()).not.toContain("AAAA");
    for (const view of [a, b]) {
      expect(visible(view.text(), 24)).toEqual(read);
    }
    a.pty.kill();
    b.pty.kill();
  }, LONG);
});
