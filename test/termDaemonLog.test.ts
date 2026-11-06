import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonLog } from "../src/core/term/daemonLog";
import { DAEMON_LOG_MAX_BYTES } from "../src/core/term/limits";
import { termPaths } from "../src/core/term/paths";

/** 데몬 로그 회전 — 실제 파일. 크기만 생성 인자로 낮춘다(운영 값은 limits.ts 한 곳). */
describe("term daemon log rotation", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aterm-log-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("keeps only daemon.log.1 when the log passes the limit, and every line stays whole", async () => {
    const paths = termPaths(home);
    await mkdir(paths.dir, { recursive: true });
    const log = new DaemonLog(paths.log, paths.previousLog, 600);
    log.enableRotation();
    for (let index = 0; index < 40; index += 1) {
      log.write({ event: "request", id: `id-${index}`, conn: 1, op: "ls" });
    }
    const current = await readFile(paths.log, "utf8");
    const previous = await readFile(paths.previousLog, "utf8");
    expect((await stat(paths.log)).size).toBeLessThanOrEqual(600);
    expect((await stat(paths.previousLog)).size).toBeLessThanOrEqual(600);
    for (const line of [...current.trim().split("\n"), ...previous.trim().split("\n")]) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // 마지막 줄은 지금 로그에, 그 바로 앞 줄들은 .1 에 — 그보다 오래된 것은 버려졌다(.1 하나만).
    expect(current).toContain('"id":"id-39"');
    expect(previous).not.toContain('"id":"id-0"');
    expect((await stat(paths.log)).mode & 0o777).toBe(0o600);
  });

  it("does not rotate before the daemon holds the lock", async () => {
    const paths = termPaths(home);
    await mkdir(paths.dir, { recursive: true });
    const log = new DaemonLog(paths.log, paths.previousLog, 100);
    for (let index = 0; index < 5; index += 1) {
      log.write({ event: "daemon_locked", pid: index });
    }
    expect((await readFile(paths.log, "utf8")).trim().split("\n")).toHaveLength(5);
    await expect(stat(paths.previousLog)).rejects.toThrow();
  });

  it("runs on 10 MB in production", () => {
    expect(DAEMON_LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});
