import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { shellLineCommand } from "../../src/core/os/launch";
import { TermSession } from "../../src/core/term/session";
import { ROOT, TSX, until, WINDOWS } from "./winRig";

/**
 * `ainecto pair` 의 코드 주고받기(openDevTty)가 Windows 콘솔에서 된다 — 0.15.0 은 `/dev/tty` 를 열어(Node 가 `C:\dev\tty` 로 풀어 ENOENT)
 * Windows 에서 짝짓기가 늘 PAIR_NO_TTY 였다 → 웹 터미널을 Windows PC 에 못 붙였다.
 * ① ConPTY(사람이 보는 콘솔과 같음) 안에서: 코드 줄이 화면에 보이고, 친 줄을 받는다 — 표준 입력을 NUL 로 돌려도 콘솔에서 읽는다(파이프로 흘러가지 않음).
 * ② 콘솔이 없는 프로세스(detached = DETACHED_PROCESS): PAIR_NO_TTY(Unix 데몬과 같다).
 */
let work: string;
let probe: string;
let env: Record<string, string>;

beforeAll(async () => {
  if (!WINDOWS) return;
  work = await realpath(await mkdtemp(join(tmpdir(), "awin-pair-")));
  env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  probe = join(work, "probe.mts");
  const pairCommand = pathToFileURL(join(ROOT, "src/adapters/cli/pairCommand.ts")).href;
  const confirmation = pathToFileURL(join(ROOT, "src/adapters/cli/destructiveConfirmation.ts")).href;
  await writeFile(probe, [
    'import { writeFileSync } from "node:fs";',
    `import { openDevTty } from ${JSON.stringify(pairCommand)};`,
    `import { promptLine } from ${JSON.stringify(confirmation)};`,
    "const out = process.argv[2];",
    "try {",
    "  const tty = openDevTty();",
    '  tty.stderr.write("pair-tty-shown\\n");',
    '  const answer = await promptLine(tty, "code? ");',
    "  tty.close();",
    "  writeFileSync(out, JSON.stringify({ answer, stdinIsTTY: process.stdin.isTTY === true }));",
    "} catch (error) {",
    "  writeFileSync(out, JSON.stringify({ error: error.code ?? String(error), message: String(error.message ?? error) }));",
    "}",
    "process.exit(0);",
  ].join("\n"));
});
afterAll(async () => {
  if (WINDOWS) await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

describe.runIf(WINDOWS)("pair 코드 — Windows 콘솔(CONIN$·CONOUT$)", () => {
  it("ConPTY 안: 코드 줄이 화면에 · 친 줄을 받는다 — 표준 입력이 NUL 이어도 콘솔에서 읽는다", async () => {
    const result = join(work, "console.json");
    let resolveExit: (code: number) => void = () => undefined;
    const exit = new Promise<number>((resolve) => { resolveExit = resolve; });
    const line = `"${process.execPath}" --import ${TSX} "${probe}" "${result}" < NUL`;
    const session = await TermSession.start({ name: `pair-${Date.now()}`, cwd: work, command: shellLineCommand(line, env), env, createdAt: new Date().toISOString() },
      (_session, exitCode) => resolveExit(exitCode));
    const screen = async (): Promise<string> => (await session.read({ scrollback: true })).join("\n");
    await until(async () => (await screen()).includes("code? "), "pair prompt on the console", 60_000);
    expect(await screen()).toContain("pair-tty-shown");
    await session.send("123456\r", false);
    expect(await exit).toBe(0);
    expect(JSON.parse(await readFile(result, "utf8"))).toEqual({ answer: "123456", stdinIsTTY: false });
  }, 90_000);

  it("콘솔이 없는 프로세스(detached): PAIR_NO_TTY", async () => {
    const result = join(work, "detached.json");
    const child = spawn(process.execPath, ["--import", TSX, probe, result], { cwd: work, env, detached: true, stdio: "ignore", windowsHide: true });
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(0);
    const value = JSON.parse(await readFile(result, "utf8")) as { error?: string; message?: string };
    expect(value.error, value.message).toBe("PAIR_NO_TTY");
    expect(value.message).toContain("CONIN$");
  }, 60_000);
});
