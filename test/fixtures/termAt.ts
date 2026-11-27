import { closeSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runDaemon } from "../../src/core/term/daemon";
import { runHolder, type DaemonReadiness } from "../../src/core/term/holder";
import { termPaths } from "../../src/core/term/paths";

/**
 * 시험용 진입 — `termAt.ts term daemon|holder --ready-fd 3`. 판을 `$HOME/term-version` 파일에서 읽는다(같은 소스로 «판 N 의 바깥»·«판 N+1 의 바깥»을
 * 띄워 넘기기를 시험한다). 바깥이 holder 를 띄울 때도 이 진입(process.argv[1])으로 띄운다.
 */
const role = process.argv[3];
const version = readFileSync(join(homedir(), "term-version"), "utf8").trim();
let open = true;
const ready = (readiness: DaemonReadiness): void => {
  if (!open) return;
  open = false;
  writeSync(3, `${JSON.stringify(readiness)}\n`);
  closeSync(3);
};
const run = role === "holder" ? runHolder : runDaemon;
process.exit(await run({ paths: termPaths(), version, ready }));
