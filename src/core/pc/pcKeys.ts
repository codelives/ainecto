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
  /** 사람이 보는 이름(짝짓기 때 정함) — `pair --list`·`pair --remove`·PC 알림에 쓴다. 이 목록·끝나지 않은 철회의 이름과 겹치지 않는다. */
  name: string;
  /** 짝지은 때(ISO). */
  pairedAt: string;
}

export interface PcKeyAccount {
  pcKey: EcPrivateJwk;
  browsers: PairedBrowser[];
  /**
   * `pair --remove` 의 «끄기 미완료» 표지 — 핀 삭제와 같은 쓰기로 그 철회(지운 브라우저)를 남기고, 끄기 «전에» 끌 그룹을 더하고,
   * 끝나면 확인한 그룹과 자기 철회만 뺀다(그룹도 철회도 남지 않을 때만 표지가 없어진다). 짝짓기 저장은 이 칸을 그대로 둔다.
   * 다시 실행하면 핀이 없어도 그 철회가 남아 있으면 이 그룹들(데몬 목록에서 이미 빠졌어도)의 조회·소멸 확인부터 한다(설계 §13-2·§14-6 3). 없으면 칸 없음.
   */
  pendingTurnOff?: PendingTurnOff;
}

export interface PendingTurnOff {
  /** 핀을 지운 때(ISO). */
  removedAt: string;
  groups: PcGroup[];
  /**
   * 핀은 지웠지만 그룹 조회·끄기 확인을 아직 마치지 못한 철회 — 먼저 끝난 다른 철회가 표지를 지워도 이 철회의 재시도가 조회·종료로 다시 들어간다
   * (리뷰 impl-3 #1). 옛 표지(이 칸 없음)는 빈 목록으로 읽는다.
   */
  removals: PendingRemoval[];
}

/**
 * 끝나지 않은 철회 하나 — 지운 핀의 keyId·이름(다시 실행할 때 이것으로 찾는다)과 그 철회의 식별자.
 * removalId 는 핀을 지운 쓰기에서 새로 정하고, 재시도는 표지의 것을 이어받는다 — 끝날 때 이 값이 같은 항목만 뺀다.
 * 그래서 같은 keyId 를 다시 짝지어 새로 철회한 항목은 앞선 철회(의 늦은 재시도)가 끝나도 지워지지 않는다(리뷰 impl-5).
 */
export interface PendingRemoval {
  removalId: string;
  keyId: string;
  name: string;
}

/** 끌 PC 연결 하나 — 끄기 전에 읽은 그 세션의 pid 와 프로세스 그룹(pgid). */
export interface PcGroup {
  session: string;
  pid: number;
  pgid: number;
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
      const pending = value?.pendingTurnOff as { removedAt?: unknown; groups?: unknown; removals?: unknown } | undefined;
      accounts[key] = typeof pending?.removedAt === "string"
        ? { pcKey, browsers, pendingTurnOff: {
          removedAt: pending.removedAt,
          groups: Array.isArray(pending.groups) ? pending.groups.flatMap(asPcGroup) : [],
          removals: Array.isArray(pending.removals) ? pending.removals.flatMap(asPendingRemoval) : [],
        } }
        : { pcKey, browsers };
    }
  }
  return { accounts };
}

function asPcGroup(raw: unknown): PcGroup[] {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
  const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
  return value && typeof value.session === "string" && positive(value.pid) && positive(value.pgid)
    ? [{ session: value.session, pid: value.pid, pgid: value.pgid }]
    : [];
}

/**
 * 옛 항목(removalId 없음 — 2954f8d 모양)의 식별자는 그 keyId 로 읽는다: 읽는 쪽 모두가 같은 값을 얻으니 처음 쓰는 쪽이 굳혀도 겨룰 것이 없다.
 * 옛 표지는 keyId 마다 한 항목뿐이고, 새 식별자(randomUUID — 하이픈이 든다)는 keyId(16진수)와 겹치지 않는다.
 */
function asPendingRemoval(raw: unknown): PendingRemoval[] {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
  if (!value || typeof value.keyId !== "string" || value.keyId === "" || typeof value.name !== "string") return [];
  const removalId = typeof value.removalId === "string" && value.removalId !== "" ? value.removalId : value.keyId;
  return [{ removalId, keyId: value.keyId, name: value.name }];
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
  return await withFileLock(`${path}.lock`, lock, async () => {
    const current = await loadPcKeys(path);
    const next = await change(current);
    if (next === undefined) return current;
    // 잠금은 풀 때까지 내 것이다 — 살아 있는 잠금은 누구도 치우지 않는다(fileLock · §14-6 2).
    await writePrivateFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

/** 브라우저가 보낸 이름 → 저장·표시할 이름(순수) — 개행·제어 문자 제거·앞뒤 공백·길이 상한(글자 단위), 비면 기본값. */
export function browserNameOf(raw: string): string {
  const cleaned = [...raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").trim()].slice(0, BROWSER_NAME_MAX).join("").trim();
  return cleaned === "" ? DEFAULT_BROWSER_NAME : cleaned;
}

/**
 * 핀 목록과 끝나지 않은 철회 어디와도 겹치지 않는 이름 — 같은 keyId 는 제 이름을 그대로 쓴다. 겹치면 « (2)», « (3)»….
 * 철회 이름도 본다: 그 철회를 이름으로 다시 실행해도 새 핀을 지우지 않게(리뷰 impl-4 #1).
 */
function uniqueName(account: PcKeyAccount, wanted: string, keyId: string): string {
  const named = [...account.browsers, ...(account.pendingTurnOff?.removals ?? [])];
  const taken = new Set(named.filter((item) => item.keyId !== keyId).map((item) => item.name));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n += 1) {
    const candidate = `${wanted} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * 짝지은 브라우저를 넣는다(같은 keyId 는 바꿔 넣는다) — 계정이 없으면 pcKey 와 함께 만든다.
 * 계정이 있으면 그 pcKey 를 쓴다(부른 쪽이 그 키로 짝지었다). 그 계정의 다른 칸(끄기 미완료 표지)은 그대로 둔다.
 */
export function withBrowser(keys: PcKeys, account: string, pcKey: EcPrivateJwk, browser: PairedBrowser): PcKeys {
  const current = keys.accounts[account] ?? { pcKey, browsers: [] };
  const others = current.browsers.filter((item) => item.keyId !== browser.keyId);
  const added: PairedBrowser = { ...browser, name: uniqueName(current, browser.name, browser.keyId) };
  return { accounts: { ...keys.accounts, [account]: { ...current, browsers: [...others, added] } } };
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

/**
 * 끄기 미완료 표지에 그룹과 (핀을 지운 그 쓰기에서) 철회를 더한다(표지가 없으면 at 을 지운 때로 만든다 · 같은 pid·pgid·removalId 는 한 번).
 * 계정이 없거나 바뀔 것이 없으면 받은 값 그대로(같은 객체).
 */
export function withPendingTurnOff(keys: PcKeys, account: string,
  add: { at: Date; groups: readonly PcGroup[]; removal?: PendingRemoval }): PcKeys {
  const current = keys.accounts[account];
  if (!current) return keys;
  const { pendingTurnOff: previous, ...rest } = current;
  const known = previous?.groups ?? [];
  const fresh = add.groups.filter((group) => !known.some((item) => sameGroup(item, group)));
  const removals = previous?.removals ?? [];
  const removal = add.removal && !removals.some((item) => item.removalId === add.removal?.removalId) ? [add.removal] : [];
  if (previous && fresh.length === 0 && removal.length === 0) return keys;
  const pendingTurnOff: PendingTurnOff = {
    removedAt: previous?.removedAt ?? add.at.toISOString(), groups: [...known, ...fresh], removals: [...removals, ...removal],
  };
  return { accounts: { ...keys.accounts, [account]: { ...rest, pendingTurnOff } } };
}

/** 표지에 남은 «끝나지 않은 철회» 중 keyId 또는 이름이 맞는 것(keyId 가 먼저) — 핀이 없을 때 다시 실행할 대상(그 removalId 를 이어받는다). */
export function pendingRemovalOf(account: PcKeyAccount | undefined, keyIdOrName: string): PendingRemoval | undefined {
  const removals = account?.pendingTurnOff?.removals ?? [];
  return removals.find((item) => item.keyId === keyIdOrName) ?? removals.find((item) => item.name === keyIdOrName);
}

/**
 * 한 철회가 조회·끄기 확인을 마쳤다 — 확인한 그룹과 그 철회(removalId 가 같은 항목)만 표지에서 뺀다. 그사이 다른 철회가 더한 그룹·아직 끝나지 않은
 * 다른 철회(같은 keyId 를 다시 짝지어 새로 철회한 것 포함)는 남긴다. 그룹도 철회도 남지 않을 때만 표지를 없앤다.
 * 계정·표지가 없거나 바뀔 것이 없으면 받은 값 그대로(같은 객체).
 */
export function withTurnOffConfirmed(keys: PcKeys, account: string, done: { groups: readonly PcGroup[]; removalId: string }): PcKeys {
  const current = keys.accounts[account];
  if (!current?.pendingTurnOff) return keys;
  const { pendingTurnOff: previous, ...rest } = current;
  const groups = previous.groups.filter((group) => !done.groups.some((item) => sameGroup(item, group)));
  const removals = previous.removals.filter((item) => item.removalId !== done.removalId);
  if (groups.length === previous.groups.length && removals.length === previous.removals.length) return keys;
  const left = groups.length > 0 || removals.length > 0;
  return { accounts: { ...keys.accounts, [account]: left ? { ...rest, pendingTurnOff: { ...previous, groups, removals } } : rest } };
}

/** 같은 PC 연결 — pid·pgid 가 같다(세션 이름은 다시 쓰인다). */
function sameGroup(a: PcGroup, b: PcGroup): boolean {
  return a.pid === b.pid && a.pgid === b.pgid;
}

/** 이 서버 주소의 키를 모두 지운다(`ainecto stop --forget`). */
export function withoutEndpointKeys(keys: PcKeys, endpoint: string): PcKeys {
  return { accounts: Object.fromEntries(Object.entries(keys.accounts).filter(([key]) => !isEndpointAccount(key, endpoint))) };
}
