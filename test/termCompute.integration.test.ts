import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { termPaths } from "../src/core/term/paths";
import { XTERM_VERSION } from "../src/core/term/xtermVersion";
import { cli, LONG, ok, rig, ROOT, screen, sessions, startOuterAt, until, useTermRig } from "./termRig";

/**
 * 계산 모듈 갈아 끼우기(세션 유지 구조 3-2) — 실물: 진짜 holder·바깥(fixtures/termAt.ts)과 배포물처럼 따로 번들한 모듈 파일.
 *   바깥은 임대를 쥔 뒤 «내 설치본의 계산 모듈 = 이 파일»($HOME/term-compute)을 알리고, holder 는 스스로 확인한 뒤에만 바꾼다.
 *   열린 세션(PTY 그대로)이 다음 계산부터 새 모듈을 쓴다 · 확인을 못 넘긴 모듈은 이유 한 줄과 함께 거절되고 지금 모듈 그대로.
 */
useTermRig();

let out = "";
const bundles = { next: "", broken: "", otherXterm: "" };

/** 배포 빌드(tsup 진입 term/compute)와 같은 모양으로 — ESM 파일 하나 · 판은 빌드가 박는다. */
async function bundle(entry: string, file: string, version: string, xterm = XTERM_VERSION): Promise<string> {
  const outfile = join(out, file);
  await build({
    entryPoints: [join(ROOT, entry)], outfile, bundle: true, format: "esm", platform: "node", target: "node18", mainFields: ["main", "module"], logLevel: "silent",
    define: { __AINECTO_CLI_VERSION__: JSON.stringify(version), __AINECTO_XTERM_VERSION__: JSON.stringify(xterm) },
  });
  return outfile;
}

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "aterm-compute-"));
  bundles.next = await bundle("test/fixtures/computeNext.ts", "next.js", "0.16.10");
  bundles.broken = await bundle("test/fixtures/computeBroken.ts", "broken.js", "0.16.8");
  bundles.otherXterm = await bundle("test/fixtures/computeNext.ts", "other-xterm.js", "0.16.9", "0.0.0");
});

afterAll(async () => {
  if (out) await rm(out, { recursive: true, force: true });
});

/** 이 판의 바깥을 띄운다 — 그 «설치본»의 계산 모듈은 `file`. */
async function outerWith(version: string, file: string): Promise<void> {
  writeFileSync(join(rig.home, "term-compute"), `${file}\n`);
  expect((await startOuterAt(version)).status).toBe("ready");
}

function holderEvents(event: string): Record<string, unknown>[] {
  return readFileSync(termPaths(rig.home).holderLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.event === event);
}

describe("계산 모듈 갈아 끼우기 — 실물", () => {
  it("열린 세션에 새 판 계산이 들어온다(PTY PID 그대로) · 자기 시험·xterm 판을 못 넘긴 모듈은 이유와 함께 거절 · 지금 모듈 그대로", async () => {
    expect((await startOuterAt("0.16.7")).status).toBe("ready");
    await ok("term", "new", "work", "--", "cat");
    const [before] = await sessions();
    const unknown = await cli("term", "key", "work", "next-probe");
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain(`Unknown key "next-probe"`);

    await outerWith("0.16.8", bundles.broken);
    await outerWith("0.16.9", bundles.otherXterm);
    expect(holderEvents("compute_kept").map((record) => record.reason)).toEqual([
      expect.stringMatching(/^self-check "plain shell screen" failed: read gave \["broken"\]/),
      `the module was built for xterm 0.0.0, this holder runs xterm ${XTERM_VERSION}`,
    ]);
    expect((await cli("term", "key", "work", "next-probe")).stderr).toContain(`Unknown key "next-probe"`);

    await outerWith("0.16.10", bundles.next);
    expect(holderEvents("compute_switched")).toEqual([expect.objectContaining({ file: bundles.next, version: "0.16.10", digest: expect.stringMatching(/^[0-9a-f]{16}$/) })]);
    await ok("term", "key", "work", "next-probe");
    await until(async () => (await screen("work")).includes("NEXT"), "the new module's key reached the open session");
    expect((await sessions()).map((session) => session.pid)).toEqual([before!.pid]);

    // 같은 파일을 다시 알려도(같은 판 바깥이 다시 뜸 · holder 갈기 뒤 등) 다시 불러오지 않는다.
    await outerWith("0.16.11", bundles.next);
    expect(holderEvents("compute_kept").at(-1)).toEqual(expect.objectContaining({ version: "0.16.10", reason: "already active" }));
  }, LONG);
});
