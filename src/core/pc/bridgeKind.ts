import type { SessionKind } from "../term/protocol";

/** «이 PC 연결» 세션 이름 — 브리지를 띄우는 곳(pcCommand.startPcSession)은 늘 이 이름으로 만든다. */
export const PC_SESSION_NAME = "ainecto-pc";

/**
 * 세션 종류 판정 ★한 곳(설계 term-ledger-cli-unit-prep 2-1 · G1) — 업로드 필터·runningPcs·daemonUpgrade 사용자 세션 수가 모두 이것을 본다.
 *   kind 칸이 있으면(만들 때 찍힘) → 그 값.
 *   없으면(옛 CLI 가 만들었거나 옛 매니페스트에서 되살린 세션) → 이름이 {@link PC_SESSION_NAME} 이고 명령이 `pc run` 일 때만 pc-bridge.
 *   ★두 조건 모두 — 이름이 다른 사용자 작업(`node tasks.js pc run`)이나 이름만 같은 사용자 셸을 브리지로 보지 않는다.
 * 옛 줄 분기는 holder 첫 전환(옛 세션이 닫힘)에서 지운다.
 */
export function bridgeKind(row: { name: string; command: readonly string[] | null; kind?: SessionKind }): SessionKind {
  if (row.kind !== undefined) return row.kind;
  return row.name === PC_SESSION_NAME && isPcCommand(row.command) ? "pc-bridge" : "user";
}

function isPcCommand(command: readonly string[] | null): boolean {
  return Array.isArray(command) && command.some((word, index) => word === "pc" && command[index + 1] === "run");
}
