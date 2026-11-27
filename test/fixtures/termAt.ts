import { closeSync, existsSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { upgradeDaemon, type PcDeps } from "../../src/adapters/cli/pcCommand";
import { runDaemon } from "../../src/core/term/daemon";
import { runHolder, type DaemonReadiness } from "../../src/core/term/holder";
import { termPaths } from "../../src/core/term/paths";

/**
 * 시험용 진입 — 판을 `$HOME/term-version` 파일에서 읽는다(같은 소스로 «판 N»·«판 N+1» 을 띄워 넘기기를 시험한다 — 환경변수 안 씀).
 *   `termAt.ts term daemon|holder --ready-fd 3` — 그 판의 바깥·holder. 바깥이 holder 를 띄울 때도 이 진입(process.argv[1])으로 띄운다.
 *   `termAt.ts upgrade [--interactive]` — 그 판 CLI 의 upgradeDaemon(연결 명령의 앞단계) 하나. 안내 줄을 JSON 한 줄로 stdout 에.
 *     넘기기에서 띄우는 바깥도 이 진입이라 같은 판이다. --interactive 면 stdin 에서 답을 읽는다.
 *   `$HOME/term-compute` 가 있으면 그 줄 = 이 판 «설치본»의 계산 모듈 파일(바깥이 holder 에 알린다 · 배포물의 installedComputeFile 자리).
 */
const version = readFileSync(join(homedir(), "term-version"), "utf8").trim();
const computeFile = join(homedir(), "term-compute");
const compute = existsSync(computeFile) ? readFileSync(computeFile, "utf8").trim() : undefined;
if (process.argv[2] === "upgrade") {
  const notes: string[] = [];
  const deps = {
    io: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
    interactive: process.argv.includes("--interactive"),
    paths: termPaths(),
    cliVersion: version,
    stopDeadlineMs: 10_000,
  } as unknown as PcDeps;
  await upgradeDaemon(deps, (line) => notes.push(line));
  process.stdout.write(`${JSON.stringify({ notes })}\n`);
  process.exit(0);
}
const role = process.argv[3];
let open = true;
const ready = (readiness: DaemonReadiness): void => {
  if (!open) return;
  open = false;
  writeSync(3, `${JSON.stringify(readiness)}\n`);
  closeSync(3);
};
const run = role === "holder" ? runHolder : runDaemon;
process.exit(await run({ paths: termPaths(), version, ready, ...(compute ? { compute } : {}) }));
