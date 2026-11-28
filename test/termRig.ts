import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import headless from "@xterm/headless";
import * as nodePty from "node-pty";
import { termRequest } from "../src/core/term/client";
import { termPaths } from "../src/core/term/paths";

/**
 * `ainecto term` 실물 시험의 공용 틀 — 진짜 CLI 프로세스·진짜 데몬·진짜 PTY. 가짜·호출 횟수 세기 없음.
 * 시험마다 HOME 을 새로 만들어 데몬·소켓·매니페스트가 섞이지 않는다({@link useTermRig} 가 훅을 건다).
 * CLI 는 tsx 로 소스를 바로 돌린다(빌드 전에도 돈다). `--conditions=<표지>` 는 아무 일도 하지 않는 Node 실행 인자로,
 * 데몬이 같은 실행 인자로 떠서 `ps` 에 표지가 보인다 — 이 시험의 데몬만 센다.
 */
export const ROOT = resolve(__dirname, "..");
export const ENTRY = join(ROOT, "src/bin/ainecto.ts");
export const TSX = execFileSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('tsx'))"], { cwd: ROOT, encoding: "utf8" }).trim();
export const LONG = 60_000;

export interface Rig {
  home: string;
  marker: string;
  env: NodeJS.ProcessEnv;
  nodeArgs: string[];
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export let rig: Rig;

/** 이 파일의 시험마다 새 HOME 과 표지를 만들고, 끝나면 이 시험의 데몬을 죽이고 지운다. */
export function useTermRig(): void {
  beforeEach(async () => {
    // 실제 경로로 — 맥의 /var 는 /private/var 의 링크라 CLI 가 보고하는 cwd 와 글자가 다르다.
    const home = await realpath(await mkdtemp(join(tmpdir(), "aterm-")));
    const marker = `aterm-${randomUUID().slice(0, 8)}`;
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.AINECTO_TERM_SESSION;
    rig = { home, marker, env, nodeArgs: ["--import", TSX, `--conditions=${marker}`, ENTRY] };
  });

  afterEach(async () => {
    // 바깥과 holder 둘 다 — holder 가 남으면 세션(PTY)이 시험 HOME 을 붙잡는다.
    for (const pid of [...daemonPids(), ...holderPids()]) {
      process.kill(pid, "SIGKILL");
    }
    await until(() => daemonPids().length + holderPids().length === 0, "daemons gone");
    await rm(rig.home, { recursive: true, force: true });
  });
}

export function cli(...args: string[]): Promise<Run> {
  return new Promise((done) => {
    execFile(process.execPath, [...rig.nodeArgs, ...args], { env: rig.env, cwd: rig.home }, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : 0;
      done({ code, stdout, stderr });
    });
  });
}

export async function ok(...args: string[]): Promise<string> {
  const run = await cli(...args);
  expect(run.stderr, `ainecto ${args.join(" ")}`).toBe("");
  expect(run.code, `ainecto ${args.join(" ")}`).toBe(0);
  return run.stdout;
}

export async function json(...args: string[]): Promise<Record<string, unknown>> {
  const run = await cli(...args, "--json");
  return JSON.parse(run.code === 0 ? run.stdout : run.stderr) as Record<string, unknown>;
}

export async function sessions(): Promise<{ name: string; pid: number; cwd: string; command: string[] | null; clients: number; cols: number; rows: number;
  label?: string; project?: string; lastOutputAt?: string }[]> {
  const result = await json("term", "ls");
  return (result.data as { sessions: never[] }).sessions;
}

export async function screen(name: string): Promise<string[]> {
  const result = await json("term", "read", name);
  return (result.data as { lines: string[] }).lines;
}

/** 이 시험의 데몬(바깥) pid — 실행 인자에 표지와 `term daemon` 이 있는 프로세스. */
export function daemonPids(): number[] {
  return markedPids("term daemon");
}

/** 이 시험의 holder pid — 실행 인자에 표지와 `term holder` 가 있는 프로세스(세션 유지 구조 — 세션은 여기 산다). */
export function holderPids(): number[] {
  return markedPids("term holder");
}

function markedPids(role: string): number[] {
  const table = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return table.split("\n")
    .filter((line) => line.includes(rig.marker) && line.includes(role))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

/**
 * ps 표(`pid args`) 중 이 시험이 띄운 상주 프로세스(`term daemon`·`term holder`)의 pid — 순수 함수.
 * ★빈 폴더 이름은 버린다 — 준비(빌드·복사)가 폴더를 정하기 전에 끊기면 빈 문자열이 모든 줄에 맞아 남의 프로세스까지 죽였다(리뷰 r1 P0-1).
 */
export function ownResidents(table: string, roots: readonly string[], self: number): number[] {
  const mine = roots.filter((root) => root.length > 0);
  if (mine.length === 0) return [];
  return table.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) return [];
    const pid = Number(match[1]);
    const args = match[2]!;
    const resident = args.includes(" term daemon") || args.includes(" term holder");
    return resident && pid !== self && mine.some((root) => args.includes(root)) ? [pid] : [];
  });
}

export async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((done) => {
    if (child.exitCode !== null) {
      done(child.exitCode);
      return;
    }
    child.once("exit", (code) => done(code));
  });
}

/** daemon.log — 요청마다 같은 id 의 응답 줄이 있다(설계 7 ⑤). */
export async function assertLogPairs(): Promise<void> {
  const records = (await readFile(join(rig.home, ".ainecto/term/daemon.log"), "utf8"))
    .trim().split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { event: string; id?: string });
  const requests = records.filter((record) => record.event === "request").map((record) => record.id);
  const responses = new Set(records.filter((record) => record.event === "response").map((record) => record.id));
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((id) => !responses.has(id))).toEqual([]);
}

/** 사람이 쓰는 터미널 대신 진짜 PTY 안에서 `term attach` 를 돌리고, 그 화면을 헤드리스 터미널로 본다. */
export function attachInPty(name: string, cols: number, rows: number) {
  const view = new headless.Terminal({ cols, rows, allowProposedApi: true });
  let raw = "";
  const pty = nodePty.spawn(process.execPath, [...rig.nodeArgs, "term", "attach", name], {
    cols,
    rows,
    cwd: rig.home,
    env: Object.fromEntries(Object.entries(rig.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  });
  pty.onData((data) => {
    raw += data;
    view.write(data);
  });
  // 진짜 터미널처럼 — 앱이 보낸 질의(커서 위치 등)에 이 화면이 답한다.
  view.onData((answer) => pty.write(answer));
  // 헤드리스는 팔레트를 들고 있지 않다 — 진짜 터미널처럼 OSC 4 설정을 적용하고 «?» 에 답한다(리뷰 #82 Q2).
  const palette = new Map<number, string>();
  view.parser.registerOscHandler(4, (data) => {
    const fields = data.split(";");
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const slot = Number(fields[index]);
      const spec = fields[index + 1] ?? "";
      if (spec === "?") {
        pty.write(`\x1b]4;${slot};${palette.get(slot) ?? "rgb:0000/0000/0000"}\x07`);
      } else {
        palette.set(slot, spec);
      }
    }
    return true;
  });
  const exit = new Promise<number>((done) => pty.onExit(({ exitCode }) => done(exitCode)));
  return {
    pty,
    exit,
    raw: () => raw,
    bufferType: () => view.buffer.active.type,
    modes: () => view.modes,
    palette: () => palette,
    /** 보이는 칸마다 글자·색·속성 — 화면끼리 속성까지 대조한다. */
    cells: () => {
      const buffer = view.buffer.active;
      const out: string[] = [];
      for (let row = 0; row < rows; row += 1) {
        const line = buffer.getLine(buffer.viewportY + row);
        for (let col = 0; col < cols; col += 1) {
          const cell = line?.getCell(col);
          out.push(cell
            ? [cell.getChars(), cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(), cell.isBold(), cell.isItalic(), cell.isUnderline(), cell.isInverse()].join("|")
            : "");
        }
      }
      return out;
    },
    text: () => {
      const buffer = view.buffer.active;
      const lines: string[] = [];
      for (let index = 0; index < buffer.length; index += 1) {
        lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
      }
      return lines.join("\n");
    },
  };
}

/**
 * PC 연결 세션 — 이 판 CLI 의 launchPc 처럼 종류 `pc-bridge` 를 실어 만든다(세션 유지 구조: holder 는 종류 없는 요청을 user 로 적는다 —
 * 이름·명령으로 짐작하지 않는다. 설계 원칙 1·2). 진짜 브리지 대신 같은 이름·명령의 잠자는 셸.
 */
export async function pcBridgeSession(command: string[] = ["/bin/sh", "-c", "sleep 600", "pc", "run"]): Promise<void> {
  // 시험 프로세스는 CLI 진입이 아니라 데몬을 못 띄운다 — CLI 로 잠깐 세션 하나를 만들어 데몬을 띄우고 지운다.
  await ok("term", "new", "pc-fixture-warm", "--", "/bin/sh", "-c", "sleep 600");
  const env = Object.fromEntries(Object.entries(rig.env).filter((e): e is [string, string] => typeof e[1] === "string"));
  await termRequest(termPaths(rig.home), { op: "new", name: "ainecto-pc", cwd: rig.home, command, env, kind: "pc-bridge" }, { start: false });
  await ok("term", "kill", "pc-fixture-warm");
}

/** 판을 파일로 고르는 시험 진입(fixtures/termAt.ts) — 같은 소스로 판 N·N+1 의 바깥을 띄운다. */
export const TERM_AT = join(ROOT, "test/fixtures/termAt.ts");

/** 판 `version` 의 바깥을 띄우고 준비 한 줄과 pid 를 받는다(바깥이 holder 도 같은 진입·같은 판으로 띄운다). */
export async function startOuterAt(version: string): Promise<{ status: string; pid: number }> {
  writeFileSync(join(rig.home, "term-version"), `${version}\n`);
  const child = spawn(process.execPath, ["--import", TSX, `--conditions=${rig.marker}`, TERM_AT, "term", "daemon", "--ready-fd", "3"], {
    cwd: rig.home, env: rig.env, stdio: ["ignore", "ignore", "pipe", "pipe"], detached: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const line = await new Promise<string>((resolve, reject) => {
    let text = "";
    child.stdio[3]!.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.includes("\n")) resolve(text.split("\n")[0]!);
    });
    child.once("exit", (code) => reject(new Error(`outer ${version} exited ${code} before ready: ${stderr}`)));
  });
  child.unref();
  return { ...(JSON.parse(line) as { status: string }), pid: child.pid! };
}
