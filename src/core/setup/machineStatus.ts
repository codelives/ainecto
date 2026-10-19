import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TokenStore } from "../auth/tokenStore";
import type { McpRpcClient } from "../mcp/rpcClient";
import { AGENT_TARGETS, entryCarriesRole, isOurBridge, pinnedBridgeVersion, readServerEntry } from "../harness/agentTargets";
import { HARNESS_CONFIG_PATH, HARNESS_DOC_PATH, DOC_KEY } from "../harness/harnessDoc";
import { LEGACY_ROLE_ENV_VAR } from "../harness/legacyRole";
import { findGitRoot, readManagedFile } from "../harness/repositoryFiles";
import { PACKAGE_NAME } from "../version";
import { readAccount, type AccountSummary } from "./accountSummary";
import { inspectAgents, inspectClaude, type AgentState } from "./agentConnections";
import type { CommandRunner } from "./commandRunner";

/**
 * ★status 와 doctor 가 쓰는 «수집 함수 하나»(설계 §4-3·§4-4). 읽기만 한다 — 에이전트 설정·저장소 파일을
 * 바꾸지 않는다(토큰 갱신은 평소 명령과 같다: 갱신 실패 원인을 보이려면 갱신을 해 봐야 한다).
 * doctor 의 판정은 {@code doctorChecks.ts} 가 이 결과만 보고 한다(순수 함수).
 */
export interface MachineStatus {
  cliVersion: string;
  endpoint: string;
  env: "prod" | "dev";
  token: TokenStatus;
  /** 쓸 수 있는 토큰이 있을 때만. */
  account?: AccountSummary;
  /** 기기 전역 연결(setup 의 것). */
  agents: AgentState[];
  /** 지금 폴더에서 본 Claude Code 항목 — 이 저장소의 local 범위가 사용자 범위를 가리는지. 홈에서 돌면 없다. */
  claudeHere?: AgentState;
  repository?: RepositoryStatus;
  /** 설정돼 있는 옛 환경변수 이름. */
  legacyEnv: string[];
  /** 우리 브리지에 --role 을 싣는 Codex 프로필 파일(0.7.x 가 안내하던 것). */
  legacyCodexProfiles: string[];
  /** PATH 의 전역 `ainecto` 판. 없으면 undefined(npx 로만 쓰는 사람). */
  globalCliVersion?: string;
}

export interface TokenStatus {
  /** env = AINECTO_TOKEN · signed-in · not-signed-in · refresh-failed */
  state: "env" | "signed-in" | "not-signed-in" | "refresh-failed";
  /** 저장된 토큰의 만료 시각(ISO). 값 자체는 내지 않는다. */
  expiresAt?: string;
  /** 갱신이 실패한 이유. */
  reason?: string;
}

export interface RepositoryStatus {
  root: string;
  /** git 저장소가 아니면 false — 이때 root 는 지금 폴더다. */
  git: boolean;
  harnessDoc: boolean;
  /** config.json 이 기록한 HARNESS.DOC 판. */
  harnessDocVersion?: string;
  configVersion?: number;
  /** 0.7.x 가 쓰던 project 칸이 남아 있나. */
  configHasProject: boolean;
  mcpFiles: Array<{ path: string; ours: boolean; carriesRole: boolean; pinnedVersion?: string }>;
  problem?: string;
}

export interface CollectInput {
  endpoint: string;
  env: "prod" | "dev";
  cliVersion: string;
  tokenStore: TokenStore;
  auth: { getAccessToken(): Promise<string | undefined> };
  client: McpRpcClient;
  /** 홈 폴더에서 도는 실행기(전역 연결·전역 CLI 판). */
  runner: CommandRunner;
  /** 지금 폴더에서 도는 실행기 — 이 저장소의 Claude local 범위를 볼 때. */
  hereRunner?: CommandRunner;
  home: string;
  cwd: string;
  envVars: NodeJS.ProcessEnv;
}

export async function collectStatus(input: CollectInput): Promise<MachineStatus> {
  const token = await tokenStatus(input);
  const usable = token.state === "env" || token.state === "signed-in";
  const status: MachineStatus = {
    cliVersion: input.cliVersion,
    endpoint: input.endpoint,
    env: input.env,
    token,
    agents: await inspectAgents({ runner: input.runner, home: input.home }),
    legacyEnv: [LEGACY_ROLE_ENV_VAR, "AI_ERD_ROLE"].filter((name) => input.envVars[name]?.trim()),
    legacyCodexProfiles: await legacyCodexProfiles(input.envVars.CODEX_HOME ?? join(input.home, ".codex")),
  };
  if (usable) {
    status.account = await readAccount(input.client);
  }
  if (input.hereRunner && input.cwd !== input.home) {
    status.claudeHere = await inspectClaude({ runner: input.hereRunner, home: input.home });
  }
  status.repository = await repositoryStatus(input.cwd);
  const globalVersion = await globalCliVersion(input.runner);
  if (globalVersion) {
    status.globalCliVersion = globalVersion;
  }
  return status;
}

async function tokenStatus(input: CollectInput): Promise<TokenStatus> {
  if (input.envVars.AINECTO_TOKEN) {
    return { state: "env" };
  }
  const stored = await input.tokenStore.load(input.endpoint);
  const expiresAt = stored?.expiresAt ? new Date(stored.expiresAt).toISOString() : undefined;
  try {
    const token = await input.auth.getAccessToken();
    if (token) {
      return { state: "signed-in", ...(expiresAt ? { expiresAt } : {}) };
    }
    return stored
      ? { state: "refresh-failed", ...(expiresAt ? { expiresAt } : {}), reason: "the stored sign-in expired and has no refresh token" }
      : { state: "not-signed-in" };
  } catch (error) {
    return {
      state: "refresh-failed",
      ...(expiresAt ? { expiresAt } : {}),
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function repositoryStatus(cwd: string): Promise<RepositoryStatus> {
  const gitRoot = await findGitRoot(cwd);
  const root = gitRoot ?? cwd;
  const status: RepositoryStatus = { root, git: gitRoot !== undefined, harnessDoc: false, configHasProject: false, mcpFiles: [] };
  try {
    status.harnessDoc = (await readManagedFile(root, HARNESS_DOC_PATH)) !== undefined;
    const config = parseObject(await readManagedFile(root, HARNESS_CONFIG_PATH));
    if (config) {
      if (typeof config.version === "number") status.configVersion = config.version;
      status.configHasProject = Object.prototype.hasOwnProperty.call(config, "project");
      const versions = config.promptVersions as Record<string, unknown> | undefined;
      if (typeof versions?.[DOC_KEY] === "string") status.harnessDocVersion = versions[DOC_KEY] as string;
    }
    for (const target of AGENT_TARGETS) {
      const entry = readServerEntry(await readManagedFile(root, target.path));
      if (entry !== undefined) {
        const pinnedVersion = pinnedBridgeVersion(entry);
        status.mcpFiles.push({
          path: target.path,
          ours: isOurBridge(entry),
          carriesRole: entryCarriesRole(entry),
          ...(pinnedVersion ? { pinnedVersion } : {}),
        });
      }
    }
  } catch (error) {
    status.problem = error instanceof Error ? error.message : String(error);
  }
  return status;
}

/** `$CODEX_HOME/*.config.toml` 중 우리 브리지에 --role 을 싣는 것. 0.7.x 가 «역할마다 프로필»을 안내했다. */
async function legacyCodexProfiles(codexHome: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(codexHome);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names.filter((file) => file.endsWith(".config.toml"))) {
    const content = await readFile(join(codexHome, name), "utf8").catch(() => "");
    if (content.includes(PACKAGE_NAME) && content.includes("--role")) {
      found.push(join(codexHome, name));
    }
  }
  return found;
}

/** PATH 의 `ainecto` 판 — `ainecto --version --json`. 없거나 못 읽으면 undefined. */
async function globalCliVersion(runner: CommandRunner): Promise<string | undefined> {
  const result = await runner("ainecto", ["--version", "--json"]);
  if (result.missing || result.exitCode !== 0) {
    return undefined;
  }
  try {
    const version = (JSON.parse(result.stdout) as { data?: { version?: unknown } }).data?.version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

function parseObject(content: string | undefined): Record<string, unknown> | undefined {
  if (content === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
