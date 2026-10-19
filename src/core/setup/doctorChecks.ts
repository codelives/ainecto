import { profileSettingsUrl } from "../config/endpoints";
import { SERVER_NAME } from "../harness/agentTargets";
import { AGENT_CLIENT_LABELS, type AgentState } from "./agentConnections";
import type { MachineStatus } from "./machineStatus";

/**
 * doctor 의 판정 — ★{@link MachineStatus} 만 보는 순수 함수. 항목마다 ok / warn / fail + 고칠 명령 한 줄.
 *
 * <p>고치는 길은 {@code ainecto setup}·{@code ainecto init} 재실행 둘뿐이다(설계 §4-4, 두 방식 금지) —
 * {@code --fix} 는 없다. fail 이 하나라도 있으면 doctor 는 종료 1. 직무 미설정은 warn(실패 아님).
 */
export type CheckLevel = "ok" | "warn" | "fail";

export interface DoctorCheck {
  item: string;
  level: CheckLevel;
  detail: string;
  /** 고칠 명령(또는 할 일) 한 줄. */
  fix?: string;
}

export function doctorChecks(status: MachineStatus): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const settings = profileSettingsUrl(status.endpoint);

  // ── 로그인 ──
  if (status.token.state === "not-signed-in") {
    checks.push({ item: "sign-in", level: "fail", detail: `not signed in to ${status.endpoint}`, fix: "ainecto setup" });
  } else if (status.token.state === "refresh-failed") {
    checks.push({ item: "sign-in", level: "fail", detail: `sign-in expired and could not be renewed (${status.token.reason})`, fix: "ainecto setup" });
  } else {
    checks.push({ item: "sign-in", level: "ok", detail: status.token.state === "env" ? "AINECTO_TOKEN" : "signed in" });
  }

  // ── 서버 ──
  const problem = status.account?.problem;
  if (problem?.kind === "network") {
    checks.push({ item: "server", level: "fail", detail: `cannot reach ${status.endpoint} (${problem.message})`, fix: "check the network, or the --endpoint you passed" });
  } else if (problem?.kind === "unauthorized") {
    checks.push({ item: "server", level: "fail", detail: `${status.endpoint} refused the sign-in (HTTP 401)`, fix: "ainecto auth login" });
  } else if (problem?.kind === "forbidden") {
    checks.push({ item: "server", level: "fail", detail: "the account's plan does not include MCP, or the account is not active (HTTP 403)", fix: `check your plan at ${settings}` });
  } else if (problem) {
    checks.push({ item: "server", level: "fail", detail: problem.message });
  } else if (status.account) {
    checks.push({ item: "server", level: "ok", detail: `${status.endpoint} answered; ${status.account.projectCount ?? 0} project(s) visible` });
  }

  // ── 에이전트 연결 ──
  for (const agent of status.agents) {
    checks.push(agentCheck(agent, status.cliVersion));
  }
  if (status.claudeHere?.entry && status.claudeHere.scope === "local") {
    const hereOursUpToDate = status.claudeHere.ours && !status.claudeHere.carriesRole;
    if (!hereOursUpToDate) {
      checks.push({
        item: "Claude Code (this folder)",
        level: "warn",
        detail: `a local-scope "${SERVER_NAME}" entry in this folder hides the user-scope connection`,
        fix: `claude mcp remove ${SERVER_NAME} -s local`,
      });
    }
  }

  // ── 이 저장소 ──
  const repo = status.repository;
  if (repo?.problem) {
    checks.push({ item: "repository", level: "warn", detail: repo.problem });
  } else if (repo) {
    const leftovers = [
      ...repo.mcpFiles.filter((file) => file.ours && file.carriesRole).map((file) => `${file.path} passes the removed --role`),
      ...repo.mcpFiles.filter((file) => file.ours && olderThan(file.pinnedVersion, status.cliVersion))
        .map((file) => `${file.path} pins @ainecto/mcp@${file.pinnedVersion}`),
      ...(repo.configHasProject ? [".ainecto/config.json still has the old project field"] : []),
    ];
    if (leftovers.length > 0) {
      checks.push({ item: "repository", level: "warn", detail: leftovers.join("; "), fix: `ainecto init (in ${repo.root})` });
    } else {
      checks.push({
        item: "repository",
        level: "ok",
        detail: repo.harnessDoc
          ? `AiNecto rules are set up in ${repo.root}`
          : `no AiNecto rules in ${repo.root} (optional — \`ainecto init\` adds them)`,
      });
    }
  }

  // ── 옛 설정 잔존 ──
  for (const name of status.legacyEnv) {
    checks.push({ item: name, level: "warn", detail: `${name} is set; roles were removed and it is ignored`, fix: `unset ${name} (it can be deleted)` });
  }
  if (status.legacyCodexProfiles.length > 0) {
    checks.push({
      item: "Codex role profiles",
      level: "warn",
      detail: `these Codex profiles still pass --role: ${status.legacyCodexProfiles.join(", ")}`,
      fix: "delete them — `ainecto setup` connects Codex for every session",
    });
  }
  if (status.globalCliVersion && olderThan(status.globalCliVersion, status.cliVersion)) {
    checks.push({
      item: "global ainecto",
      level: "warn",
      detail: `the ainecto on your PATH is ${status.globalCliVersion}, older than ${status.cliVersion}`,
      fix: "npm i -g ainecto@latest",
    });
  }

  // ── 직무 ──
  if (status.account?.jobTitle === null) {
    checks.push({ item: "AiNecto job title", level: "warn", detail: "not set — AI uses it to pitch explanations; it does not change permissions", fix: `set it at ${settings}` });
  } else if (typeof status.account?.jobTitle === "string") {
    checks.push({ item: "AiNecto job title", level: "ok", detail: status.account.jobTitle });
  }
  return checks;
}

function agentCheck(agent: AgentState, cliVersion: string): DoctorCheck {
  const item = AGENT_CLIENT_LABELS[agent.client];
  if (!agent.installed) {
    return { item, level: "ok", detail: "not installed" };
  }
  if (agent.problem) {
    return { item, level: "fail", detail: agent.problem, fix: "ainecto setup" };
  }
  if (!agent.entry) {
    return { item, level: "warn", detail: "not connected to AiNecto", fix: "ainecto setup" };
  }
  if (!agent.ours) {
    return {
      item,
      level: "warn",
      detail: `someone else's "${SERVER_NAME}" entry${agent.scope ? ` (${agent.scope})` : ""} — AiNecto setup leaves it alone`,
      fix: agent.client === "claude-code" ? `claude mcp get ${SERVER_NAME}` : "keep it, or remove it and run `ainecto setup`",
    };
  }
  if (agent.client === "claude-code" && agent.scope !== "user") {
    return { item, level: "warn", detail: `connected in the ${agent.scope} scope, not for every project`, fix: "ainecto setup" };
  }
  if (agent.carriesRole) {
    return { item, level: "warn", detail: "connected, but still passes the removed --role", fix: "ainecto setup" };
  }
  if (olderThan(agent.pinnedVersion, cliVersion)) {
    return { item, level: "warn", detail: `connected with @ainecto/mcp@${agent.pinnedVersion}; ${cliVersion} is available`, fix: "ainecto setup" };
  }
  return { item, level: "ok", detail: agent.pinnedVersion ? `connected (@ainecto/mcp@${agent.pinnedVersion})` : "connected" };
}

/** a 가 b 보다 낮은 판인가(x.y.z 숫자 비교). 둘 중 하나라도 판이 아니면(dev 등) false — 판정하지 않는다. */
export function olderThan(a: string | undefined, b: string): boolean {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return false;
  }
  for (let at = 0; at < 3; at += 1) {
    if (left[at]! !== right[at]!) {
      return left[at]! < right[at]!;
    }
  }
  return false;
}

function parseVersion(value: string | undefined): [number, number, number] | undefined {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
