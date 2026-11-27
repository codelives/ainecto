import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, readlink, rename, symlink, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { isNodeError, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "../fs/privateFiles";
import { TermError } from "./errors";

/**
 * 데몬 주소 — ★만들기·열기·증명이 한 곳(설계 windows-pc r3 3-1). 플랫폼마다 수단이 다른 것은 이 파일 안에 가둔다.
 *
 *   macOS·Linux : 주소 = 제어 소켓 파일 {@link TermPaths.socket}. 0700 폴더 안의 0600 소켓이 «이 OS 사용자만»을 보장한다(설계 2-4).
 *   Windows     : 주소 = named pipe. pipe 는 파일이 아니라서 폴더 권한이 지켜 주지 않고, 이름은 누구나 열거할 수 있다.
 *                 그래서 데몬마다 ① 무작위 pipe 이름 ② 무작위 비밀값을 만들어 주소 파일(0600 — 사용자 프로필 ACL)에 적고,
 *                 클라이언트는 nonce 를 보내 HMAC 증명을 확인한 «뒤에만» 요청(env 포함)을 보낸다. 강제 종료 뒤 남이 옛 이름을
 *                 다시 만들어도 비밀값을 몰라 증명하지 못한다 — 사칭 쪽이 받는 것은 nonce 하나뿐이다.
 * ★Unix 에 hello 를 넣지 않는 이유: 업그레이드 직후 떠 있는 옛 데몬이 hello 를 몰라 macOS·Linux 사용자가 끊긴다.
 */

/** pipe 이름의 무작위 길이(바이트) — 결재 2026-11-21(설계 7절 3). */
export const PIPE_NAME_BYTES = 16;
/** 증명 비밀값·nonce 길이(바이트) — 결재 2026-11-21(설계 7절 3). */
export const IPC_KEY_BYTES = 32;
/** HMAC 에 넣는 용도 문자열 — 이 키를 다른 용도의 서명과 섞지 않는다. 결재 2026-11-21(설계 7절 3). */
const PROOF_DOMAIN = "ainecto-term-ipc";
const PIPE_PREFIX = "\\\\.\\pipe\\ainecto-term-";

export interface IpcAddress {
  /** listen·connect 에 넘기는 값 — 소켓 경로 또는 `\\.\pipe\…`. */
  address: string;
  /** Windows 만 — 증명 비밀값. 있으면 클라이언트는 hello 증명부터 한다. */
  key?: Buffer;
}

/** 주소 파일이 없거나 읽을 수 없는 모양 — «데몬 없음»과 같게 다룬다(띄우는 데몬이 덮어쓴다). */
export const NO_ADDRESS_CODE = "TERM_IPC_NO_ADDRESS";
/** 그 주소에서 답한 쪽이 이 사용자의 데몬임을 증명하지 못했다 — 요청을 보내지 않았다. */
export const IMPOSTOR_CODE = "TERM_IPC_IMPOSTOR";

/**
 * 듣는 쪽(그 주소의 주인만 — holder 는 데몬 잠금, 바깥은 자기 uuid 주소) — 옛 주소를 치우고 이번 주소를 정한다. 이 뒤에 listen, 그 뒤 {@link afterListen}.
 * `file` = 주소 파일(paths.ts — holder·바깥마다 하나).
 */
export async function prepareListen(file: string, platform: NodeJS.Platform = process.platform): Promise<IpcAddress> {
  if (platform !== "win32") {
    // ★주소의 주인만 여기 온다 — 옛 세대의 소켓을 지워도 살아 있는 쪽의 소켓일 수 없다.
    await unlinkIfPresent(file);
    return { address: file };
  }
  const address = `${PIPE_PREFIX}${randomBytes(PIPE_NAME_BYTES).toString("hex")}`;
  const key = randomBytes(IPC_KEY_BYTES);
  await writePrivateFileAtomic(file, addressFileText({ address, key }));
  return { address, key };
}

/** listen 이 끝난 뒤 — Unix 소켓 파일을 0600 으로. Windows pipe 는 파일이 아니다(권한은 OS 기본 DACL). */
export async function afterListen(file: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== "win32") {
    await chmod(file, PRIVATE_FILE_MODE);
  }
}

/** 붙는 쪽 — 그 주소 파일의 주소. Windows 는 주소 파일을 읽는다(없음·깨짐 = {@link NO_ADDRESS_CODE}). */
export async function connectAddress(file: string, platform: NodeJS.Platform = process.platform): Promise<IpcAddress> {
  if (platform !== "win32") {
    return { address: file };
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new TermError(NO_ADDRESS_CODE, `No term daemon address at ${file}.`);
    }
    throw error;
  }
  const parsed = parseAddressFile(text);
  if (!parsed) {
    throw new TermError(NO_ADDRESS_CODE, `${file} is not a term daemon address; the next daemon rewrites it.`);
  }
  return parsed;
}

/**
 * 공용 주소(paths.socket — 구판 CLI 도 이 이름으로 붙는다)를 바깥 하나의 주소로 바꿔 단다(설계 3-4 «공용 주소는 포인터»).
 *   Unix    : 바깥 소켓을 가리키는 심볼릭 링크를 새로 만들어 rename 으로 바꿔 단다 — 연결은 링크를 따라간다.
 *   Windows : 바깥의 주소 파일 내용(pipe 이름·비밀값)을 공용 주소 파일에 원자적으로 바꿔 쓴다.
 * ★데몬 잠금을 쥔 holder 가 살아 있을 때만 부른다 — 그 동안 옛 구조 데몬은 공용 주소를 만들 수 없다.
 */
export async function pointTo(pointer: string, own: IpcAddress, ownFile: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") {
    await writePrivateFileAtomic(pointer, addressFileText(own));
    return;
  }
  const temp = `${pointer}.${process.pid}.link`;
  await unlinkIfPresent(temp);
  await symlink(basename(ownFile), temp);
  await rename(temp, pointer);
}

/** 공용 주소가 지금 이 바깥을 가리키는가 — 끝날 때 «내 포인터일 때만 지운다»의 판정(설계 3-4). */
export async function pointsTo(pointer: string, own: IpcAddress, ownFile: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    if (platform === "win32") return parseAddressFile(await readFile(pointer, "utf8"))?.address === own.address;
    return (await readlink(pointer)) === basename(ownFile);
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "EINVAL")) return false;
    throw error;
  }
}

function addressFileText(address: IpcAddress): string {
  return `${JSON.stringify({ pipe: address.address, key: address.key?.toString("base64") })}\n`;
}

/** 주소 파일 한 벌 → 주소·비밀값. 모양이 틀리면 undefined. 순수 함수. */
export function parseAddressFile(text: string): IpcAddress | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || !("pipe" in value) || !("key" in value)) return undefined;
  const { pipe, key } = value;
  if (typeof pipe !== "string" || !pipe.startsWith(PIPE_PREFIX) || typeof key !== "string") return undefined;
  const secret = Buffer.from(key, "base64");
  return secret.length === IPC_KEY_BYTES ? { address: pipe, key: secret } : undefined;
}

/** 클라이언트가 hello 에 싣는 nonce. */
export function newNonce(): string {
  return randomBytes(IPC_KEY_BYTES).toString("base64");
}

/** 데몬의 hello 답 — 주소·nonce 에 묶인 HMAC-SHA256(base64). 순수 함수. */
export function helloProof(key: Buffer, address: string, nonce: string): string {
  return createHmac("sha256", key).update(`${PROOF_DOMAIN}\n${address}\n${nonce}`).digest("base64");
}

/** 받은 증명이 맞는가 — 길이가 다르거나 문자열이 아니면 거짓. 순수 함수. */
export function proofMatches(key: Buffer, address: string, nonce: string, proof: unknown): boolean {
  if (typeof proof !== "string") return false;
  const want = Buffer.from(helloProof(key, address, nonce), "base64");
  const got = Buffer.from(proof, "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
}
