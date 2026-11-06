import { execFile, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import headless from "@xterm/headless";
import * as nodePty from "node-pty";

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
    for (const pid of daemonPids()) {
      process.kill(pid, "SIGKILL");
    }
    await until(() => daemonPids().length === 0, "daemons gone");
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

export async function sessions(): Promise<{ name: string; pid: number; cwd: string; command: string[] | null; clients: number; cols: number; rows: number }[]> {
  const result = await json("term", "ls");
  return (result.data as { sessions: never[] }).sessions;
}

export async function screen(name: string): Promise<string[]> {
  const result = await json("term", "read", name);
  return (result.data as { lines: string[] }).lines;
}

/** 이 시험의 데몬 pid — 실행 인자에 표지와 `term daemon` 이 있는 프로세스. */
export function daemonPids(): number[] {
  const table = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return table.split("\n")
    .filter((line) => line.includes(rig.marker) && line.includes("term daemon"))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
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
