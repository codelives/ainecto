import { readFileSync } from "node:fs";
import { isNodeError } from "../fs/privateFiles";
import { stuckProcessHint } from "../os/launch";
import type { TermPaths } from "./paths";

/**
 * 상주 프로세스가 남긴 안내용 파일 읽기 — ★«멈춘 데몬» 오류 문구에 pid 를 대는 데만 쓴다.
 *   판·구조 판정은 살아 있는 상대에게 묻는다(세션 유지 구조 G4 — client.daemonCaps). 파일이 없거나 깨졌으면 안내를 건너뛸 뿐이다.
 *   holder.json — holder 가 쓴다(holder.HolderInfo: 자기 pid · 임대를 쥔 바깥의 pid).
 *   daemon.json — 옛 구조 데몬(0.16.x)이 쓴 것. 새 구조는 쓰지 않는다.
 */

/** holder.json → holder pid · 임대 바깥 pid. */
export function readHolderInfo(paths: TermPaths): { pid: number; outerPid?: number } | undefined {
  const value = readJson(paths.holderInfo);
  if (typeof value?.pid !== "number") return undefined;
  const outer = value.outer;
  const outerPid = outer && typeof outer === "object" ? (outer as Record<string, unknown>).pid : undefined;
  return { pid: value.pid, ...(typeof outerPid === "number" ? { outerPid } : {}) };
}

/** daemon.json(옛 구조) → pid·판. */
export function readDaemonInfo(paths: TermPaths): { pid: number; version?: string } | undefined {
  const value = readJson(paths.daemonInfo);
  if (typeof value?.pid !== "number") return undefined;
  return { pid: value.pid, ...(typeof value.version === "string" ? { version: value.version } : {}) };
}

/** 살아 있는 바깥·holder pid(holder.json) — 둘 다 없으면 undefined. */
export function residentPids(paths: TermPaths): { outer?: number; holder?: number } | undefined {
  const info = readHolderInfo(paths);
  const outer = info?.outerPid !== undefined && isAlive(info.outerPid) ? info.outerPid : undefined;
  const holder = info && isAlive(info.pid) ? info.pid : undefined;
  return outer === undefined && holder === undefined ? undefined : { ...(outer !== undefined ? { outer } : {}), ...(holder !== undefined ? { holder } : {}) };
}

/** 「 (pid A; holder pid B)」 + 멈춤 안내 — 문구의 두 자리. 살아 있는 것이 없으면 둘 다 빈 문자열. */
export function residentHint(paths: TermPaths): { label: string; hint: string } {
  const pids = residentPids(paths);
  if (!pids) return { label: "", hint: "" };
  const parts = [...(pids.outer !== undefined ? [`pid ${pids.outer}`] : []), ...(pids.holder !== undefined ? [`holder pid ${pids.holder}`] : [])];
  const hint = [pids.outer, pids.holder].filter((pid): pid is number => pid !== undefined).map((pid) => stuckProcessHint(pid)).join(" ");
  return { label: ` (${parts.join("; ")})`, hint: `${hint} ` };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 살아 있지만 남의 프로세스(같은 사용자 폴더라 드물다).
    return isNodeError(error, "EPERM");
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    // 안내 재료가 없을 뿐이다 — 오류 자체는 부른 쪽이 낸다.
    return undefined;
  }
}
