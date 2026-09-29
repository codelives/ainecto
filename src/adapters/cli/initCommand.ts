import { chmod, lstat, mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { McpRpcError, type McpRpcClient } from "../../core/mcp/rpcClient";
import { isDefaultEndpointFor } from "../../core/config/endpoints";
import { renderSuccess } from "../../core/output/render";
import { HARNESS_ROLES, ROLE_ENV_VAR, type HarnessRole } from "../../core/harness/role";
import {
  detectRoles,
  initRefusal,
  MANAGED_PATHS,
  planInit,
  planUndo,
  type FileWrite,
  type InitPlan,
  withCreatedDirectories,
} from "../../core/harness/initPlan";
import { HARNESS_CONFIG_PATH, HARNESS_RECORD_PATH } from "../../core/harness/harnessDoc";
import { fetchHarnessDocuments, type HarnessDocuments } from "../../core/harness/documentFetch";
import { PromptCancelled, type Choice, type Prompter } from "./prompter";

/** 역할이 정해진 «뒤»에 만드는 연결. 역할이 토큰 칸과 헤더를 정하므로 역할보다 먼저 만들 수 없다. */
export interface InitConnection {
  client: McpRpcClient;
  accessToken?: () => Promise<string | undefined>;
  login?: () => Promise<void>;
}

export interface InitCommandOptions {
  argv: string[];
  /** 전역 `--role` / AI_ERD_ROLE 에서 온 역할. init 은 이것을 따로 파싱하지 않는다. */
  role?: HarnessRole;
  /**
   * 이미 만든 연결(시험·역할이 미리 정해진 호출). {@link connect} 가 있으면 그쪽이 이긴다.
   */
  client?: McpRpcClient;
  /**
   * ★역할이 정해진 뒤 연결을 만든다(설계 §21-4). 대화형에서는 역할을 «물어서» 정하므로, 바깥 CLI 가
   * 미리 클라이언트를 만들 수 없다. 저장소 역할 추론도 init 안에서 하므로 «역할이 클라이언트보다 먼저
   * 정해진다»(I10)가 이 한 곳에서 지켜진다.
   */
  connect?: (role: HarnessRole) => InitConnection;
  /** 대화형일 때만 있다(판정은 prompter.isInteractive 한 곳). 없으면 묻지 않고 빠진 값을 말하고 멈춘다. */
  prompter?: Prompter;
  endpoint: string;
  /**
   * 문서를 받을 때 쓸 토큰을 «필요할 때» 가져온다. 없으면 패키지 기본값으로 간다.
   *
   * <p>★지연 조회인 이유: {@code --undo} 는 순수한 로컬 작업인데, 예전엔 그마저도 토큰
   * 조회·갱신·저장을 먼저 돌렸다(2026-09-23 독립 재리뷰 S1). 로컬 되돌리기가 네트워크에
   * 의존하면, 서버가 죽은 날 되돌릴 수가 없다.
   */
  accessToken?: () => Promise<string | undefined>;
  /**
   * 이 역할로 브라우저 로그인을 한다(= {@code ai-erd auth login} 과 같은 함수). 없으면 init 은 예전처럼
   * 로그인하지 않고 401 을 안내로 바꾼다.
   *
   * <p>★init 은 사람이나 에이전트가 «명시적으로» 친 명령이라 여기서 로그인한다. 브리지({@code ai-erd mcp})는
   * 여전히 자동 로그인하지 않는다 — 세션 한가운데서 창이 뜨면 안 된다(설계 §8-4).
   */
  login?: () => Promise<void>;
  /** 시험용 주입. 기본은 전역 fetch. */
  fetchImpl?: typeof fetch;
  env: "prod" | "dev";
  cliVersion: string;
  cwd: string;
  json: boolean;
  io: { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream };
}

/** 연결까지 갖춘 옵션 — 원격을 부르는 함수들은 이것만 받는다. */
type ConnectedOptions = InitCommandOptions & { client: McpRpcClient };

interface InitArgs {
  projectUuid?: string;
  projectName?: string;
  dryRun: boolean;
  undo: boolean;
  yes: boolean;
}

/**
 * {@code ai-erd init} — 이 저장소를 AI-ERD 하네스에 붙인다.
 *
 * ★<b>지금은 비대화형 경로만 있다</b>(설계 §21-1, 1단계). 합격 시나리오는 에이전트가 셸로 이 명령을
 * 치는 것이고 거기엔 사람이 답할 TTY 가 없다. 그래서:
 * <ul>
 *   <li><b>빠진 값은 채우지 않고 말하고 멈춘다.</b> 역할을 기본값으로 고르지 않는다 — 사람이 고른 값이
 *       {@code --role} 로 와야 한다. 프로젝트가 여럿이면 목록을 보여 주고 «다시 실행하라»고 한다.</li>
 *   <li><b>역할이 있으면 로그인까지 한다.</b> 그 역할의 토큰이 없으면 브라우저를 띄우고(사람이 승인)
 *       이어서 진행한다.</li>
 * </ul>
 * ★<b>사람이 터미널에서 치면(대화형) 빠진 역할·프로젝트를 번호로 묻는다</b>(설계 §21-4, 0.4.1).
 * 기본값으로 역할을 고르지 않는다. 질문 중 입력이 끝나면(EOF) 아무것도 쓰지 않고 130 으로 끝난다.
 * 확인 단계·루트 질문은 2단계다(설계 §21-2).
 */
export async function executeInitCommand(options: InitCommandOptions): Promise<number> {
  try {
    return await runInit(options);
  } catch (error) {
    if (error instanceof PromptCancelled) {
      options.io.stderr.write(`${error.message}\n`);
      return 130;
    }
    throw error;
  } finally {
    options.prompter?.close();
  }
}

async function runInit(initialOptions: InitCommandOptions): Promise<number> {
  let options = initialOptions;
  const args = parseInitArgs(options.argv);
  const root = resolve(options.cwd);
  // ★하위 폴더에서 치면 멈춘다. 그 자리에 .mcp.json 을 쓰면 에이전트는 루트에서 그것을 못 본다 —
  //   역할이 걸린 줄 알고 걸리지 않는다. undo 도 같은 이유로 루트에서만 한다(기록이 루트에 있다).
  const rootNotes = await repositoryRootNotes(root);
  const files = await readSnapshot(root);

  if (args.undo) {
    const plan = planUndo({ files });
    await applyPlan(root, plan, args.dryRun, files, false);
    options.io.stdout.write(renderSuccess(
      {
        action: args.dryRun ? "undo (dry-run)" : "undo",
        updated: plan.writes.map((write) => write.path),
        removed: plan.deletes,
        notes: [...rootNotes, ...plan.notes],
      },
      { json: options.json },
    ));
    return 0;
  }

  // ★<b>원격을 건드리기 «전»에 기록을 본다.</b> 예전엔 이 판정이 계획 안에만 있어서, 프로젝트가
  //   0개인 저장소에서 «원격에 프로젝트를 만든 뒤» 「아무것도 바꾸지 않았다」는 예외를 냈다
  //   (9차 1차 리뷰 B7). 로컬 쓰기가 0이라는 것과 부수효과가 0이라는 것은 다른 사실이다.
  //   ★묻기 «전»에도 본다 — 다 물어 놓고 거절하지 않는다.
  const refusal = initRefusal(files);
  if (refusal !== undefined) {
    throw new Error(refusal);
  }

  // ⚠명시한 --role 이 있으면 저장소 역할을 읽지 않는다 — 설정끼리 어긋난 저장소를 그 --role 이 맞춘다.
  // ★설정끼리 역할이 어긋난 저장소: 대화형이면 «기본값 없이» 묻고, 비대화형이면 사용자에게 물으라며 멈춘다.
  const prompter = options.prompter;
  const role = options.role ?? (prompter
    ? await askRole(prompter, repositoryRoles(files).length === 1 ? repositoryRoles(files)[0] : undefined)
    : currentRole(files));
  // 설정끼리 어긋나 있으면 «이전 역할»은 하나로 말할 수 없다 — 그때는 변경 알림을 생략한다
  // (명시한 --role 이 둘을 맞추고, 파일별 변화는 계획의 notes 가 말한다).
  const previousRole = (() => {
    try {
      return currentRole(files);
    } catch {
      return undefined;
    }
  })();
  if (!role) {
    // ⚠「하나 고르라」고 말하지 않는다 — 이 문장을 읽는 것은 대개 에이전트이고, 역할은 사용자가 고른다
    //   (0.4.1 최종 리뷰 P1, noProjectForRole 과 같은 어조).
    throw new Error(
      "No role given. Ask the user which role this repository's AI sessions should have "
      + `(${HARNESS_ROLES.join(", ")}), then re-run with --role <role>.`,
    );
  }

  // 역할이 정해졌으니 이제 그 역할의 연결을 만든다.
  const connected: ConnectedOptions = connectAs(options, role);
  options = connected;

  await ensureSignedIn(connected, role, args.dryRun);

  const project = await resolveProject(connected, args, files, root, role);
  if ("choices" in project) {
    options.io.stdout.write(renderSuccess(
      {
        message: "More than one project found. Re-run with --project <uuid>.",
        projects: project.choices,
      },
      { json: options.json },
    ));
    return 1;
  }

  const documents: HarnessDocuments = args.dryRun
    ? { versions: {}, fallbacks: {}, unavailableReason: "skipped in --dry-run" }
    : await fetchHarnessDocuments({
      endpoint: options.endpoint,
      accessToken: await options.accessToken?.(),
      client: "ai-erd-cli",
      fetchImpl: options.fetchImpl,
    });

  const plan = planInit({
    role,
    env: options.env,
    projectName: project.name,
    projectUuid: project.uuid,
    endpoint: options.endpoint,
    cliVersion: options.cliVersion,
    files,
    documents,
  });
  if (plan.refusal !== undefined) {
    // ★계획이 「멈춰라」고 하면 멈춘다. 이 판정을 부르는 쪽이 안 보면 그 판정은 «없는» 것이고,
    //   그 경우 읽어 내지 못한 기록을 백업 없이 덮는다(2026-09-27 8차 독립 리뷰 I1).
    //   ⚠위에서 이미 물었지만 여기서도 본다 — 계획이 거절을 «돌려주는» 이상 그것을 보지 않는
    //   경로가 생겨선 안 된다. 같은 함수를 쓰므로 두 답이 갈리지 않는다.
    throw new Error(plan.refusal);
  }
  await applyPlan(root, plan, args.dryRun, files);
  if (!args.dryRun && previousRole !== undefined && previousRole !== role) {
    // ★역할이 바뀐 사실을 사람이 보는 자리(에이전트 대화)에 한 줄 남긴다(설계 §13 S2).
    //   떠 있는 세션은 그대로이고 새 세션부터다 — 그 조건까지 같이 말한다.
    options.io.stderr.write(`Role changes from ${previousRole} to ${role} for new sessions.\n`);
  }

  options.io.stdout.write(renderSuccess(
    {
      action: args.dryRun ? "init (dry-run)" : "init",
      role,
      project: { uuid: project.uuid, name: project.name },
      endpoint: options.endpoint,
      written: plan.writes.map((write) => `${write.existed ? "updated" : "created"} ${write.path}`),
      codex: `Codex keeps a single global config, so init does not touch it. Run: ${plan.codexCommand}`,
      codexPerSession: plan.codexProfile,
      codexEnvFallback: `Without a profile, start the session with ${ROLE_ENV_VAR}=${role}.`,
      // ⚠조용히 기본값으로 떨어지지 않는다 — 서버에서 규칙을 고쳐도 안 바뀌는 이유를
      //   사용자가 영영 못 찾게 된다. ★요청 자체의 실패와 «문서별» 되돌림을 둘 다 적는다
      //   (2026-09-23 독립 재리뷰 I5: HTTP 200 으로 온 빈 문서가 조용히 패키지 판이 됐다).
      notes: [...rootNotes, ...plan.notes, ...fallbackNotes(documents)],
      // ★「Enforce this on the server too: ai-erd auth login …」 줄은 뺐다. init 이 이미 그 역할로
      //   로그인했으므로 참이 아니고, 남아 있으면 에이전트가 따라 쳐서 사람이 한 번 더 승인하게 된다
      //   (2026-09-29 독립 리뷰 P1-1).
      next: [
        "Start a new agent session to use this role — the running session keeps the role it started with.",
        "Claude Code: exit and run `claude -c` in this folder, then approve the \"ai-erd\" server from .mcp.json when asked.",
        `Codex: save the profile above as $CODEX_HOME/${role}.config.toml and start with \`codex -p ${role}\`.`,
        role === "design"
          // ⚠Design 은 그 변경이 «허용»된다 — 모든 역할에 같은 문장을 내보내면 거짓이 된다.
          ? "Then ask it to change a table — a Design session may, and the change lands in AI-ERD."
          : `Then ask it to change a table — a ${role} session will be told to stop.`,
        "If the new Claude Code session still has no role, run `claude mcp get ai-erd`: a local-scope \"ai-erd\" entry hides .mcp.json (remove it with `claude mcp remove ai-erd -s local`).",
        "Undo everything with: ai-erd init --undo",
      ],
    },
    { json: options.json },
  ));
  return 0;
}

/** 이 저장소에 이미 걸린 역할. 두 설정이 어긋나 있으면 «고르지 않고» 멈춘다. */
function currentRole(files: ReadonlyMap<string, string | undefined>): HarnessRole | undefined {
  const unique = repositoryRoles(files);
  if (unique.length > 1) {
    throw new Error(
      `Agent configs in this repository disagree about the session role (${unique.join(", ")}). `
      + "Ask the user which role this repository's AI sessions should have "
      + `(${HARNESS_ROLES.join(", ")}), then re-run with --role <role> to line them up.`,
    );
  }
  return unique[0];
}

/** 저장소의 에이전트 설정들에 걸린 역할(중복 없이). 둘 이상이면 설정끼리 어긋난 것이다. */
function repositoryRoles(files: ReadonlyMap<string, string | undefined>): HarnessRole[] {
  const found = [...detectRoles(files).values()].filter((role): role is HarnessRole => role !== undefined);
  return [...new Set(found)];
}

/** 패키지 기본값을 쓴 사실과 그 이유. 없으면 빈 배열. */
function fallbackNotes(documents: HarnessDocuments): string[] {
  const notes: string[] = [];
  if (documents.unavailableReason) {
    notes.push(`Harness rules came from this package, not the server (${documents.unavailableReason}).`);
  }
  for (const [key, reason] of Object.entries(documents.fallbacks)) {
    notes.push(`${key} came from this package, not the server (${reason}).`);
  }
  return notes;
}

/**
 * ★<b>원격을 부르기 전에 로그인을 확인한다.</b> 그 역할의 토큰이 없으면(만료 + refresh 없음 포함)
 * 브라우저 로그인을 하고 이어서 진행한다(합격 시나리오 4 — 예전엔 401 로 멈추고
 * {@code ai-erd auth login} 을 치라고 했다).
 *
 * <p>⚠{@code --dry-run} 은 브라우저를 띄우지 않는다 — 「아무것도 바꾸지 않는다」는 약속에 사용자의
 * 로그인 상태도 든다. 로그인 명령을 알려 주고 멈춘다.
 * <p>토큰은 있는데 서버가 401 을 주는 경우(폐기된 토큰)는 드물어 여기서 다루지 않는다 —
 * {@link callOrExplainSignIn} 이 안내한다. 트리거를 둘로 늘리지 않는다(설계 §8-1).
 */
async function ensureSignedIn(
  options: InitCommandOptions,
  role: HarnessRole,
  dryRun: boolean,
): Promise<void> {
  if (options.login === undefined) {
    return;
  }
  if (await options.accessToken?.()) {
    return;
  }
  if (dryRun) {
    // (dry-run 의 accessToken 은 읽기 전용이다 — 갱신하지 않으므로 만료된 토큰도 여기로 온다.)
    throw new Error(
      `No usable sign-in for this role, and --dry-run neither refreshes it nor opens a browser.\n\n`
      + `    ${loginCommand(options, role)}\n\n`
      + "Then run init again.",
    );
  }
  await options.login();
  options.io.stderr.write(`Signed in for role ${role}.\n`);
}

/**
 * 저장소 루트 판정. 하위 폴더면 멈추고(던진다), git 저장소가 아니면 그 사실을 note 로 돌려준다.
 *
 * <p>★{@code .git} 은 디렉터리 «또는 파일»이다 — worktree·submodule 은 파일이다. {@code git} 실행
 * 파일에는 기대지 않는다. git 이 아니면 멈추지 않는다: git 을 안 쓰는 사용자가 있고, 그 경우엔
 * 가리킬 «진짜 루트»가 없다(설계 §6-1).
 */
async function repositoryRootNotes(cwd: string): Promise<string[]> {
  const gitRoot = await findGitRoot(cwd);
  if (gitRoot === undefined) {
    // (init·undo 둘 다 이 note 를 쓴다 — «설정했다»가 아니라 «어디를 기준으로 삼았나»를 말한다.)
    return [`${cwd} is not inside a git repository, so this folder was used as the repository root.`];
  }
  if (gitRoot !== cwd) {
    throw new Error(
      `This folder is inside the git repository at ${gitRoot}, not at its root. `
      + "Agents read their MCP config from the repository root, so run init there:\n\n"
      + `    cd ${gitRoot}\n\n`
      + "Nothing was changed.",
    );
  }
  return [];
}

/** cwd 에서 위로 올라가며 {@code .git} 이 있는 첫 디렉터리. 없으면 undefined. */
export async function findGitRoot(cwd: string): Promise<string | undefined> {
  for (let at = resolve(cwd); ; at = dirname(at)) {
    try {
      await lstat(join(at, ".git"));
      return at;
    } catch {
      // 없다(또는 볼 수 없다) — 한 칸 위로.
    }
    if (dirname(at) === at) {
      return undefined;
    }
  }
}

/**
 * 역할이 정해진 뒤의 연결. {@code connect} 가 있으면 그것으로 만들고, 없으면 이미 받은 {@code client}.
 * 둘 다 없으면 부르는 쪽의 실수다.
 */
function connectAs(options: InitCommandOptions, role: HarnessRole): ConnectedOptions {
  if (options.connect) {
    const connection = options.connect(role);
    return { ...options, ...connection };
  }
  if (!options.client) {
    throw new Error("init needs either a client or a way to connect once the role is known.");
  }
  return { ...options, client: options.client };
}

const ROLE_CHOICES: ReadonlyArray<Choice<HarnessRole>> = [
  { label: "Design       requirements, ERD, boundaries, tasks", value: "design" },
  { label: "Development  product code, following the approved design", value: "development" },
  { label: "Test         test scenarios and test code", value: "test" },
  { label: "Validation   judges the result; changes nothing", value: "validation" },
];

/**
 * 역할을 묻는다(설계 §6-2). ★기본값이 없다 — 빈 입력은 다시 묻는다. 저장소에 이미 걸린 역할이 있을
 * 때만 그것이 기본값이다(Enter = 유지). 그 값은 사람이 전에 고른 것이지 우리가 고른 것이 아니다.
 */
async function askRole(prompter: Prompter, current: HarnessRole | undefined): Promise<HarnessRole> {
  const index = current === undefined ? undefined : ROLE_CHOICES.findIndex((choice) => choice.value === current);
  return prompter.choose(
    current === undefined
      ? "Which role should AI sessions in this repository have?"
      : `Which role should AI sessions in this repository have? (now: ${current})`,
    ROLE_CHOICES,
    index,
  );
}

/**
 * 프로젝트를 묻는다(설계 §6-4). 「새로 만들기」는 Design 이고 dry-run 이 아닐 때만 보인다 — 다른 역할은
 * 서버가 만들기를 거부한다. 0개면: Design 은 이름을 물어 만들고(사람의 선택이 --yes 를 대신한다),
 * 다른 역할은 비대화형과 같은 안내로 멈춘다.
 */
async function askProject(
  options: ConnectedOptions,
  args: InitArgs,
  projects: Array<{ uuid: string; name: string }>,
  bound: string | undefined,
  root: string,
  role: HarnessRole,
  prompter: Prompter,
): Promise<{ uuid: string; name: string }> {
  const canCreate = role === "design" && !args.dryRun;
  const askNameAndCreate = async () => {
    const name = await prompter.text("New project name", args.projectName ?? basenameOf(root));
    return createProject(options, name);
  };
  if (projects.length === 0) {
    if (role !== "design") {
      throw new Error(noProjectForRole(options, role));
    }
    if (args.dryRun) {
      throw new Error(dryRunCannotCreate(args.projectName ?? basenameOf(root)));
    }
    return askNameAndCreate();
  }
  type ProjectPick = { project: { uuid: string; name: string } } | { create: true };
  const choices: Array<Choice<ProjectPick>> = projects.map((project) => ({
    label: `${project.name}  (${project.uuid})`,
    value: { project },
  }));
  if (canCreate) {
    choices.push({ label: "Create a new project", value: { create: true } });
  }
  const boundIndex = bound === undefined ? -1 : projects.findIndex((project) => project.uuid === bound);
  const defaultIndex = boundIndex >= 0 ? boundIndex : projects.length === 1 ? 0 : undefined;
  const picked = await prompter.choose("Which AI-ERD project should this repository use?", choices, defaultIndex);
  return "create" in picked ? askNameAndCreate() : picked.project;
}

/** 0개 + Design 아님의 안내. 비대화형·대화형이 같은 문장을 쓴다. */
function noProjectForRole(options: Pick<InitCommandOptions, "endpoint">, role: HarnessRole): string {
  // ⚠「--role design 으로 다시 치라」고 말하지 않는다. 그 문장은 에이전트를 «역할 전환»으로 이끈다 —
  //   역할은 사용자가 고른 것이다(2026-09-29 코드 리뷰 P1). 사람에게 묻게 하고, 원래 역할로 돌아오게 한다.
  return `No project found in your AI-ERD account, and only a Design session can create one. `
    + `Ask the user: create the project at ${new URL(options.endpoint).origin} or in a Design session, `
    + `then run init again with --role ${role}.`;
}

function dryRunCannotCreate(name: string): string {
  // ★dry-run 이 «원격에» 프로젝트를 만들면 그것은 dry-run 이 아니다(2026-09-22 독립 리뷰 I6).
  return `--dry-run cannot continue: there is no project to bind, and creating "${name}" `
    + "would be a real change. Re-run without --dry-run, or pass --project <uuid>.";
}

type ResolvedProject = { uuid: string; name: string } | { choices: Array<{ uuid: string; name: string }> };

async function resolveProject(
  options: ConnectedOptions,
  args: InitArgs,
  files: ReadonlyMap<string, string | undefined>,
  root: string,
  role: HarnessRole,
): Promise<ResolvedProject> {
  const projects = await listProjects(options);

  if (args.projectUuid) {
    const found = projects.find((project) => project.uuid === args.projectUuid);
    return found ?? { uuid: args.projectUuid, name: args.projectName ?? args.projectUuid };
  }

  const bound = boundProjectUuid(files.get(HARNESS_CONFIG_PATH));
  if (options.prompter) {
    return askProject(options, args, projects, bound, root, role, options.prompter);
  }
  if (bound) {
    const found = projects.find((project) => project.uuid === bound);
    if (found) {
      return found;
    }
  }

  if (projects.length === 1) {
    return projects[0]!;
  }
  if (projects.length > 1) {
    return { choices: projects };
  }

  // 프로젝트가 하나도 없다 — 만들어야 한다.
  // ★만들 수 있는 것은 Design 세션뿐이다(서버 McpRolePolicy: create_projects 는 Design·FULL 만).
  //   예전엔 다른 역할로 --yes 를 주면 서버가 거부하고, 우리는 「Project creation did not return a
  //   project uuid.」라는 엉뚱한 말로 끝났다. 원격 쓰기를 부르기 «전에» 사람이 할 일을 말한다.
  if (role !== "design") {
    throw new Error(noProjectForRole(options, role));
  }
  // ★쓰기이므로 --yes 없이는 하지 않는다.
  const name = args.projectName ?? basenameOf(root);
  if (!args.yes) {
    throw new Error(
      `No project found in your AI-ERD account. Re-run with --yes to create "${name}", `
      + "or --project-name <name> --yes to pick the name.",
    );
  }
  if (args.dryRun) {
    throw new Error(dryRunCannotCreate(name));
  }
  return createProject(options, name);
}

async function listProjects(options: ConnectedOptions): Promise<Array<{ uuid: string; name: string }>> {
  const result = await callOrExplainSignIn(options, () => options.client.toolsCall("list_projects", {}));
  return extractProjects(unwrapToolJson(result));
}

/**
 * ★<b>401 을 «무엇을 하라»로 바꾼다.</b>
 *
 * <p>토큰이 «없을» 때는 여기까지 오지 않는다 — {@link ensureSignedIn} 이 먼저 로그인한다.
 * 여기 오는 것은 토큰은 있는데 서버가 거절한 경우(폐기 등)와, 로그인 함수를 받지 못한 호출이다.
 * 그때 {@code MCP HTTP request failed with HTTP 401.} 한 줄만 남기면 무엇을 해야 하는지 모른다
 * (2026-09-23 살아 있는 서버로 처음 돌려 보고 발견).
 *
 * <p>⚠401 을 받았다고 «다시» 브라우저를 띄우지는 않는다. 로그인 트리거는 하나로 둔다(설계 §8-1).
 * 브리지({@code ai-erd mcp})는 애초에 자동 로그인하지 않는다 — 세션 한가운데서 창이 뜨면 안 된다.
 */
async function callOrExplainSignIn<T>(
  options: InitCommandOptions,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isUnauthorized(error)) {
      throw error;
    }
    throw new Error(
      `Not signed in for this role, so ${options.endpoint} refused the request (HTTP 401).\n\n`
      + `    ${loginCommand(options, options.role)}\n\n`
      + "Then run init again. The role is carried by the access token, so each role signs in once.",
    );
  }
}

/**
 * 이 저장소·이 서버에 맞는 로그인 명령 한 줄. ★<b>만드는 곳은 여기 하나다.</b>
 *
 * <p>⚠예전엔 「이 env 의 기본 주소면 인자를 생략」이라고만 하고 그 env 자체도 안 실었다.
 * CLI 의 기본 env 는 prod 라, dev 기본 주소에서 막힌 사람이 그 명령을 그대로 치면 «운영»
 * 슬롯에 로그인하고 같은 자리에서 또 막힌다(2026-09-23 4차 독립 리뷰 S2).
 * 주소든 env 든 <b>하나는 반드시</b> 실린다.
 */
function loginCommand(
  options: Pick<InitCommandOptions, "env" | "endpoint">,
  role: HarnessRole | undefined,
): string {
  const target = isDefaultEndpointFor(options.env, options.endpoint)
    ? (options.env === "prod" ? "" : ` --env ${options.env}`)
    : ` --endpoint ${options.endpoint}`;
  return `ai-erd auth login --role ${role ?? "<design|development|test|validation>"}${target}`;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof McpRpcError
    && error.code === "MCP_HTTP_ERROR"
    && (error.details as { status?: number } | undefined)?.status === 401;
}

async function createProject(options: ConnectedOptions, name: string): Promise<{ uuid: string; name: string }> {
  const result = await callOrExplainSignIn(options, () =>
    options.client.toolsCall("create_projects", { items: [{ name }] }));
  const created = extractProjects(unwrapToolJson(result));
  const first = created[0];
  if (!first) {
    throw new Error("Project creation did not return a project uuid.");
  }
  // ★원격에 생긴 것을 «바로» 알린다. 뒤에서 실패하면 결과 출력이 없어 사용자는 이 프로젝트가
  //   생긴 줄 모른다(설계 §13 S9).
  options.io.stderr.write(`Created project ${first.name} (${first.uuid}).\n`);
  return first;
}

/** MCP 도구 응답은 {@code content[0].text} 에 JSON 문자열로 온다. */
export function unwrapToolJson(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return result;
  }
  const first = result.content.find((item) => isRecord(item) && item.type === "text");
  if (!isRecord(first) || typeof first.text !== "string") {
    return result;
  }
  try {
    return JSON.parse(first.text);
  } catch {
    return first.text;
  }
}

/**
 * 응답 모양을 단정하지 않고 «uuid 와 name 을 가진 객체의 배열»을 찾는다.
 * ⚠도구 응답 포맷을 여기 박아 두면 서버가 한 겹 감싸는 순간 조용히 빈 목록이 된다.
 */
export function extractProjects(value: unknown): Array<{ uuid: string; name: string }> {
  const candidates: unknown[] = Array.isArray(value)
    ? value
    : isRecord(value)
      ? ["projects", "items", "created", "data", "hits"].flatMap((key) => {
        const nested = value[key];
        return Array.isArray(nested) ? nested : [];
      })
      : [];
  const projects: Array<{ uuid: string; name: string }> = [];
  for (const candidate of candidates) {
    if (isRecord(candidate) && typeof candidate.uuid === "string") {
      projects.push({
        uuid: candidate.uuid,
        name: typeof candidate.name === "string" ? candidate.name : candidate.uuid,
      });
    }
  }
  return projects;
}

function boundProjectUuid(config: string | undefined): string | undefined {
  if (!config) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(config) as { project?: { uuid?: unknown } };
    return typeof parsed.project?.uuid === "string" ? parsed.project.uuid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * ★<b>읽기도 경계 검사를 먼저 통과한다.</b> 예전엔 스냅샷을 다 읽은 «뒤에» 경계를 봤다 —
 * 저장소 밖을 가리키는 링크의 내용을 한 번 읽고 나서 거절했다(2026-09-23 독립 재리뷰 I4).
 * 쓰기·삭제만 막으면 되는 게 아니다. 읽는 것도 남의 파일이다.
 */
async function readSnapshot(root: string): Promise<Map<string, string | undefined>> {
  const snapshot = new Map<string, string | undefined>();
  for (const path of MANAGED_PATHS) {
    snapshot.set(path, await readManagedFile(root, path));
  }
  return snapshot;
}

/**
 * ★<b>저장소 안의 파일을 읽는 유일한 문.</b> 경계 검사가 읽기 «앞»에 붙어 있다.
 *
 * <p>예전엔 {@code readSnapshot} 만 검사를 했고, 나중에 붙인 역할 추론이 {@code readIfExists} 를
 * 바로 불렀다. 그래서 저장소 밖을 가리키는 설정 파일을 <b>한 번 읽고 나서</b> 거절했다
 * (2026-09-23 4차 독립 리뷰 I5). 검사와 읽기가 갈라지면, 새로 생긴 경로마다 검사를 잊는다.
 */
/**
 * 관리 대상 파일의 부모 중 <b>지금 없는</b> 디렉터리들. 우리가 쓰면서 만들게 되는 것이다.
 *
 * <p>파일 스냅샷만으로는 「비어 있는 디렉터리가 이미 있었나」를 알 수 없다. 그걸 모르면
 * 되돌리기가 남의 빈 디렉터리를 치운다(2026-09-23 4차 독립 리뷰 S3).
 */

async function readManagedFile(root: string, path: string): Promise<string | undefined> {
  await assertInsideRepository(root, path);
  return readIfExists(join(root, path));
}

async function readIfExists(absolutePath: string): Promise<string | undefined> {
  try {
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * ★이 경로가 정말 저장소 «안»인가.
 *
 * <p>{@code join(root, path)} 는 이름을 이어 붙일 뿐이고, {@code readFile}/{@code writeFile}
 * 은 심볼릭 링크를 따라간다. {@code .ai-erd → /somewhere/else} 인 저장소에서 undo 를 돌리면
 * 남의 디렉터리 파일이 지워졌다(2026-09-22 독립 리뷰 I4). 실제 경로로 풀어서 경계를 본다.
 */
async function assertInsideRepository(root: string, relativePath: string): Promise<void> {
  const absolutePath = join(root, relativePath);
  const realRoot = await realpath(root);
  let realParent: string;
  try {
    realParent = await realpath(dirname(absolutePath));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return; // 아직 없는 디렉터리는 우리가 만든다 — 링크일 수 없다.
    }
    throw error;
  }
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
    throw new Error(
      `${relativePath} resolves outside the repository (${realParent}); refusing to touch it.`,
    );
  }
  try {
    if ((await lstat(absolutePath)).isSymbolicLink()) {
      throw new Error(`${relativePath} is a symbolic link; refusing to write through it.`);
    }
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * 계획을 적용한다.
 *
 * <p>★<b>먼저 전부 검사하고, 그 다음에 쓴다.</b> 예전엔 한 파일씩 쓰다가 중간에 막히면
 * (권한 등) 앞 파일만 바뀐 채로 실패했다(2026-09-22 독립 리뷰 I5). 지금은 경계·링크·
 * 「스냅샷 이후 바뀌었는가」를 먼저 다 보고, 하나라도 걸리면 아무것도 안 쓴다.
 *
 * <p>⚠그래도 «쓰는 도중» 실패는 완전히 못 막는다(디스크 가득 등). 그때 무엇이 쓰였는지는
 * 오류에 적는다 — 조용히 반쪽 상태로 두지 않는다.
 */
async function applyPlan(
  root: string,
  plan: InitPlan,
  dryRun: boolean,
  snapshot: FileSnapshotMap,
  recordFirst = true,
): Promise<void> {
  // ①먼저 «전부» 본다 — 하나라도 못 쓸 상황이면 아무것도 건드리지 않고 멈추는 게 낫다.
  for (const write of plan.writes) {
    await assertInsideRepository(root, write.path);
    await assertUnchangedSinceSnapshot(root, write.path, snapshot);
  }
  for (const path of plan.deletes) {
    await assertInsideRepository(root, path);
    await assertUnchangedSinceSnapshot(root, path, snapshot);
  }
  if (dryRun) {
    return;
  }
  const applied: string[] = [];
  try {
    // ★<b>복구 기록을 먼저 쓴다.</b> 예전엔 관리 기록(.ai-erd/config.json)이 «마지막» 쓰기였다.
    //   그래서 중간에 실패하면 이미 바뀐 파일이 있는데 기록이 없어 undo 가 아무것도 못 되돌렸다
    //   (2026-09-23 독립 재리뷰 I11). 되돌릴 수 있게 만드는 것이 첫 일이다.
    // ★되돌리기에서는 기록을 건드리는 일이 «작업 전체»의 마지막이다. 4차에서 config 를 쓰기
    //   목록의 뒤로 옮겼지만, 쓰기가 다 끝난 «뒤에» 삭제가 온다. 그래서 삭제가 실패하면 기록은
    //   이미 옛 파일로 돌아가 있고 되돌릴 근거가 없었다(2026-09-23 5차 독립 리뷰 I1).
    const isRecord = (path: string) => !recordFirst && path === HARNESS_RECORD_PATH;
    const recordWrites = plan.writes.filter((write) => isRecord(write.path));
    const recordDeletes = plan.deletes.filter((path) => isRecord(path));
    /**
     * ★<b>우리가 «실제로 만든» 디렉터리.</b> {@code mkdir(recursive)} 는 자기가 만든 가장 위
     * 디렉터리를 돌려주고, 이미 있었으면 undefined 를 준다 — 그게 우리가 알고 싶던 사실
     * 그 자체다. 이 칸의 진실원은 이 변수 하나이고, 계획은 여기에 관여하지 않는다.
     * (직전 실행에서 이어받은 것은 이미 기록에 있으므로 함께 들고 간다.)
     */
    const createdDirectories: string[] = [...(plan.record?.createdDirectories ?? [])];
    const rememberDirectories = (directories: readonly string[]) => {
      for (const directory of directories) {
        if (!createdDirectories.includes(directory)) {
          createdDirectories.push(directory);
        }
      }
    };
    /**
     * 기록의 디렉터리 칸을 «실제로 만든 것»으로 바로잡는다.
     *
     * <p>★성공했을 때만 하면 안 된다 — 중간에 실패해도 그 순간까지의 사실이 기록에 남아야
     * 한다. 예전엔 보정이 성공 경로에만 있어서, 만들기 «전»에 실패한 계획이 그대로 남고
     * 그 뒤 사용자가 만든 디렉터리를 다음 undo 가 지웠다(2026-09-27 6차 독립 리뷰 S1).
     *
     * <p>⚠기록 보정이 실패해도 원래 오류를 덮지 않는다. 같은 내용을 두 번 써도 무해하다.
     */
    const recordActualDirectories = async () => {
      const write = plan.writes.find((w) => w.path === HARNESS_RECORD_PATH);
      if (!recordFirst || !plan.record || !write || !applied.includes(HARNESS_RECORD_PATH)) {
        return;
      }
      await writeManagedFile(root, {
        ...write,
        content: withCreatedDirectories(write.content, createdDirectories),
      });
    };
    /**
     * 보정을 «삼키지 않는다». 다른 오류가 진행 중이면 그 오류를 살리고, 아니면 드러낸다.
     *
     * <p>★예전엔 무조건 삼켰다. 그러면 init 이 종료 0 을 돌려주는데 기록의 디렉터리 칸이
     * 비어 있고, 그 상태의 undo 는 우리가 만든 디렉터리를 남긴다 — 「성공」이 기록 완료를
     * 보증하지 않았다(2026-09-27 7차 독립 리뷰 S1).
     */
    const recordDirectoriesOrExplain = async (failing: boolean) => {
      try {
        await recordActualDirectories();
      } catch (error) {
        if (!failing) {
          throw error;
        }
      }
    };
    const apply = async (writes: readonly FileWrite[], deletes: readonly string[]) => {
      for (const write of writes) {
        // ②그리고 «쓰기 직전에» 다시 본다. ①과 실제 쓰기 사이에 누가 고칠 수 있다 — 그 틈으로
        //   남의 편집이 덮여 나갔다(같은 항목). 검사와 쓰기를 붙여 놓으면 창이 작아진다.
        await assertUnchangedSinceSnapshot(root, write.path, snapshot);
        await writeManagedFile(root, write, rememberDirectories);
        applied.push(write.path);
      }
      for (const path of deletes) {
        await assertUnchangedSinceSnapshot(root, path, snapshot);
        await rm(join(root, path), { force: true });
        applied.push(path);
      }
    };

    try {
      await apply(
        orderedWrites(plan.writes.filter((write) => !isRecord(write.path)), recordFirst),
        plan.deletes.filter((path) => !isRecord(path)),
      );
      await recordDirectoriesOrExplain(false);
      // 여기까지 전부 된 다음에만 기록을 줄이거나 지운다.
      await apply(recordWrites, recordDeletes);
    } catch (error) {
      await recordDirectoriesOrExplain(true);
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\nAlready applied before this failure: ${applied.join(", ") || "(nothing)"}`,
    );
  }
  // 우리가 «만든» 디렉터리가 비었으면 그것도 치운다.
  // ⛔recursive 로 지우지 않는다 — 사용자가 그 안에 둔 다른 파일까지 날아간다.
  //   rmdir 는 «비어 있을 때만» 성공하므로, 비었는지는 파일시스템이 판정한다.
  // ★「비었으면 치운다」였을 때는 init 전부터 있던 빈 .cursor 까지 사라졌다
  //   (2026-09-23 4차 독립 리뷰 S3). 비었다는 것과 우리 것이라는 것은 다른 사실이다.
  for (const directory of plan.removableDirectories ?? []) {
    await rmdir(join(root, directory)).catch(() => undefined);
  }
}

/**
 * 관리 기록을 맨 앞으로 옮긴 쓰기 순서.
 *
 * <p>★기록이 먼저 디스크에 있어야 그 뒤의 실패를 되돌릴 수 있다. 기록에 적힌 지문은
 * «쓰려던 내용»의 것이라, 못 쓴 파일은 지문이 안 맞아 undo 가 「손댔다」로 보고 남긴다 —
 * 안 만든 파일을 지우려 드는 것보다 안전한 쪽이다.
 */
function orderedWrites(writes: readonly FileWrite[], recordFirst: boolean): FileWrite[] {
  const record = writes.filter((write) => write.path === HARNESS_RECORD_PATH);
  const rest = writes.filter((write) => write.path !== HARNESS_RECORD_PATH);
  // ★undo 에서는 «마지막»이다. undo 가 config 에 쓰는 것은 기록을 남기는 일이 아니라
  //   옛 파일로 «되돌리는» 일이라, 먼저 하면 나머지를 되돌릴 근거를 스스로 지운다
  //   (2026-09-23 4차 독립 리뷰 I2). 같은 순서 규칙을 두 방향에 그대로 쓰면 안 된다.
  return recordFirst ? [...record, ...rest] : [...rest, ...record];
}


/** 파일을 읽은 뒤 우리가 네트워크를 기다리는 사이에 누가 고쳤으면, 그 변경을 덮지 않는다. */
async function assertUnchangedSinceSnapshot(
  root: string,
  relativePath: string,
  snapshot: FileSnapshotMap,
): Promise<void> {
  if (!snapshot.has(relativePath)) {
    return;
  }
  const now = await readIfExists(join(root, relativePath));
  if (now !== snapshot.get(relativePath)) {
    throw new Error(
      `${relativePath} changed while init was running; nothing was written. Run init again.`,
    );
  }
}

/**
 * 임시 파일에 쓰고 바꿔 끼운다 — 도중에 죽어도 반쪽짜리 파일이 남지 않는다.
 *
 * <p>★<b>기존 파일의 권한을 그대로 가져간다.</b> rename 은 inode 를 «갈아치우므로», 그냥
 * 만들면 umask 기본값(보통 0644)이 된다. 남의 서버 설정에 환경변수가 들어 있는 0600 파일이
 * init 한 번에 0644 로 넓어졌다(2026-09-23 독립 재리뷰 N1). 내용을 합치는 일이 남의 파일
 * 접근 권한까지 바꾸면 안 된다.
 */
async function writeManagedFile(
  root: string,
  write: FileWrite,
  onDirectoriesCreated?: (directories: readonly string[]) => void,
): Promise<string[]> {
  const absolutePath = join(root, write.path);
  const targetDirectory = dirname(absolutePath);
  const firstCreated = await mkdir(targetDirectory, { recursive: true });
  // ★<b>만든 사실을 «지금» 넘긴다.</b> 예전엔 반환값으로만 줬는데, 그 반환은 rename 뒤에
  //   일어난다 — 그 사이에 쓰기가 실패하면 «우리가 만든 디렉터리»라는 사실이 통째로 사라졌고,
  //   다음 init 의 mkdir 는 이미 있는 디렉터리에 undefined 를 주므로 회복도 못 했다
  //   (2026-09-27 7차 독립 리뷰 S1). 만드는 것과 쓰는 것은 다른 일이다.
  const created = createdChain(root, firstCreated, targetDirectory);
  onDirectoriesCreated?.(created);
  const previousMode = await fileMode(absolutePath);
  const tmpPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
  // 임시 파일도 «처음부터» 좁게 만든다 — 넓게 만들었다가 좁히면 그 사이가 창이다.
  await writeFile(tmpPath, write.content, { encoding: "utf8", mode: previousMode ?? 0o600 });
  if (previousMode !== undefined) {
    await chmod(tmpPath, previousMode);
  }
  await rename(tmpPath, absolutePath);
  return created;
}

/**
 * 이번 {@code mkdir} 이 «정말 만든» 디렉터리들 — 저장소 기준 상대 경로, 깊은 것부터.
 *
 * <p>★{@code recursive: true} 는 자기가 만든 «가장 위» 디렉터리 하나만 돌려준다. 그 아래부터
 * 목표 디렉터리까지도 같이 만들어진 것이므로 구간 전체가 우리 것이다. 이미 있었으면
 * undefined 를 주므로 그때는 빈 목록이다 — <b>「있다」와 「우리가 만들었다」가 갈리는 지점</b>.
 */
export function createdChain(root: string, firstCreated: string | undefined, targetDirectory: string): string[] {
  if (firstCreated === undefined) {
    return [];
  }
  const stop = resolve(firstCreated);
  const made: string[] = [];
  for (let at = resolve(targetDirectory); ; at = dirname(at)) {
    const asRelative = relative(root, at);
    if (asRelative && !asRelative.startsWith("..")) {
      made.push(asRelative.split(sep).join("/"));
    }
    if (at === stop || dirname(at) === at) {
      break;
    }
  }
  return made;
}

async function fileMode(absolutePath: string): Promise<number | undefined> {
  try {
    return (await stat(absolutePath)).mode & 0o7777;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

type FileSnapshotMap = Map<string, string | undefined>;

function parseInitArgs(argv: string[]): InitArgs {
  const args: InitArgs = { dryRun: false, undo: false, yes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--project") {
      args.projectUuid = requireValue(arg, argv[++index]);
    } else if (arg === "--project-name") {
      args.projectName = requireValue(arg, argv[++index]);
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--undo") {
      args.undo = true;
    } else if (arg === "--yes" || arg === "-y") {
      args.yes = true;
    } else if (arg === "--json") {
      // 전역 플래그 — 여기선 무시한다.
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "ai-erd-project";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
