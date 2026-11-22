import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { withFileLock, type FileLockOptions } from "../fs/fileLock";
import { isNodeError, writePrivateFileAtomic } from "../fs/privateFiles";
import { asPrivateJwk, asPublicJwk, type EcPrivateJwk, type EcPublicJwk } from "../term/e2e";
import { isEndpointAccount } from "./pcSettings";

/**
 * `~/.ainecto/pc-keys.json` — 원격 터미널 E2E 의 신뢰 한 곳(설계 terminal-e2e §4-1).
 *   계정 열쇠(`pc.json` 과 같은 `서버#userId` — pcSettings.accountKey)마다
 *   pcKey    — 이 PC·계정의 장기 서명 키(P-256 비공개 JWK). 서버에 보내지 않는다.
 *   browsers — PC 앞에서 코드로 짝지은 브라우저 공개키 목록. 다리는 시작할 때 이 파일을 읽는다.
 * 0600 · 통째로 바꿔 쓴다(pcSettings 와 같은 방식).
 * ★쓰기는 {@link updatePcKeys} 하나뿐 — `pc-keys.json.lock` 을 잡은 채 «읽기 → 바꾸기 → 원자적 교체»(§13-2). 늦게 저장된 사본이 지운 핀을 되살리지 않는다.
 */
export interface PairedBrowser {
  /** 공개키 지문(e2e.browserKeyIdOf — SHA-256 앞 16바이트 hex) — hello 의 browserKeyId. */
  keyId: string;
  publicJwk: EcPublicJwk;
  /** 사람이 보는 이름(짝짓기 때 정함) — `pair --list`·`pair --remove`·PC 알림에 쓴다. 이 목록 안에서 겹치지 않는다. */
  name: string;
  /** 짝지은 때(ISO). */
  pairedAt: string;
}

export interface PcKeyAccount {
  pcKey: EcPrivateJwk;
  browsers: PairedBrowser[];
  /**
   * `pair --remove` 가 핀은 지웠는데 PC 연결 끄기를 확인하지 못했을 때만 남는 표지(지운 때 ISO). 다시 실행하면 이름이 없어도
   * 끄기부터 마치고 지운다(설계 §13-2). 없으면 칸 없음.
   */
  pendingTurnOff?: { removedAt: string };
}

export interface PcKeys {
  accounts: Record<string, PcKeyAccount>;
}

/** 브라우저 이름 최대 글자 수(설계 §11-7 C-E6 — Ryan 11-21 승인 · 알림 한 줄). */
export const BROWSER_NAME_MAX = 40;
/** 이름이 비었을 때. */
const DEFAULT_BROWSER_NAME = "Browser";

export function pcKeysPath(home: string = homedir()): string {
  return join(home, ".ainecto", "pc-keys.json");
}

/** 읽은 값 → 키 목록(순수 함수). 모양이 틀린 계정·브라우저는 버린다(pcSettings 와 같다). */
export function normalizePcKeys(raw: unknown): PcKeys {
  const accounts: Record<string, PcKeyAccount> = {};
  const stored = raw && typeof raw === "object" ? (raw as Record<string, unknown>).accounts : undefined;
  if (stored && typeof stored === "object") {
    for (const [key, entry] of Object.entries(stored as Record<string, unknown>)) {
      const value = entry && typeof entry === "object" ? entry as Record<string, unknown> : undefined;
      const pcKey = asPrivateJwk(value?.pcKey);
      if (!pcKey) continue;
      const browsers = Array.isArray(value?.browsers) ? value.browsers.flatMap((item) => {
        const browser = asPairedBrowser(item);
        return browser ? [browser] : [];
      }) : [];
      const pending = value?.pendingTurnOff as { removedAt?: unknown } | undefined;
      accounts[key] = typeof pending?.removedAt === "string"
        ? { pcKey, browsers, pendingTurnOff: { removedAt: pending.removedAt } }
        : { pcKey, browsers };
    }
  }
  return { accounts };
}

function asPairedBrowser(raw: unknown): PairedBrowser | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const publicJwk = asPublicJwk(value.publicJwk);
  if (!publicJwk || typeof value.keyId !== "string" || value.keyId === "" || typeof value.name !== "string" || typeof value.pairedAt !== "string") {
    return undefined;
  }
  return { keyId: value.keyId, publicJwk, name: value.name, pairedAt: value.pairedAt };
}

/** 없으면 빈 목록(아직 쓰지 않는다). JSON 이 깨졌으면 오류 — 짝지은 키를 조용히 버리지 않는다. */
export async function loadPcKeys(path: string): Promise<PcKeys> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { accounts: {} };
    }
    throw error;
  }
  try {
    return normalizePcKeys(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Delete it to pair again.`);
  }
}

/**
 * 잠금 대기 5 s · 다시 보기 50 ms — 사용자 결재 2026-11-21 «이 값으로 승인 (추천)»(설계 §14-7 C-E10). 쓰기 하나는 수 ms 라, 이만큼 못 잡으면 다른 실행이 멈춰 있는 것이다.
 * 죽은 잠금(pid 가 없음)은 기다리지 않고 바로 치운다.
 */
const PC_KEYS_LOCK: FileLockOptions = { waitMs: 5_000, pollMs: 50 };

/**
 * 잠금 안에서 읽고 → change → 쓴다. change 가 undefined 를 돌려주면 쓰지 않는다(파일을 새로 만들지 않는다). 쓴 값(또는 읽은 값)을 돌려준다.
 * change 가 던지면 아무것도 쓰지 않고 잠금을 푼다.
 */
export async function updatePcKeys(path: string, change: (keys: PcKeys) => PcKeys | undefined | Promise<PcKeys | undefined>,
  lock: FileLockOptions = PC_KEYS_LOCK): Promise<PcKeys> {
  return await withFileLock(`${path}.lock`, lock, async (held) => {
    const current = await loadPcKeys(path);
    const next = await change(current);
    if (next === undefined) return current;
    // ★쓰기 직전에 잠금이 아직 내 것인지 — 회수가 겹쳐 잠금을 잃었으면 쓰지 않는다(§14-6 2).
    await held.assertHeld();
    await writePrivateFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

/** 브라우저가 보낸 이름 → 저장·표시할 이름(순수) — 개행·제어 문자 제거·앞뒤 공백·길이 상한(글자 단위), 비면 기본값. */
export function browserNameOf(raw: string): string {
  const cleaned = [...raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").trim()].slice(0, BROWSER_NAME_MAX).join("").trim();
  return cleaned === "" ? DEFAULT_BROWSER_NAME : cleaned;
}

/** 목록 안에서 겹치지 않는 이름 — 같은 keyId 는 제 이름을 그대로 쓴다. 겹치면 « (2)», « (3)»…. */
function uniqueName(browsers: readonly PairedBrowser[], wanted: string, keyId: string): string {
  const taken = new Set(browsers.filter((item) => item.keyId !== keyId).map((item) => item.name));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n += 1) {
    const candidate = `${wanted} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * 짝지은 브라우저를 넣는다(같은 keyId 는 바꿔 넣는다) — 계정이 없으면 pcKey 와 함께 만든다.
 * 계정이 있으면 그 pcKey 를 쓴다(부른 쪽이 그 키로 짝지었다).
 */
export function withBrowser(keys: PcKeys, account: string, pcKey: EcPrivateJwk, browser: PairedBrowser): PcKeys {
  const current = keys.accounts[account] ?? { pcKey, browsers: [] };
  const others = current.browsers.filter((item) => item.keyId !== browser.keyId);
  const added: PairedBrowser = { ...browser, name: uniqueName(others, browser.name, browser.keyId) };
  return { accounts: { ...keys.accounts, [account]: { pcKey: current.pcKey, browsers: [...others, added] } } };
}

/** keyId 또는 이름으로 지운다(keyId 가 먼저) — 없으면 removed 가 undefined(목록 그대로). */
export function withoutBrowser(keys: PcKeys, account: string, keyIdOrName: string): { keys: PcKeys; removed: PairedBrowser | undefined } {
  const current = keys.accounts[account];
  const removed = current?.browsers.find((item) => item.keyId === keyIdOrName) ?? current?.browsers.find((item) => item.name === keyIdOrName);
  if (!current || !removed) {
    return { keys, removed: undefined };
  }
  return {
    keys: { accounts: { ...keys.accounts, [account]: { ...current, browsers: current.browsers.filter((item) => item !== removed) } } },
    removed,
  };
}

/** 끄기 미완료 표지를 남기거나(at) 지운다(undefined) — 계정이 없으면 그대로. */
export function withPendingTurnOff(keys: PcKeys, account: string, at: Date | undefined): PcKeys {
  const current = keys.accounts[account];
  if (!current) return keys;
  const { pendingTurnOff: _previous, ...rest } = current;
  const next: PcKeyAccount = at ? { ...rest, pendingTurnOff: { removedAt: at.toISOString() } } : rest;
  return { accounts: { ...keys.accounts, [account]: next } };
}

/** 이 서버 주소의 키를 모두 지운다(`ainecto stop --forget`). */
export function withoutEndpointKeys(keys: PcKeys, endpoint: string): PcKeys {
  return { accounts: Object.fromEntries(Object.entries(keys.accounts).filter(([key]) => !isEndpointAccount(key, endpoint))) };
}
