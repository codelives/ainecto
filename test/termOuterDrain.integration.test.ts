import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { RETRY_CODE } from "../src/core/term/protocol";
import { daemonPids, holderPids, LONG, ok, rig, until, useTermRig } from "./termRig";

/**
 * 바깥이 끝날 때 아직 아무 요청도 보내지 않은 CLI 연결(세션 유지 구조 — 마지막 kill 과 new 의 경합).
 * holder 는 바깥에 붙은 CLI 를 세지 않는다(바깥이 holder 로 이은 연결만 센다) — CLI 가 바깥에 붙자마자 마지막 세션이 끝나면 holder 가 끝나고,
 * 그 바깥도 끝난다. 그때 오는 중이던 첫 요청을 답 없이 끊으면 CLI 는 «결과 모름»(TERM_DAEMON_GONE)으로 멈춘다 — 바깥은 그 요청을 읽지도 않았다.
 */
useTermRig();

function open(file: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(file);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

async function accepts(file: string): Promise<boolean> {
  try {
    (await open(file)).destroy();
    return true;
  } catch {
    return false;
  }
}

describe("바깥이 끝날 때 — 아직 요청을 보내지 않은 연결", () => {
  it("holder 가 끝난 뒤 그 연결의 첫 요청은 RETRY 로 답하고 끊는다(답 없이 끊지 않는다)", async () => {
    await ok("term", "new", "last", "--", "/bin/sh");
    const address = join(rig.home, ".ainecto/term/ctl.sock");
    const socket = await open(address);
    let received = "";
    let closed = false;
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      closed = true;
    });

    await ok("term", "kill", "last");
    await until(() => holderPids().length === 0, "holder left with the last session");
    // 바깥이 끝나기 시작했다 — 더는 새 연결을 받지 않는다(또는 이미 이 연결을 끊었다).
    await until(async () => closed || !(await accepts(address)), "outer stopping");

    socket.write(`${JSON.stringify({ id: "first", op: "ls" })}\n`);
    await until(() => closed, "outer closed the connection");
    const answer = JSON.parse(received.trim().split("\n")[0] || "null") as { id: string; ok: boolean; error?: { code: string } } | null;
    expect(answer).toMatchObject({ id: "first", ok: false, error: { code: RETRY_CODE } });
    await until(() => daemonPids().length === 0, "outer gone");
  }, LONG);
});
