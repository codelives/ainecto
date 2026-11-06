import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DAEMON_RESPONSE_TIMEOUT_MS, DAEMON_START_ATTEMPTS } from "../src/core/term/limits";
import {
  assertLogPairs,
  attachInPty,
  cli,
  daemonPids,
  exited,
  json,
  LONG,
  ok,
  rig,
  ROOT,
  screen,
  sessions,
  sleep,
  TSX,
  until,
  useTermRig,
} from "./termRig";

/** `ainecto term` 실물 시험 — 진짜 CLI 프로세스·진짜 데몬·진짜 PTY(틀은 termRig.ts). */
useTermRig();

describe("ainecto term — real daemon and PTY", () => {
  it("new · send · key · wait · read · ls · kill, and the daemon leaves with the last session", async () => {
    await ok("term", "new", "s1", "--", "/bin/sh");
    await ok("term", "send", "s1", 'printf "\\033[31m빨강\\033[0m %s\\n" "$AINECTO_TERM_SESSION"');
    await ok("term", "key", "s1", "enter");
    expect(await ok("term", "wait", "s1", "--match", "^빨강 s1$", "--timeout", "10")).toBe("빨강 s1\n");
    expect(await screen("s1")).toContain("빨강 s1");
    const [listed] = await sessions();
    expect(listed).toMatchObject({ name: "s1", command: ["/bin/sh"], cwd: rig.home, clients: 0 });
    expect(daemonPids()).toHaveLength(1);

    await ok("term", "kill", "s1");
    await until(() => daemonPids().length === 0, "daemon exits after the last session");
    expect(existsSync(join(rig.home, ".ainecto/term/ctl.sock"))).toBe(false);
    expect(await ok("term", "ls")).toBe("No term sessions.\n");
    await assertLogPairs();
  }, LONG);

  it("wait fails with a code on timeout and when the session ends; a normal exit leaves the manifest", async () => {
    await ok("term", "new", "w", "--", "/bin/sh");
    const timeout = await json("term", "wait", "w", "--match", "NEVER", "--timeout", "1");
    expect(timeout).toMatchObject({ ok: false, error: { code: "TERM_WAIT_TIMEOUT" } });

    const waiting = cli("term", "wait", "w", "--match", "NEVER", "--json");
    await sleep(500);
    await ok("term", "send", "w", "exit");
    await ok("term", "key", "w", "enter");
    const ended = await waiting;
    expect(ended.code).toBe(1);
    expect(JSON.parse(ended.stderr)).toMatchObject({ error: { code: "TERM_SESSION_ENDED" } });
    const manifest = JSON.parse(await readFile(join(rig.home, ".ainecto/term/sessions.json"), "utf8")) as { sessions: unknown[] };
    expect(manifest.sessions).toEqual([]);
  }, LONG);

  it("send --paste and cursor keys follow the modes the app turned on", async () => {
    await ok("term", "new", "modes", "--", "/bin/sh", "-c", "printf '\\033[?2004h\\033[?1h'; stty -echo; exec cat -v");
    await ok("term", "new", "plain", "--", "/bin/sh", "-c", "stty -echo; exec cat -v");
    await sleep(300);
    for (const name of ["modes", "plain"]) {
      await ok("term", "send", name, "--paste", "hi");
      await ok("term", "key", name, "up");
      await ok("term", "key", name, "enter");
    }
    await ok("term", "wait", "modes", "--match", "hi", "--timeout", "10");
    await ok("term", "wait", "plain", "--match", "hi", "--timeout", "10");
    expect(await screen("modes")).toContain("^[[200~hi^[[201~^[OA");
    expect(await screen("plain")).toContain("hi^[[A");
  }, LONG);

  it("a second daemon started by hand stops on the lock", async () => {
    await ok("term", "new", "a", "--", "/bin/sh");
    const second = await cli("term", "daemon");
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("Another term daemon is already running.");
    expect(daemonPids()).toHaveLength(1);
  }, LONG);

  it("five concurrent new commands end with one daemon and five sessions", async () => {
    const runs = await Promise.all(["c1", "c2", "c3", "c4", "c5"].map((name) => cli("term", "new", name, "--", "/bin/sh")));
    expect(runs.map((run) => [run.code, run.stderr])).toEqual(runs.map(() => [0, ""]));
    expect((await sessions()).map((session) => session.name).sort()).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(daemonPids()).toHaveLength(1);
    await assertLogPairs();
  }, LONG);

  it("#67 order: a starter stopped before the lock wakes up later and leaves — still one daemon", async () => {
    const starter = spawn(process.execPath, [...rig.nodeArgs, "term", "daemon"], { env: rig.env, cwd: rig.home, stdio: "ignore" });
    process.kill(starter.pid ?? 0, "SIGSTOP");
    // 멈춘 시점이 잠금 «전»이었는지 확인 — Node·tsx 가 뜨기 전이라 폴더도 아직 없다.
    expect(existsSync(join(rig.home, ".ainecto/term/ctl.sock"))).toBe(false);

    await ok("term", "new", "b", "--", "/bin/sh");
    const winner = daemonPids().filter((pid) => pid !== starter.pid);
    expect(winner).toHaveLength(1);

    process.kill(starter.pid ?? 0, "SIGCONT");
    expect(await exited(starter)).toBe(1);
    expect(daemonPids()).toEqual(winner);
    expect((await sessions()).map((session) => session.name)).toEqual(["b"]);
  }, LONG);

  it("while the daemon is stopped, a command gives up after 10 s with the daemon pid — and cleans nothing up", async () => {
    await ok("term", "new", "c", "--", "/bin/sh");
    const [daemon] = daemonPids();
    process.kill(daemon ?? 0, "SIGSTOP");
    try {
      const startedAt = Date.now();
      const run = await cli("term", "ls", "--json");
      const elapsed = Date.now() - startedAt;
      expect(run.code).toBe(1);
      const error = (JSON.parse(run.stderr) as { error: { code: string; message: string } }).error;
      expect(error.code).toBe("TERM_DAEMON_NO_RESPONSE");
      expect(error.message).toContain(`pid ${daemon}`);
      expect(elapsed).toBeGreaterThanOrEqual(DAEMON_RESPONSE_TIMEOUT_MS);
      expect(elapsed).toBeLessThan(DAEMON_RESPONSE_TIMEOUT_MS + 5_000);
      expect(daemonPids()).toEqual([daemon]);
      expect(existsSync(join(rig.home, ".ainecto/term/ctl.sock"))).toBe(true);
    } finally {
      process.kill(daemon ?? 0, "SIGCONT");
    }
    expect((await sessions()).map((session) => session.name)).toEqual(["c"]);
  }, LONG);

  it("a daemon that holds the lock but never binds: new gives up after 3 starts and names its pid", async () => {
    const holder = spawn(process.execPath, ["--import", TSX, "--input-type=module", "-e", [
      `import { mkdirSync } from "node:fs";`,
      `const { claimDaemon } = await import(${JSON.stringify(join(ROOT, "src/core/term/daemon.ts"))});`,
      `const { termPaths } = await import(${JSON.stringify(join(ROOT, "src/core/term/paths.ts"))});`,
      `const paths = termPaths(${JSON.stringify(rig.home)});`,
      `mkdirSync(paths.dir, { recursive: true, mode: 0o700 });`,
      `process.stdout.write((await claimDaemon(paths, "test")) ? "held\\n" : "locked\\n");`,
      `process.stdin.resume();`,
    ].join("\n")], { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"] });
    try {
      const held = await new Promise<string>((done) => holder.stdout?.once("data", (chunk: Buffer) => done(chunk.toString("utf8").trim())));
      expect(held).toBe("held");

      const run = await cli("term", "new", "x", "--json", "--", "/bin/sh");
      expect(run.code).toBe(1);
      const error = (JSON.parse(run.stderr) as { error: { code: string; message: string } }).error;
      expect(error.code).toBe("TERM_DAEMON_START");
      expect(error.message).toContain(`pid ${holder.pid}`);
      expect(error.message).toContain(`${DAEMON_START_ATTEMPTS} times`);
      const locked = (await readFile(join(rig.home, ".ainecto/term/daemon.log"), "utf8"))
        .split("\n").filter((line) => line.includes('"daemon_locked"'));
      expect(locked).toHaveLength(DAEMON_START_ATTEMPTS);
      expect(daemonPids()).toEqual([]);
    } finally {
      holder.kill("SIGKILL");
      await exited(holder);
    }
    await ok("term", "new", "x", "--", "/bin/sh");
    expect(daemonPids()).toHaveLength(1);
  }, LONG);

  it("the last kill racing a new: the new session lives, one daemon at a time", async () => {
    let previous = "k0";
    await ok("term", "new", previous, "--", "/bin/sh");
    for (const next of ["k1", "k2", "k3", "k4"]) {
      const [killed, started] = await Promise.all([cli("term", "kill", previous), cli("term", "new", next, "--", "/bin/sh")]);
      expect([killed.code, killed.stderr, started.code, started.stderr]).toEqual([0, "", 0, ""]);
      expect((await sessions()).map((session) => session.name)).toEqual([next]);
      expect(daemonPids()).toHaveLength(1);
      previous = next;
    }
    await assertLogPairs();
  }, LONG);

  it("after the daemon is killed, restore starts the sessions again with the same name, cwd and command", async () => {
    const work = join(rig.home, "work");
    await mkdir(work);
    await ok("term", "new", "r1", "--cwd", work, "--", "/bin/sh");
    // HUP 을 무시하는 자식 — 데몬이 죽어도 산다. 잠금 fd 를 물려받았다면 새 데몬이 영영 못 뜬다.
    await ok("term", "new", "r2", "--", "/bin/sh", "-c", "trap '' HUP; while :; do sleep 1; done");
    const before = await sessions();
    const survivor = before.find((session) => session.name === "r2")?.pid ?? 0;
    for (const pid of daemonPids()) {
      process.kill(pid, "SIGKILL");
    }
    await until(() => daemonPids().length === 0, "daemon killed");
    expect(await ok("term", "ls")).toBe("No term sessions.\n");

    try {
      const restored = await json("term", "restore");
      expect(restored).toMatchObject({ ok: true, data: { restored: ["r1", "r2"], running: [], failed: [] } });
      const after = await sessions();
      expect(after.map(({ name, cwd, command }) => ({ name, cwd, command })).sort((x, y) => x.name.localeCompare(y.name)))
        .toEqual(before.map(({ name, cwd, command }) => ({ name, cwd, command })).sort((x, y) => x.name.localeCompare(y.name)));
      await ok("term", "send", "r1", 'echo "$AINECTO_TERM_SESSION in $(pwd)"');
      await ok("term", "key", "r1", "enter");
      await ok("term", "wait", "r1", "--match", `^r1 in ${work}$`, "--timeout", "10");
      expect(await json("term", "restore")).toMatchObject({ data: { restored: [], running: ["r1", "r2"] } });
    } finally {
      try {
        process.kill(survivor, "SIGKILL");
      } catch {
        // 이미 끝났다.
      }
    }
  }, LONG);

  it("attach shows the screen so far, types into the session, follows the attacher's size and detaches on Ctrl-\\ d", async () => {
    await ok("term", "new", "t", "--", "/bin/sh");
    await ok("term", "send", "t", "echo BEFORE-ATTACH");
    await ok("term", "key", "t", "enter");
    await ok("term", "wait", "t", "--match", "^BEFORE-ATTACH$", "--timeout", "10");

    const outer = attachInPty("t", 100, 30);
    await until(() => outer.text().includes("BEFORE-ATTACH"), "first screen in the attached terminal");
    outer.pty.write("echo TYPED-IN-ATTACH\r");
    await ok("term", "wait", "t", "--match", "^TYPED-IN-ATTACH$", "--timeout", "10");
    expect(await sessions()).toMatchObject([{ name: "t", clients: 1, cols: 100, rows: 30 }]);

    outer.pty.write("\x1c");
    outer.pty.write("d");
    expect(await outer.exit).toBe(0);
    expect(outer.raw()).toContain("[detached from t]");
    expect(await sessions()).toMatchObject([{ name: "t", clients: 0 }]);
  }, LONG);

  it("attach restores the user's terminal when the session app was on the alternate screen and the session ends", async () => {
    await ok("term", "new", "alt", "--", "/bin/sh", "-c", "printf '\\033[?1049h\\033[2J\\033[HALT-SCREEN'; read line");
    await ok("term", "wait", "alt", "--match", "ALT-SCREEN", "--timeout", "10");
    const outer = attachInPty("alt", 80, 24);
    await until(() => outer.text().includes("ALT-SCREEN") && outer.bufferType() === "alternate", "alternate screen in the attached terminal");
    await ok("term", "key", "alt", "enter");
    expect(await outer.exit).toBe(0);
    await until(() => outer.bufferType() === "normal", "attached terminal back on the normal screen");
    expect(outer.raw()).toContain("[alt exited (code 0)]");
  }, LONG);
});
