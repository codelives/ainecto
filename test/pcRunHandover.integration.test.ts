import { pullOuterHandover } from "../src/adapters/cli/pcRemote";
import { termPaths } from "../src/core/term/paths";
import { LONG, ok, rig, startOuterAt, useTermRig } from "./termRig";

/**
 * `pc run` 시작이 바깥 넘기기를 당긴다(prep U5 «자동 업그레이드가 바깥 넘기기를 당김» · 어긋난 곳 12) — 자동 업그레이드는 새 판의 `pc run` 을
 * 띄울 뿐이라, 그 `pc run` 이 살아 있는 바깥에게 판을 묻고 더 새 판이면 이 판의 바깥을 띄운다(넘겨받는다). 실 바깥·실 holder.
 * 띄우기는 대역 — 이 시험 프로세스에서 띄우면 vitest 를 띄운다. 넘기기 자체는 termHandover 시험이 본다.
 */
useTermRig();

describe("pc run 시작 — 바깥 넘기기 당김", () => {
  it("살아 있는 바깥보다 새 판이면 바깥을 띄운다 · 같은 판·낮은 판·데몬 없음이면 띄우지 않는다", async () => {
    const spawned: string[] = [];
    const spawn = async (_paths: unknown, role: "daemon" | "holder") => {
      spawned.push(role);
      return { status: "ready" as const };
    };
    const paths = termPaths(rig.home);
    expect(await pullOuterHandover(paths, "0.16.8", spawn)).toBeUndefined();
    expect(spawned).toEqual([]);

    expect((await startOuterAt("0.16.7")).status).toBe("ready");
    await ok("term", "new", "a", "--", "cat");
    for (const same of ["0.16.7", "0.16.6"]) expect(await pullOuterHandover(paths, same, spawn)).toBeUndefined();
    expect(spawned).toEqual([]);

    expect(await pullOuterHandover(paths, "0.16.8", spawn)).toEqual({ status: "ready" });
    expect(spawned).toEqual(["daemon"]);
  }, LONG);
});
