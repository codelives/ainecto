import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npxCliCommand } from "../../src/core/pc/pcSession";
import { spawnCapture } from "../../src/core/os/launch";
import { TermSession } from "../../src/core/term/session";
import { WINDOWS } from "./winRig";

/**
 * W4 ⓐ(설계 windows-pc r3 5-1·6-1 ②) — ★관리 세션의 실제 명령(npxCliCommand)이 후보 tgz 를 고르는가.
 * windows.yml 이 같은 SHA 의 tgz 를 후보 폴더에 의존성으로 설치하고 그 폴더·기대 빌드를 넘긴다(시험 전용 입력 — 제품 env 아님).
 * 실행된 스크립트 경로는 NODE_OPTIONS --require 로 심은 기록기로 잡는다(제품 출력을 바꾸지 않는다). child_process · PTY 양쪽.
 */
const CANDIDATE = process.env.AINECTO_WIN_CANDIDATE_DIR;
const BUILD = process.env.AINECTO_WIN_EXPECTED_BUILD;

let work: string;
let probeOut: string;
let env: NodeJS.ProcessEnv;
let version: string;
let bundle: string;

beforeAll(async () => {
  if (!WINDOWS || !CANDIDATE) return;
  work = await realpath(await mkdtemp(join(tmpdir(), "awin-managed-")));
  probeOut = join(work, "scripts.txt");
  const probe = join(work, "probe.cjs");
  await writeFile(probe, `require("node:fs").appendFileSync(${JSON.stringify(probeOut)}, (process.argv[1] ?? "") + "\\n");`);
  env = { ...process.env, NODE_OPTIONS: `--require "${probe}"` };
  version = (JSON.parse(await readFile(join(CANDIDATE, "node_modules", "@ainecto", "mcp", "package.json"), "utf8")) as { version: string }).version;
  bundle = (await realpath(join(CANDIDATE, "node_modules", "@ainecto", "mcp", "dist", "bin", "ainecto.js"))).toLowerCase();
});
afterAll(async () => {
  if (WINDOWS && CANDIDATE) await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

async function scriptsRun(): Promise<string[]> {
  const text = await readFile(probeOut, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => line.toLowerCase());
}

describe.runIf(WINDOWS && CANDIDATE !== undefined)("W4 관리 명령 실경로 — 내부 npx 가 후보 tgz 를 고른다", () => {
  it("설치된 번들은 이 SHA 의 빌드다", async () => {
    expect(BUILD).toBeTruthy();
    expect(await readFile(bundle, "utf8")).toContain(`"${BUILD}"`);
  });

  it("child_process: npxCliCommand([--version]) → 후보 판 · 실행된 스크립트 = 후보 폴더의 번들", async () => {
    await rm(probeOut, { force: true });
    const child = spawnCapture(npxCliCommand(["--version"], version), { cwd: CANDIDATE ?? "", env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    expect(await new Promise((resolve) => child.on("close", resolve)), stderr).toBe(0);
    expect(stdout.trim()).toBe(version);
    expect(await scriptsRun()).toContain(bundle);
  }, 120_000);

  it("PTY(TermSession): 같은 명령 → 실행된 스크립트 = 후보 폴더의 번들", async () => {
    await rm(probeOut, { force: true });
    const sessionEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const code = await new Promise<number>((resolve) => {
      void TermSession.start({ name: "w4", cwd: CANDIDATE ?? "", command: npxCliCommand(["--version"], version), env: sessionEnv, createdAt: new Date().toISOString() },
        (_session, exitCode) => resolve(exitCode));
    });
    expect(code).toBe(0);
    expect(await scriptsRun()).toContain(bundle);
  }, 120_000);
});
