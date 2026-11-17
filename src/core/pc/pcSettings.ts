import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isNodeError, writePrivateFileAtomic } from "../fs/privateFiles";

/**
 * `~/.ainecto/pc.json` — ★이 PC 단위 사실의 한 곳(사용자 확인 2026-11-17, root REQ b1f76f76·d37a6dc2).
 *   pcId      — 이 PC 의 식별자(다음 판의 원격 다리가 «같은 PC» 판정에 쓴다). hostName 이 다르면(설정 폴더를 다른 기기로 복사) 새로 만든다.
 *   accounts  — 계정(서버 주소 + userId)마다 첫 실행 동의와 원격 터미널 허용. 계정·서버가 바뀌면 다시 묻는다.
 * 0600 · 통째로 바꿔 쓴다. 토큰·이메일은 넣지 않는다.
 */
export interface PcAccount {
  /** 동의한 때(ISO). */
  consentedAt: string;
  /** 웹에서 이 PC 의 터미널을 열고 명령을 실행하는 것을 허용하나. */
  remoteTerminal: boolean;
}

export interface PcSettings {
  pcId: string;
  hostName: string;
  accounts: Record<string, PcAccount>;
}

export function pcSettingsPath(home: string = homedir()): string {
  return join(home, ".ainecto", "pc.json");
}

/** 계정 열쇠 — 서버 주소 + userId. */
export function accountKey(endpoint: string, userId: string): string {
  return `${endpoint}#${userId}`;
}

/**
 * 읽은 값 → 설정(순수 함수). 모양이 틀렸거나 hostName 이 다르면 새 pcId 의 빈 설정 — 다른 기기에서 복사된 동의를 쓰지 않는다.
 */
export function normalizePcSettings(raw: unknown, hostName: string, newId: () => string = randomUUID): PcSettings {
  const fresh: PcSettings = { pcId: newId(), hostName, accounts: {} };
  if (!raw || typeof raw !== "object") {
    return fresh;
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.pcId !== "string" || value.pcId === "" || value.hostName !== hostName) {
    return fresh;
  }
  const accounts: Record<string, PcAccount> = {};
  if (value.accounts && typeof value.accounts === "object") {
    for (const [key, entry] of Object.entries(value.accounts as Record<string, unknown>)) {
      const account = entry as Partial<PcAccount> | null;
      if (account && typeof account.consentedAt === "string" && typeof account.remoteTerminal === "boolean") {
        accounts[key] = { consentedAt: account.consentedAt, remoteTerminal: account.remoteTerminal };
      }
    }
  }
  return { pcId: value.pcId, hostName, accounts };
}

/** 없으면 새 설정(아직 쓰지 않는다). JSON 이 깨졌으면 오류 — 동의 기록을 조용히 버리지 않는다. */
export async function loadPcSettings(path: string, hostName: string): Promise<PcSettings> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return normalizePcSettings(undefined, hostName);
    }
    throw error;
  }
  try {
    return normalizePcSettings(JSON.parse(raw), hostName);
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Delete it to start over.`);
  }
}

export async function savePcSettings(path: string, settings: PcSettings): Promise<void> {
  await writePrivateFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export function withConsent(settings: PcSettings, key: string, remoteTerminal: boolean, now: Date): PcSettings {
  return { ...settings, accounts: { ...settings.accounts, [key]: { consentedAt: now.toISOString(), remoteTerminal } } };
}

/** 동의한 계정만 바꾼다 — 없으면 undefined(먼저 동의해야 한다). */
export function withRemoteTerminal(settings: PcSettings, key: string, remoteTerminal: boolean): PcSettings | undefined {
  const account = settings.accounts[key];
  return account ? { ...settings, accounts: { ...settings.accounts, [key]: { ...account, remoteTerminal } } } : undefined;
}

/** 이 서버 주소의 동의를 모두 지운다(`ainecto stop --forget`) — 로그인 없이도 된다. */
export function withoutEndpoint(settings: PcSettings, endpoint: string): PcSettings {
  const prefix = `${endpoint}#`;
  return { ...settings, accounts: Object.fromEntries(Object.entries(settings.accounts).filter(([key]) => !key.startsWith(prefix))) };
}
