import { randomUUID } from "node:crypto";
import type { DaemonLog } from "../term/daemonLog";
import type { AgentAdapter, AgentAuthMode, AgentId } from "./agents";
import type { AgentLogRecord } from "./log";

export interface AgentCheck {
  id: AgentId;
  installed: boolean;
  ready: boolean;
  /** 무엇으로 도는가(과금 주체) — 로그인이 확인됐을 때만. */
  auth?: AgentAuthMode;
  version?: string;
  /** 설치·준비가 안 된 이유(안내 글에 쓴다). */
  detail?: string;
}

/**
 * serve 시작 때 Agent 마다 설치 감지 → (설치됐으면) 인증 확인. ★모델 호출 0. 확인마다 {@code agent_probe} 1줄 + {@code agent_probe_response} 1줄.
 * 확인이 던져도 그 Agent 만 «준비 안 됨»으로 두고 나머지는 계속한다.
 */
export async function checkAgents(adapters: readonly AgentAdapter[], log: DaemonLog<AgentLogRecord>): Promise<AgentCheck[]> {
  return await Promise.all(adapters.map(async (adapter): Promise<AgentCheck> => {
    const detected = await probe(log, adapter.id, "detect", () => adapter.detect(),
      (d) => ({ installed: d.installed, version: d.version, detail: d.detail }));
    if (!detected?.installed) {
      return { id: adapter.id, installed: false, ready: false, detail: detected?.detail };
    }
    const auth = await probe(log, adapter.id, "auth", () => adapter.authStatus(),
      (a) => ({ ready: a.ready, mode: a.mode, method: a.method, plan: a.plan, detail: a.detail }));
    return {
      id: adapter.id,
      installed: true,
      version: detected.version,
      ready: auth?.ready === true,
      auth: auth?.ready === true ? auth.mode : undefined,
      detail: auth?.detail,
    };
  }));
}

/**
 * serve 시작 때 Agent 마다 사람이 보는 한 줄 — 준비됨(누가 내나) · 설치됐지만 로그인 안 됨 · ★이 PC 에서 못 찾음(이유 — ENOENT·timed out·exit N).
 * 못 찾음 줄이 없으면 Connect 에서 «현재 사용할 수 없음»만 보여 왜인지 알 길이 없었다(KAN-1613 — Terminal 에서는 되는데 Connect 는 미연결).
 * 순수 함수 — {@code billedTo} = API 키 모드의 과금처(Anthropic·OpenAI·Google).
 */
export function agentStartLine(check: AgentCheck, name: string, billedTo: string): string {
  const reconnect = "(`ainecto stop`, then `ainecto start`)";
  if (!check.installed) {
    return `${name} was not found on this PC${check.detail ? ` (${check.detail})` : ""}. To use it from AiNecto, install it `
      + `where this PC's \`ainecto\` can run it, sign in, then reconnect this PC ${reconnect}.`;
  }
  if (check.ready) {
    return check.auth === "apiKey"
      ? `${name}: runs on your own API key (billed to your ${billedTo} API account; AiNecto credits are not used).`
      : `${name}: runs on your subscription login (uses your plan's limits; AiNecto credits are not used).`;
  }
  return `${name} is installed but not signed in${check.detail ? ` (${check.detail})` : ""}. `
    + `Requests to ${name} will be refused until you sign in and reconnect this PC ${reconnect}.`;
}

/** open 본문의 {@code agents} — 설치된 Agent 만. */
export function openAgents(checks: readonly AgentCheck[]): Array<{ id: AgentId; ready: boolean; auth?: AgentAuthMode }> {
  return checks.filter((check) => check.installed)
    .map((check) => ({ id: check.id, ready: check.ready, ...(check.auth ? { auth: check.auth } : {}) }));
}

async function probe<T>(
  log: DaemonLog<AgentLogRecord>,
  agent: AgentId,
  kind: "detect" | "auth",
  work: () => Promise<T>,
  summary: (value: T) => Omit<Extract<AgentLogRecord, { event: "agent_probe_response" }>, "event" | "callId" | "agent" | "probe" | "ok" | "ms">,
): Promise<T | undefined> {
  const callId = randomUUID();
  const started = Date.now();
  log.write({ event: "agent_probe", callId, agent, probe: kind });
  try {
    const value = await work();
    log.write({ event: "agent_probe_response", callId, agent, probe: kind, ok: true, ...summary(value), ms: Date.now() - started });
    return value;
  } catch (error) {
    log.write({ event: "agent_probe_response", callId, agent, probe: kind, ok: false,
      detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
    return undefined;
  }
}
