import { join } from "node:path";
import { stopPc, type PcDeps } from "../src/adapters/cli/pcCommand";
import { PC_SESSION_NAME } from "../src/core/term/protocol";
import { termPaths } from "../src/core/term/paths";
import { json, LONG, ok, rig, useTermRig } from "./termRig";

/**
 * 브리지 정지는 pc-bridge 세션의 uuid 로만(설계 4절 규칙 5 · G1). 목록을 본 뒤 끄기까지 사이에 같은 이름으로 다시 만든 세션은
 * 다른 세션이다 — 이름으로 끄면 그 세션(사용자 셸일 수도 있다)을 끈다. 실 데몬·실 PTY.
 */
useTermRig();

async function instanceOf(name: string): Promise<string> {
  const listed = (await json("term", "ls")).data as { sessions: { name: string; instance: string }[] };
  const found = listed.sessions.find((session) => session.name === name);
  if (!found) throw new Error(`no session ${name}`);
  return found.instance;
}

describe("stopPc — 본 그 uuid 만 끈다", () => {
  it("그 사이 같은 이름으로 다시 만든 세션은 읽지도 끄지도 않는다", async () => {
    await ok("term", "new", PC_SESSION_NAME, "--", "/bin/sh");
    const seen = await instanceOf(PC_SESSION_NAME);
    await ok("term", "kill", PC_SESSION_NAME);
    await ok("term", "new", PC_SESSION_NAME, "--", "/bin/sh");
    const now = await instanceOf(PC_SESSION_NAME);
    expect(now).not.toBe(seen);

    const deps = { paths: termPaths(rig.home), stopDeadlineMs: 5_000, agentLog: join(rig.home, "agent.log") } as unknown as PcDeps;
    const line = await stopPc(deps, { session: PC_SESSION_NAME, instance: seen, cwd: rig.home });

    expect(line).toBe(`Session ${PC_SESSION_NAME} is already gone.`);
    expect(await instanceOf(PC_SESSION_NAME)).toBe(now);
  }, LONG);
});
