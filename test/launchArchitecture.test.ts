import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * 아키텍처 시험 A1~A4(설계 windows-pc r3 3-3) — 프로세스 띄우기·끄기·플랫폼 분기가 정한 자리 밖으로 새지 않게 한다.
 * 예외는 이름으로 박는다. 늘리려면 설계서를 먼저 고친다.
 */
const SRC = resolve(__dirname, "..", "src");

function sources(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

function rel(path: string): string {
  return relative(SRC, path).split(sep).join("/");
}

const FILES = sources().map((path) => ({ file: rel(path), text: readFileSync(path, "utf8") }));

/** A1 — child_process 를 «실행용으로» 들이는가(`import type` 은 아니다). */
export function importsChildProcessValue(text: string): boolean {
  const statements = text.match(/^\s*import\s[^;]*?from\s+["'](?:node:)?child_process["']/gms) ?? [];
  return statements.some((statement) => !/^\s*import\s+type\s/.test(statement)) || /require\(\s*["'](?:node:)?child_process["']\s*\)/.test(text);
}

/** A3 — `.kill(` 호출마다 (파일, 받는 쪽) 짝. 허용 목록 밖이면 그 호출을 돌려준다. */
const KILL_ALLOWED: ReadonlyArray<{ file: string; receiver: string; args?: RegExp; count?: number }> = [
  { file: "core/os/launch.ts", receiver: "*" },
  { file: "core/term/session.ts", receiver: "this.pty", count: 1 },
  { file: "core/term/client.ts", receiver: "child", count: 1 },
  { file: "core/term/residentInfo.ts", receiver: "process", args: /^pid, 0$/, count: 1 },
  // ★도메인 진입점 TermSession.kill() — kill·kill-server 요청 처리(raw 프로세스 kill 이 아니다).
  { file: "core/term/holder.ts", receiver: "session", count: 2 },
];

export function killViolations(file: string, text: string): string[] {
  const calls = [...text.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.kill\(([^)]*)\)/g)].map((match) => ({ receiver: match[1] ?? "", args: (match[2] ?? "").trim() }));
  const used = new Map<(typeof KILL_ALLOWED)[number], number>();
  const bad: string[] = [];
  for (const call of calls) {
    const rule = KILL_ALLOWED.find((allowed) => allowed.file === file && (allowed.receiver === "*" || allowed.receiver === call.receiver)
      && (allowed.args === undefined || allowed.args.test(call.args)));
    if (!rule) {
      bad.push(`${file}: ${call.receiver}.kill(${call.args})`);
      continue;
    }
    used.set(rule, (used.get(rule) ?? 0) + 1);
  }
  for (const [rule, count] of used) {
    if (rule.count !== undefined && count > rule.count) bad.push(`${file}: ${rule.receiver}.kill — ${count} calls, at most ${rule.count}`);
  }
  return bad;
}

const CHILD_PROCESS_ALLOWED = ["core/os/launch.ts", "core/auth/oauth.ts"];
const NODE_PTY_ALLOWED = ["core/term/session.ts"];
const PLATFORM_ALLOWED = ["core/term/paths.ts", "core/term/daemonLock.ts", "core/term/ipc.ts", "core/os/launch.ts", "core/auth/oauth.ts"];

describe("아키텍처 — 프로세스·플랫폼 분기의 자리(A1~A4)", () => {
  it("A1 child_process 실행 import 는 launch.ts·oauth.ts(브라우저 열기)만 — import type 은 어디서나", () => {
    expect(FILES.filter(({ text }) => importsChildProcessValue(text)).map(({ file }) => file).sort()).toEqual([...CHILD_PROCESS_ALLOWED].sort());
  });

  it("A2 node-pty 는 term/session.ts 만", () => {
    expect(FILES.filter(({ text }) => /from\s+["']node-pty["']|import\(\s*["']node-pty["']\s*\)/.test(text)).map(({ file }) => file)).toEqual(NODE_PTY_ALLOWED);
  });

  it("A3 .kill( 은 (파일, 받는 쪽) 허용 목록만 — 도메인 TermSession.kill 과 raw 프로세스 kill 을 가른다", () => {
    expect(FILES.flatMap(({ file, text }) => killViolations(file, text))).toEqual([]);
  });

  it("A4 process.platform 은 paths·daemonLock·ipc·launch·oauth 만", () => {
    expect(FILES.filter(({ text }) => text.includes("process.platform")).map(({ file }) => file).sort()).toEqual([...PLATFORM_ALLOWED].sort());
  });
});

describe("아키텍처 검사기 자체 — 통과·실패 둘 다", () => {
  it("A1: 값 import·require 는 잡고, import type 은 놓아 준다", () => {
    expect(importsChildProcessValue('import { spawn } from "node:child_process";')).toBe(true);
    expect(importsChildProcessValue('import {\n  spawn,\n  type ChildProcess,\n} from "node:child_process";')).toBe(true);
    expect(importsChildProcessValue('const cp = require("child_process");')).toBe(true);
    expect(importsChildProcessValue('import type { ChildProcess } from "node:child_process";')).toBe(false);
  });

  it("A3: 정해진 짝은 통과 · 다른 파일의 child.kill()·daemon.ts 의 proc.kill()·횟수 초과는 실패", () => {
    expect(killViolations("core/term/holder.ts", "session.kill();\nsession.kill();")).toEqual([]);
    expect(killViolations("core/term/client.ts", "child.kill();")).toEqual([]);
    expect(killViolations("core/term/residentInfo.ts", "process.kill(pid, 0);")).toEqual([]);
    expect(killViolations("core/agent/child.ts", "this.child.kill(\"SIGKILL\");")).toEqual(['core/agent/child.ts: this.child.kill("SIGKILL")']);
    expect(killViolations("core/term/holder.ts", "proc.kill();")).toEqual(["core/term/holder.ts: proc.kill()"]);
    expect(killViolations("core/term/client.ts", "process.kill(pid, \"SIGTERM\");")).toHaveLength(1);
    expect(killViolations("core/term/holder.ts", "session.kill();session.kill();session.kill();")).toEqual(["core/term/holder.ts: session.kill — 3 calls, at most 2"]);
  });
});
