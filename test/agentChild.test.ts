import { spawn } from "node:child_process";
import { AgentChild, type AgentSpawn, type ChildExit } from "../src/core/agent/child";

const plain: AgentSpawn = (command, args, opts) => spawn(command, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });

function start(spawnImpl: AgentSpawn, command: string, args: string[]): { child: AgentChild; exits: ChildExit[] } {
  const exits: ChildExit[] = [];
  const child = new AgentChild(spawnImpl, command, args, { cwd: process.cwd(), env: process.env }, { line: () => {}, exit: (e) => exits.push(e) });
  return { child, exits };
}

describe("AgentChild 끝 판정", () => {
  it("띄우지 못하면(ENOENT) 끝으로 — exit 한 번 · alive false · 사유는 stderr 꼬리", async () => {
    const { child, exits } = start(plain, "ainecto-no-such-agent-binary", []);
    expect(await child.waitForExit(5_000)).toBe(true);
    expect(child.alive).toBe(false);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.stderrTail).toMatch(/ENOENT/);
  });

  it("떠 있는 프로세스의 kill 오류(EPERM)는 끝이 아니다 — 실제 exit 까지 alive · 그 뒤 exit 한 번(구현 리뷰 3차)", async () => {
    let real: ReturnType<typeof spawn> | undefined;
    const eperm: AgentSpawn = (command, args, opts) => {
      const c = plain(command, args, opts);
      real = c;
      c.kill = () => {
        c.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM", errno: -1, syscall: "kill" }));
        return false;
      };
      return c;
    };
    const { child, exits } = start(eperm, process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    try {
      const stopped = await child.forceStop();
      expect(stopped?.directExited).toBe(false);
      expect(child.alive).toBe(true);
      expect(exits).toHaveLength(0);
    } finally {
      process.kill(child.pid, "SIGTERM");   // 실제로 끝냄(실패해도 남기지 않는다)
    }
    expect(await child.waitForExit(5_000)).toBe(true);
    expect(child.alive).toBe(false);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.stderrTail).toMatch(/EPERM/);
    expect(real?.pid).toBe(child.pid);
  }, 30_000);
});
