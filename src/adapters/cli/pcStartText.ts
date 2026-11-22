import { AGENT_CLIENT_LABELS } from "../../core/setup/agentConnections";
import type { DoctorCheck } from "../../core/setup/doctorChecks";

/**
 * `ainecto`(인자 없음) 기본 실행이 사람에게 보이는 글 — 처음 보는 사람이 알아들을 말로(Ryan 11-21 «처음 보는 사람이 알아들을 수 있어?»).
 * 순서: ①결과(이 PC 가 연결됐다 · 무엇에 쓰이나 · 창을 닫아도 돈다 · 끄는 법) → ②알릴 것. 내부 용어(세션 이름)는 싣지 않는다.
 * 점검 전체(직무 줄 포함)는 `ainecto doctor` 의 몫이다.
 */

/** 기본 실행에서 빼는 점검 — doctor 에만 둔다. */
const DOCTOR_ONLY = new Set(["AiNecto job title"]);
const NOT_CONNECTED = "not connected to AiNecto";
const STOP = "To stop it, run `ainecto stop`.";

/**
 * 점검 중 알릴 것만 — ok 는 빼고, 직무 줄은 doctor 로, 에이전트의 «이 컴퓨터 설정에 AiNecto 항목 없음»은 한 줄로 합친다.
 * ★판정 범위를 정직하게: 우리가 보는 것은 이 컴퓨터의 로컬 설정뿐이다 — claude.ai·ChatGPT 계정에 붙인 커넥터로 이미 쓰는 사람에게
 * «연결 안 됨»이라고 단정하지 않는다.
 */
export function preflightNotes(checks: readonly DoctorCheck[]): string[] {
  const agentLabels = new Set<string>(Object.values(AGENT_CLIENT_LABELS));
  const missing: string[] = [];
  const lines: string[] = [];
  for (const check of checks) {
    if (check.level === "ok" || DOCTOR_ONLY.has(check.item)) continue;
    if (agentLabels.has(check.item) && check.level === "warn" && check.detail === NOT_CONNECTED) {
      missing.push(check.item);
      continue;
    }
    lines.push(`${check.level === "fail" ? "✗" : "!"} ${check.item}: ${check.detail}${check.fix ? ` — fix: ${check.fix}` : ""}`);
  }
  if (missing.length > 0) {
    lines.unshift(`! To use AiNecto from ${listed(missing)} on this computer, run \`ainecto setup\` — `
      + `${missing.length === 1 ? "its" : "their"} settings here have no AiNecto entry yet `
      + "(a connector you added in your claude.ai or ChatGPT account is not checked here).");
  }
  return lines;
}

export type PcResult =
  | { kind: "connected"; agentMissing: boolean; log: string }
  | { kind: "connecting"; log: string }
  | { kind: "already"; folder: string; version: string; log: string };

/** 결과 한 단락 — 맨 위에 찍는다. */
export function pcResultText(result: PcResult): string {
  if (result.kind === "connecting") {
    return `Still connecting this PC to AiNecto — run \`ainecto status\` to see when it is up. Log: ${result.log}`;
  }
  if (result.kind === "already") {
    return `This PC is already connected to AiNecto (folder ${result.folder}, version ${result.version}). ${STOP} Log: ${result.log}`;
  }
  const use = result.agentMissing
    ? "From AiNecto on the web you can open a terminal on this PC and run commands. No Claude Code or Codex was found, "
      + "so AiNecto agent work cannot run here yet — install one, then run `ainecto` again."
    : "From AiNecto on the web you can open a terminal on this PC and run commands, and your AiNecto agent can run work here "
      + "(Claude Code or Codex).";
  return `This PC is now connected to AiNecto. ${use} It keeps running after you close this window. ${STOP} Log: ${result.log}`;
}

function listed(labels: readonly string[]): string {
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
