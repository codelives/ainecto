import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { termRuntimeProblem } from "../src/core/term/daemonLock";

/**
 * 데몬 잠금 실물 시험(설계 2-1 v3) — 별도 프로세스 셋이 진짜 OS 잠금을 다툰다.
 *   A 가 쥔 동안 B 는 못 잡는다 → A 를 SIGKILL 하면 OS 가 풀어 C 가 잡는다 → 그 뒤 D 는 다시 못 잡는다.
 * macOS 는 O_EXLOCK 파일, Linux 는 추상 이름공간 소켓.
 */
const ROOT = resolve(__dirname, "..");
const TSX = execFileSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('tsx'))"], { cwd: ROOT, encoding: "utf8" }).trim();
const LOCK_MODULE = join(ROOT, "src/core/term/daemonLock.ts");
const PATHS_MODULE = join(ROOT, "src/core/term/paths.ts");

let home: string;
let otherHome: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "aterm-lock-"));
  otherHome = await mkdtemp(join(tmpdir(), "aterm-lock-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(otherHome, { recursive: true, force: true });
});

/** 잠금을 한 번 잡아 보고 결과를 한 줄 쓴 뒤, 잡았으면 표준입력이 닫힐 때까지 쥐고 있는 프로세스. */
function contender(where: string = home): { child: ChildProcess; verdict: Promise<string> } {
  const script = [
    `import { mkdirSync } from "node:fs";`,
    `const { acquireDaemonLock } = await import(${JSON.stringify(LOCK_MODULE)});`,
    `const { termPaths } = await import(${JSON.stringify(PATHS_MODULE)});`,
    `const paths = termPaths(${JSON.stringify(where)});`,
    `mkdirSync(paths.dir, { recursive: true, mode: 0o700 });`,
    `const result = await acquireDaemonLock(paths);`,
    `process.stdout.write(result.held ? "held\\n" : "locked\\n");`,
    `if (result.held) { process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); }`,
  ].join("\n");
  const child = spawn(process.execPath, ["--import", TSX, "--input-type=module", "-e", script], { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"] });
  const verdict = new Promise<string>((done) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes("\n")) {
        done(out.trim());
      }
    });
  });
  return { child, verdict };
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((done) => (child.exitCode !== null || child.signalCode !== null ? done() : child.once("exit", () => done())));
}

describe("term daemon lock (real processes)", () => {
  it("only one process holds it, and the OS frees it when the holder is killed", async () => {
    const a = contender();
    expect(await a.verdict).toBe("held");
    const b = contender();
    expect(await b.verdict).toBe("locked");
    await exited(b.child);

    a.child.kill("SIGKILL");
    await exited(a.child);
    const c = contender();
    expect(await c.verdict).toBe("held");
    const d = contender();
    expect(await d.verdict).toBe("locked");
    await exited(d.child);
    c.child.stdin?.end();
    await exited(c.child);
  }, 60_000);

  it("two different homes hold their own locks at the same time (Linux: the abstract name keeps the folder)", async () => {
    const a = contender(home);
    expect(await a.verdict).toBe("held");
    const b = contender(otherHome);
    expect(await b.verdict).toBe("held");
    a.child.stdin?.end();
    b.child.stdin?.end();
    await Promise.all([exited(a.child), exited(b.child)]);
  }, 60_000);
});

describe("term runtime floor", () => {
  it("needs Node 20.8.0 on Linux for the abstract-socket lock, any supported Node on macOS, and refuses other platforms", () => {
    expect(termRuntimeProblem("linux", "18.20.8")).toMatch(/needs Node\.js 20\.8\.0 or newer \(this is 18\.20\.8\)/);
    expect(termRuntimeProblem("linux", "20.7.0")).toMatch(/20\.8\.0/);
    expect(termRuntimeProblem("linux", "20.8.0")).toBeUndefined();
    expect(termRuntimeProblem("linux", "22.20.0")).toBeUndefined();
    expect(termRuntimeProblem("darwin", "18.0.0")).toBeUndefined();
    expect(termRuntimeProblem("win32", "22.20.0")).toMatch(/not supported on win32/);
  });
});
