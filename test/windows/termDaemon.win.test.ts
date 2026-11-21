import { readFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { parseAddressFile } from "../../src/core/term/ipc";
import { alive, cli, daemonLog, daemonPid, LONG, ok, rig, until, useWinRig, WINDOWS } from "./winRig";

/**
 * W1(설계 windows-pc r3 3-1·1·2절) — 제품의 openTermClient·acquireDaemonLock·데몬 listen 이 Windows 에서 그대로 돈다.
 * 잠금 경쟁(A/B/C)은 test/termLock.test.ts 가 같은 CI 에서 본다.
 */
describe.runIf(WINDOWS)("Windows term 데몬 — named pipe · 주소 파일 · 증명", () => {
  useWinRig();

  it("term new → ls → 주소 파일(무작위 pipe) → kill-server 뒤 주소 파일이 지워진다", async () => {
    await ok("term", "new", "s1", "--", rig.shell);
    const listed = JSON.parse(await ok("term", "ls", "--json")) as { data: { sessions: { name: string }[] } };
    expect(listed.data.sessions.map((session) => session.name)).toEqual(["s1"]);
    const address = parseAddressFile(await readFile(rig.paths.socket, "utf8"));
    expect(address?.address).toMatch(/^\\\\\.\\pipe\\ainecto-term-[0-9a-f]{32}$/);
    await ok("term", "kill-server");
    await until(async () => (await readFile(rig.paths.socket, "utf8").then(() => false, () => true)), "address file removed");
  }, LONG);

  it("잠금 불변: PTY 자식이 살아 있어도 데몬이 강제 종료되면 새 데몬이 잠금을 잡는다", async () => {
    await ok("term", "new", "s1", "--", rig.shell);
    const first = await daemonPid();
    expect(first).toBeDefined();
    process.kill(first ?? 0);
    await until(() => !alive(first ?? 0), "first daemon gone");
    await ok("term", "new", "s2", "--", rig.shell);
    const second = await daemonPid();
    expect(second).not.toBe(first);
  }, LONG);

  it("사칭: 강제 종료 뒤 옛 pipe 이름을 남이 다시 만들어도 클라이언트는 hello 한 줄만 보내고, 새 데몬으로 붙는다", async () => {
    await ok("term", "new", "s1", "--", rig.shell);
    const stale = parseAddressFile(await readFile(rig.paths.socket, "utf8"));
    const first = await daemonPid();
    process.kill(first ?? 0);
    await until(() => !alive(first ?? 0), "first daemon gone");
    // 강제 종료라 주소 파일은 남았다 — 같은 이름으로 가짜 서버를 세운다(답은 틀린 증명).
    const received: string[] = [];
    const impostor = createServer((socket: Socket) => {
      socket.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          received.push(line);
          const id = (JSON.parse(line) as { id?: string }).id;
          socket.write(`${JSON.stringify({ id, ok: true, data: { proof: "AAAA" } })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => impostor.listen(stale?.address ?? "", resolve));
    try {
      const run = await cli("term", "new", "s2", "--json", "--", rig.shell);
      expect(run.code, run.stderr).toBe(0);
    } finally {
      await new Promise<void>((resolve) => impostor.close(() => resolve()));
    }
    expect(received).toHaveLength(1);
    const hello = JSON.parse(received[0] ?? "{}") as Record<string, unknown>;
    expect(Object.keys(hello).sort()).toEqual(["id", "nonce", "op"]);
    expect(hello.op).toBe("hello");
    expect(received[0]).not.toContain("env");
    const fresh = parseAddressFile(await readFile(rig.paths.socket, "utf8"));
    expect(fresh?.address).not.toBe(stale?.address);
    expect((await daemonLog()).some((record) => record.event === "ipc_impostor")).toBe(true);
  }, LONG);
});
