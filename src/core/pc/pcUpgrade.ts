/**
 * PC 연결 자동 업그레이드 — 순수 함수(KAN-738 next.10, 계획 auto-upgrade-plan.md 3절).
 * 서버(api)는 npm dist-tags 를 원격 다리 open·poll 응답의 {@code cli: {next, latest}} 로 내려 줄 뿐 — 채널·비교는 여기 한 곳.
 */

/** 서버가 내려 준 npm 꼬리표(있는 것만). */
export interface CliTags {
  next?: string;
  latest?: string;
}

export type ReleaseChannel = "next" | "latest";

const STABLE = /^\d+\.\d+\.\d+$/;
const NEXT = /^\d+\.\d+\.\d+-next\.\d+(\.\d+)*$/;

/**
 * 이 판의 채널 — `x.y.z-next.N…` → next, `x.y.z` → latest, 그 밖(`dev`·로컬 빌드)은 없음.
 * ★게시판이 아니면({@code release} 거짓 — 로컬 빌드) 늘 없음: 로컬 빌드는 절대 갈아타지 않는다.
 */
export function releaseChannel(version: string, release: boolean): ReleaseChannel | undefined {
  if (!release) return undefined;
  if (NEXT.test(version)) return "next";
  if (STABLE.test(version)) return "latest";
  return undefined;
}

/**
 * 갈아탈 판 — 받은 꼬리표 중 내 채널의 판이 있고 지금 판과 «다르면» 그 판(꼬리표를 옛 판으로 되돌린 경우도 따른다 — 잘못 낸 판의 수습).
 * 이미 해 보았거나(이 프로세스) 건너뛰라고 받은 판이면 없음.
 */
export function upgradeTarget(input: {
  current: string;
  release: boolean;
  tags: CliTags | undefined;
  tried: ReadonlySet<string>;
}): string | undefined {
  const channel = releaseChannel(input.current, input.release);
  const target = channel ? input.tags?.[channel] : undefined;
  return target !== undefined && target !== input.current && !input.tried.has(target) ? target : undefined;
}

/** 한가한가 — Agent 할 일이 없고(돌고 있거나 줄에 선 것 0) 웹이 보는 세션이 0개. 다리만 돌면 Agent 는 늘 한가. */
export function pcIdle(input: { agentBusy: boolean; watching: number }): boolean {
  return !input.agentBusy && input.watching === 0;
}

/** open·poll 응답의 cli 칸 — 모르는 모양이면 undefined(옛 서버·아직 모름). */
export function cliTagsOf(value: unknown): CliTags | undefined {
  if (!value || typeof value !== "object") return undefined;
  const next = "next" in value && typeof value.next === "string" && value.next !== "" ? value.next : undefined;
  const latest = "latest" in value && typeof value.latest === "string" && value.latest !== "" ? value.latest : undefined;
  return next === undefined && latest === undefined ? undefined : { ...(next ? { next } : {}), ...(latest ? { latest } : {}) };
}

/** `ainecto --version` 출력이 그 판인가(`{"version": "…"}` 또는 판 글자 하나). */
export function reportsVersion(stdout: string, version: string): boolean {
  const text = stdout.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "version" in parsed) return parsed.version === version;
  } catch {
    // JSON 이 아니면 글자 하나로 본다.
  }
  return text === version;
}

/** `npm audit signatures` 가 통과했고 증명이 «verified»로 확인됐나(종료 0 + 그 문장). */
export function auditPassed(exitCode: number | null, output: string): boolean {
  return exitCode === 0 && /\bverified attestations?\b/.test(output);
}

/** 출처 증명의 빌드 workflow — 이 저장소의 이 파일에서 만든 판인가를 견준다. */
export interface ProvenanceWorkflow {
  repository: string;
  path: string;
}

/**
 * registry 증명 묶음(`dist.attestations.url` 의 본문) → SLSA provenance 의 workflow(repository·path). 그 판({@code name}@{@code version})의
 * 증명이 아니거나 모양이 다르면 undefined. bundle.dsseEnvelope.payload(base64) → predicate.buildDefinition.externalParameters.workflow.
 */
export function provenanceWorkflow(body: unknown, name: string, version: string): ProvenanceWorkflow | undefined {
  const subject = `pkg:npm/${encodeURIComponent(name).replace("%2F", "/")}@${version}`;
  const attestations = record(body)?.attestations;
  if (!Array.isArray(attestations)) return undefined;
  for (const item of attestations) {
    const payload = record(record(record(item)?.bundle)?.dsseEnvelope)?.payload;
    if (typeof payload !== "string") continue;
    let statement: unknown;
    try {
      statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    } catch {
      continue;
    }
    const subjects = record(statement)?.subject;
    const forThis = Array.isArray(subjects) && subjects.some((s) => record(s)?.name === subject);
    const workflow = record(record(record(record(statement)?.predicate)?.buildDefinition)?.externalParameters)?.workflow;
    const repository = record(workflow)?.repository;
    const path = record(workflow)?.path;
    if (forThis && typeof repository === "string" && typeof path === "string") return { repository, path };
  }
  return undefined;
}

export function sameWorkflow(a: ProvenanceWorkflow, b: ProvenanceWorkflow): boolean {
  return a.repository === b.repository && a.path === b.path;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}
