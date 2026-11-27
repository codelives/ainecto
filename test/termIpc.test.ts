import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectAddress,
  helloProof,
  IPC_KEY_BYTES,
  NO_ADDRESS_CODE,
  parseAddressFile,
  prepareListen,
  proofMatches,
} from "../src/core/term/ipc";
import { termPaths } from "../src/core/term/paths";
import { parseClientMessage } from "../src/core/term/protocol";

/**
 * 데몬 주소(설계 windows-pc r3 3-1) — 이 맥에서 돌릴 수 있는 부분: 주소 파일 쓰기·읽기·모양 검사·증명.
 * named pipe 실물(listen·connect·사칭)은 test/windows/ 가 Windows CI 에서 본다.
 */
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "aterm-ipc-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("주소 — Unix 는 소켓 파일 그대로, Windows 는 주소 파일", () => {
  it("이름: macOS·Linux ctl.sock · Windows ctl.pipe(같은 폴더)", () => {
    expect(termPaths(home, "darwin").socket).toBe(join(home, ".ainecto", "term", "ctl.sock"));
    expect(termPaths(home, "linux").socket).toBe(join(home, ".ainecto", "term", "ctl.sock"));
    expect(termPaths(home, "win32").socket).toBe(join(home, ".ainecto", "term", "ctl.pipe"));
  });

  it("Unix: 붙을 주소 = 소켓 경로, 비밀값 없음(hello 를 보내지 않는다)", async () => {
    const paths = termPaths(home, "darwin");
    expect(await connectAddress(paths.socket, "darwin")).toEqual({ address: paths.socket });
  });

  it("Windows: 데몬이 쓴 주소 파일을 클라이언트가 그대로 읽는다 — 무작위 pipe 이름 · 32바이트 비밀값 · 0600", async () => {
    const paths = termPaths(home, "win32");
    await mkdir(paths.dir, { recursive: true });
    const first = await prepareListen(paths.socket, "win32");
    expect(first.address).toMatch(/^\\\\\.\\pipe\\ainecto-term-[0-9a-f]{32}$/);
    expect(first.key?.length).toBe(IPC_KEY_BYTES);
    expect(await connectAddress(paths.socket, "win32")).toEqual(first);
    // 데몬마다 새로 — 옛 이름·옛 비밀값을 다시 쓰지 않는다.
    const second = await prepareListen(paths.socket, "win32");
    expect(second.address).not.toBe(first.address);
    expect(second.key?.equals(first.key ?? Buffer.alloc(0))).toBe(false);
    expect(await connectAddress(paths.socket, "win32")).toEqual(second);
    expect(JSON.parse(await readFile(paths.socket, "utf8"))).toEqual({ pipe: second.address, key: second.key?.toString("base64") });
  });

  it("Windows: 주소 파일 없음·깨짐 → NO_ADDRESS(«데몬 없음»과 같게 — 다음 데몬이 덮어쓴다)", async () => {
    const paths = termPaths(home, "win32");
    await expect(connectAddress(paths.socket, "win32")).rejects.toMatchObject({ code: NO_ADDRESS_CODE });
    await mkdir(paths.dir, { recursive: true });
    for (const bad of ["", "{", "{}", '{"pipe":"\\\\\\\\.\\\\pipe\\\\other","key":"AAAA"}', JSON.stringify({ pipe: "\\\\.\\pipe\\ainecto-term-ab", key: "c2hvcnQ=" })]) {
      await writeFile(paths.socket, bad);
      await expect(connectAddress(paths.socket, "win32"), bad).rejects.toMatchObject({ code: NO_ADDRESS_CODE });
    }
    expect(parseAddressFile(JSON.stringify({ pipe: "\\\\.\\pipe\\ainecto-term-ab", key: Buffer.alloc(IPC_KEY_BYTES, 1).toString("base64") }))).toBeDefined();
  });
});

describe("hello 증명 — 비밀값을 모르면 만들 수 없다", () => {
  const key = Buffer.alloc(IPC_KEY_BYTES, 7);
  const address = "\\\\.\\pipe\\ainecto-term-00";

  it("같은 비밀값·주소·nonce 면 맞고, 하나라도 다르면 틀린다", () => {
    const proof = helloProof(key, address, "n1");
    expect(proofMatches(key, address, "n1", proof)).toBe(true);
    expect(proofMatches(Buffer.alloc(IPC_KEY_BYTES, 8), address, "n1", proof)).toBe(false);
    expect(proofMatches(key, `${address}x`, "n1", proof)).toBe(false);
    expect(proofMatches(key, address, "n2", proof)).toBe(false);
  });

  it("모양이 틀린 답(없음·숫자·짧은 값)은 예외 없이 거짓", () => {
    for (const bad of [undefined, null, 42, "", "AAAA", {}]) {
      expect(proofMatches(key, address, "n1", bad)).toBe(false);
    }
  });

  it("프로토콜: hello 는 nonce 만 싣는다", () => {
    expect(parseClientMessage('{"op":"hello","id":"1","nonce":"abc"}')).toEqual({ op: "hello", id: "1", nonce: "abc" });
    expect(() => parseClientMessage('{"op":"hello","id":"1"}')).toThrow(/nonce/);
  });
});
