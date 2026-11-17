import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { onStopSignals, STOP_SIGNALS } from "../src/core/async/stopSignals";

/**
 * ★next.9 실물(2026-11-17 02:04Z): `ainecto stop` 의 Ctrl+C 가 npx 아래의 pc run 에 «두 번» 닿는다(PTY 프로세스 그룹 + npx 가 넘겨줌).
 * `process.once` 면 두 번째 SIGINT 에 처리기가 없어 기본 동작으로 죽고 → npx 가 그 신호로 끝나(signal 2) 서버 close·serve_stop 이 없고
 * 매니페스트에 남았다(kept:true). 대역 시험은 npx 를 거치지 않아 한 번만 받아 못 잡았다.
 */
describe("멈춤 신호", () => {
  it("두 번 와도 처리기가 남아 있다(기본 동작으로 죽지 않는다) · 떼면 원래대로", () => {
    const before = STOP_SIGNALS.map((signal) => process.listenerCount(signal));
    let calls = 0;
    const off = onStopSignals(() => { calls += 1; });
    process.emit("SIGINT");
    expect(process.listenerCount("SIGINT")).toBe(before[0]! + 1);
    process.emit("SIGINT");
    process.emit("SIGHUP");
    expect(calls).toBe(3);
    off();
    expect(STOP_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
  });

  it("src 에 process.once 로 거는 멈춤 신호가 없다 — 모두 onStopSignals 한 곳", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts") && /process\.once\(\s*["']SIG/.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    walk(join(__dirname, "..", "src"));
    expect(offenders).toEqual([]);
  });
});
