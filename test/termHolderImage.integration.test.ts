import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { termPaths } from "../src/core/term/paths";
import { LONG, ownResidents, ROOT, until } from "./termRig";

/**
 * holder 자기 사본(세션 유지 구조 3-1) — 실물: 이 저장소를 tsup 으로 빌드한 배포물 두 벌(«npx 캐시»)과 임시 HOME.
 *   설치본 A 로 첫 세션 → holder 는 `~/.ainecto/term/holder/<지문>/` 사본에서 돈다(옛 사본 폴더는 지운다) →
 *   ★A 를 통째로 지운 뒤 설치본 B(같은 판)로 새 세션·쓰기·키·읽기 — holder 가 설치본의 spawn-helper·pty.node 에 기대면 여기서 막힌다.
 */
let out = "";
let home = "";
const installs = { a: "", b: "" };

beforeAll(() => {
  out = realpathSync(execFileSync("mktemp", ["-d", join(tmpdir(), "aterm-dist-XXXX")], { encoding: "utf8" }).trim());
  const build = join(out, "build");
  execFileSync(join(ROOT, "node_modules/.bin/tsup"), ["--out-dir", join(build, "dist")], { cwd: ROOT, stdio: "ignore" });
  for (const name of ["a", "b"] as const) {
    const root = join(out, name);
    cpSync(join(build, "dist"), join(root, "dist"), { recursive: true });
    cpSync(join(ROOT, "package.json"), join(root, "package.json"));
    cpSync(join(ROOT, "node_modules/node-pty"), join(root, "node_modules/node-pty"), { recursive: true, dereference: true });
    installs[name] = root;
  }
  // HOME 은 짧게(termRig 와 같은 모양) — macOS 소켓 경로 상한 104바이트.
  home = realpathSync(execFileSync("mktemp", ["-d", join(tmpdir(), "aterm-XXXXXX")], { encoding: "utf8" }).trim());
}, LONG);

afterAll(async () => {
  // 이 시험이 띄운 상주 프로세스만 — 실행 인자에 이 시험 폴더가 있는 바깥·holder(리뷰 r1 P0-1 · 준비가 중간에 끊겨 폴더가 비면 0개).
  for (const pid of ownResidents(execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" }), [out, home], process.pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 이미 끝났다.
    }
  }
  for (const dir of [out, home]) if (dir) await rm(dir, { recursive: true, force: true });
});

function cliAt(install: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.AINECTO_TERM_SESSION;
  return new Promise((done) => {
    execFile(process.execPath, [join(install, "dist/bin/ainecto.js"), ...args], { env, cwd: home },
      (error, stdout, stderr) => done({ code: error && typeof error.code === "number" ? error.code : 0, stdout, stderr }));
  });
}

async function okAt(install: string, ...args: string[]): Promise<string> {
  const run = await cliAt(install, ...args);
  expect({ args, stderr: run.stderr, code: run.code }).toEqual({ args, stderr: "", code: 0 });
  return run.stdout;
}

function holderArgs(): string[] {
  return execFileSync("ps", ["-axo", "args="], { encoding: "utf8" }).split("\n").filter((args) => args.includes(" term holder ") && args.includes(home));
}

describe("holder 자기 사본 — 실물(빌드한 배포물)", () => {
  it("holder 는 사본에서 돈다 · 옛 사본은 지운다 · ★설치본을 지운 뒤에도 새 PTY·쓰기·키·읽기", async () => {
    const paths = termPaths(home);
    mkdirSync(join(paths.holderImages, "0000000000000000"), { recursive: true });

    await okAt(installs.a, "term", "new", "one", "--", "cat");
    const images = readdirSync(paths.holderImages);
    expect(images).toHaveLength(1);
    const image = join(paths.holderImages, images[0]!);
    expect(images[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(holderArgs()).toEqual([expect.stringContaining(join(image, "ainecto.js"))]);
    const helper = join(image, `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`);
    expect(statSync(helper).mode & 0o100).toBe(0o100);
    expect(existsSync(join(image, ".complete"))).toBe(true);
    const started = readFileSync(paths.holderLog, "utf8").split("\n").filter((line) => line.includes(`"holder_image"`)).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(started).toEqual([expect.objectContaining({ fingerprint: images[0], removed: ["0000000000000000"] })]);
    const one = (JSON.parse(await okAt(installs.a, "term", "ls", "--json")) as { data: { sessions: { name: string; pid: number }[] } }).data.sessions;

    rmSync(installs.a, { recursive: true, force: true });

    await okAt(installs.b, "term", "new", "two", "--", "cat");
    await okAt(installs.b, "term", "send", "two", "after-cache-cleared");
    await okAt(installs.b, "term", "key", "two", "enter");
    await until(async () => (await cliAt(installs.b, "term", "read", "two")).stdout.includes("after-cache-cleared"), "the new session echoed");
    const listed = (JSON.parse(await okAt(installs.b, "term", "ls", "--json")) as { data: { sessions: { name: string; pid: number }[] } }).data.sessions;
    expect(listed.map((session) => session.name).sort()).toEqual(["one", "two"]);
    expect(listed.find((session) => session.name === "one")!.pid).toBe(one[0]!.pid);
    expect(holderArgs()).toHaveLength(1);
  }, LONG);
});
