import { chmod, lstat, mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { McpRpcError, type McpRpcClient } from "../../core/mcp/rpcClient";
import { isDefaultEndpointFor } from "../../core/config/endpoints";
import { renderSuccess } from "../../core/output/render";
import { HARNESS_ROLES, ROLE_ENV_VAR, type HarnessRole } from "../../core/harness/role";
import {
  detectRoles,
  emptyManagedRecord,
  MANAGED_PATHS,
  planInit,
  planUndo,
  type FileWrite,
  type InitPlan,
  type ManagedRecord,
} from "../../core/harness/initPlan";
import { HARNESS_CONFIG_PATH } from "../../core/harness/harnessDoc";
import { AGENT_TARGETS } from "../../core/harness/agentTargets";
import { fetchHarnessDocuments, type HarnessDocuments } from "../../core/harness/documentFetch";

export interface InitCommandOptions {
  argv: string[];
  /** 전역 `--role` / AI_ERD_ROLE 에서 온 역할. init 은 이것을 따로 파싱하지 않는다. */
  role?: HarnessRole;
  client: McpRpcClient;
  endpoint: string;
  /**
   * 문서를 받을 때 쓸 토큰을 «필요할 때» 가져온다. 없으면 패키지 기본값으로 간다.
   *
   * <p>★지연 조회인 이유: {@code --undo} 는 순수한 로컬 작업인데, 예전엔 그마저도 토큰
   * 조회·갱신·저장을 먼저 돌렸다(2026-09-23 독립 재리뷰 S1). 로컬 되돌리기가 네트워크에
   * 의존하면, 서버가 죽은 날 되돌릴 수가 없다.
   */
  accessToken?: () => Promise<string | undefined>;
  /** 시험용 주입. 기본은 전역 fetch. */
  fetchImpl?: typeof fetch;
  env: "prod" | "dev";
  cliVersion: string;
  cwd: string;
  json: boolean;
  io: { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream };
}

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
 * ★<b>대화형 프롬프트를 쓰지 않는다.</b> 이 명령은 에이전트 세션 «안에서» 실행될 때가 많고,
 * 거기엔 사람이 답할 TTY 가 없다. 고를 것이 여럿이면 목록을 보여 주고 «다시 실행하라»고
 * 말한다 — 멈춰서 기다리다 죽는 것보다 낫다.
 */
export async function executeInitCommand(options: InitCommandOptions): Promise<number> {
  const args = parseInitArgs(options.argv);
  const root = resolve(options.cwd);
  const files = await readSnapshot(root);

  if (args.undo) {
    const plan = planUndo({ files, managed: readManaged(files.get(HARNESS_CONFIG_PATH)) });
    await applyPlan(root, plan, args.dryRun, files);
    options.io.stdout.write(renderSuccess(
      {
        action: args.dryRun ? "undo (dry-run)" : "undo",
        updated: plan.writes.map((write) => write.path),
        removed: plan.deletes,
        notes: plan.notes,
      },
      { json: options.json },
    ));
    return 0;
  }

  const role = options.role ?? currentRole(files);
  if (!role) {
    throw new Error(
      `--role is required on first run. Pick one of: ${HARNESS_ROLES.join(", ")}.`,
    );
  }

  const project = await resolveProject(options, args, files, root);
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
    previous: readManaged(files.get(HARNESS_CONFIG_PATH)),
    documents,
  });
  await applyPlan(root, plan, args.dryRun, files);

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
      notes: [...plan.notes, ...fallbackNotes(documents)],
      next: [
        "Restart the agent so it picks up the new MCP server.",
        role === "design"
          // ⚠Design 은 그 변경이 «허용»된다 — 모든 역할에 같은 문장을 내보내면 거짓이 된다.
          ? "Ask it to change a table — a Design session may, and the change lands in AI-ERD."
          : `Ask it to change a table — a ${role} session will be told to stop.`,
        `Enforce this on the server too: ai-erd auth login --role ${role}`,
        "Undo everything with: ai-erd init --undo",
      ],
    },
    { json: options.json },
  ));
  return 0;
}

/**
 * 이 저장소에 이미 걸린 역할 — 디스크에서 읽는다.
 *
 * <p>★<b>인증 클라이언트를 만들기 «전에» 불러야 한다.</b> 예전엔 바깥 CLI 가 플래그·환경변수만
 * 보고 클라이언트를 먼저 만들고, init 이 나중에 파일에서 역할을 정했다. 그래서 저장소는
 * development 로 걸려 있고 그 역할 자격증명만 있는데, 역할 인자 없이 재실행하면 «무역할»
 * 슬롯을 뒤지다 401 로 끝났다(2026-09-23 독립 재리뷰 I10).
 *
 * <p>읽기만 한다. 파일이 없으면 undefined.
 */
export async function readRepositoryRole(cwd: string): Promise<HarnessRole | undefined> {
  const root = resolve(cwd);
  const files = new Map<string, string | undefined>();
  for (const target of AGENT_TARGETS) {
    files.set(target.path, await readIfExists(join(root, target.path)));
  }
  try {
    return currentRole(files);
  } catch {
    // 설정끼리 어긋난 경우 — 여기서 멈추지 않는다. init 본체가 같은 검사로 제대로 말한다.
    return undefined;
  }
}

/** 이 저장소에 이미 걸린 역할. 두 설정이 어긋나 있으면 «고르지 않고» 멈춘다. */
function currentRole(files: ReadonlyMap<string, string | undefined>): HarnessRole | undefined {
  const found = [...detectRoles(files).values()].filter((role): role is HarnessRole => role !== undefined);
  const unique = [...new Set(found)];
  if (unique.length > 1) {
    throw new Error(
      `Agent configs disagree about the session role (${unique.join(", ")}). `
      + "Re-run with an explicit --role to line them up.",
    );
  }
  return unique[0];
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

type ResolvedProject = { uuid: string; name: string } | { choices: Array<{ uuid: string; name: string }> };

async function resolveProject(
  options: InitCommandOptions,
  args: InitArgs,
  files: ReadonlyMap<string, string | undefined>,
  root: string,
): Promise<ResolvedProject> {
  const projects = await listProjects(options);

  if (args.projectUuid) {
    const found = projects.find((project) => project.uuid === args.projectUuid);
    return found ?? { uuid: args.projectUuid, name: args.projectName ?? args.projectUuid };
  }

  const bound = boundProjectUuid(files.get(HARNESS_CONFIG_PATH));
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

  // 프로젝트가 하나도 없다 — 만들어야 한다. ★쓰기이므로 --yes 없이는 하지 않는다.
  const name = args.projectName ?? basenameOf(root);
  if (!args.yes) {
    throw new Error(
      `No project found in your AI-ERD account. Re-run with --yes to create "${name}", `
      + "or --project-name <name> --yes to pick the name.",
    );
  }
  if (args.dryRun) {
    // ★dry-run 이 «원격에» 프로젝트를 만들면 그것은 dry-run 이 아니다
    //   (2026-09-22 독립 리뷰 I6). 로컬 쓰기만 막던 검사가 여기보다 뒤에 있었다.
    throw new Error(
      `--dry-run cannot continue: there is no project to bind, and creating "${name}" `
      + "would be a real change. Re-run without --dry-run, or pass --project <uuid>.",
    );
  }
  return createProject(options, name);
}

async function listProjects(options: InitCommandOptions): Promise<Array<{ uuid: string; name: string }>> {
  const result = await callOrExplainSignIn(options, () => options.client.toolsCall("list_projects", {}));
  return extractProjects(unwrapToolJson(result));
}

/**
 * ★<b>「로그인하라」는 말을 «여기서» 한다.</b>
 *
 * <p>init 은 새 사용자가 치는 «첫 명령»인데, 토큰이 없으면 MCP 호출이 401 로 떨어지고
 * 그대로 {@code MCP HTTP request failed with HTTP 401.} 한 줄만 남았다. 그 문장은 무엇을
 * 해야 하는지 말해 주지 않는다 — 로그인은 {@code auth login} 에서만 일어나는데, 그걸
 * 모르면 여기서 막힌다(2026-09-23 살아 있는 서버로 처음 돌려 보고 발견).
 *
 * <p>⚠자동으로 로그인시키지 않는다. 같은 클라이언트를 stdio 브리지({@code ai-erd mcp})가
 * 쓰고 있어서, 401 에 브라우저를 여는 순간 에이전트 세션 한가운데서 창이 뜬다.
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
    // ★안내하는 명령이 «같은 서버»를 가리켜야 한다. 기본 주소가 아니면 --endpoint 를 붙인다.
    const endpointFlag = isDefaultEndpointFor(options.env, options.endpoint)
      ? ""
      : ` --endpoint ${options.endpoint}`;
    const role = options.role ?? "<design|development|test|validation>";
    throw new Error(
      `Not signed in for this role, so ${options.endpoint} refused the request (HTTP 401).\n\n`
      + `    ai-erd auth login --role ${role}${endpointFlag}\n\n`
      + "Then run init again. The role is carried by the access token, so each role signs in once.",
    );
  }
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof McpRpcError
    && error.code === "MCP_HTTP_ERROR"
    && (error.details as { status?: number } | undefined)?.status === 401;
}

async function createProject(options: InitCommandOptions, name: string): Promise<{ uuid: string; name: string }> {
  const result = await callOrExplainSignIn(options, () =>
    options.client.toolsCall("create_projects", { items: [{ name }] }));
  const created = extractProjects(unwrapToolJson(result));
  const first = created[0];
  if (!first) {
    throw new Error("Project creation did not return a project uuid.");
  }
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
    await assertInsideRepository(root, path);
    snapshot.set(path, await readIfExists(join(root, path)));
  }
  return snapshot;
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

function readManaged(config: string | undefined): ManagedRecord | undefined {
  if (!config) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(config) as { managed?: Partial<ManagedRecord> };
    if (!parsed.managed) {
      return undefined;
    }
    return {
      ...emptyManagedRecord(),
      ...parsed.managed,
      created: Array.isArray(parsed.managed.created) ? parsed.managed.created : [],
      blockAdded: Array.isArray(parsed.managed.blockAdded) ? parsed.managed.blockAdded : [],
      replacedEntries: isRecord(parsed.managed.replacedEntries) ? parsed.managed.replacedEntries : {},
    };
  } catch {
    return undefined;
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
    for (const write of orderedWrites(plan.writes)) {
      // ②그리고 «쓰기 직전에» 다시 본다. ①과 실제 쓰기 사이에 누가 고칠 수 있다 — 그 틈으로
      //   남의 편집이 덮여 나갔다(같은 항목). 검사와 쓰기를 붙여 놓으면 창이 작아진다.
      await assertUnchangedSinceSnapshot(root, write.path, snapshot);
      await writeManagedFile(root, write);
      applied.push(write.path);
    }
    for (const path of plan.deletes) {
      await assertUnchangedSinceSnapshot(root, path, snapshot);
      await rm(join(root, path), { force: true });
      applied.push(path);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\nAlready applied before this failure: ${applied.join(", ") || "(nothing)"}`,
    );
  }
  // 우리 파일을 다 뺐고 디렉터리가 비었으면 그것도 치운다.
  // ⛔recursive 로 지우지 않는다 — 사용자가 그 안에 둔 다른 파일까지 날아간다.
  //   rmdir 는 «비어 있을 때만» 성공하므로, 비었는지는 파일시스템이 판정한다.
  // ★예전엔 .ai-erd 만 치워서 .cursor 가 빈 껍데기로 남았다 — undo 가 「지웠다」고
  //   말하면서 자취를 남긴 것이다(2026-09-23 실물 실행에서 발견). 지운 파일의 부모를
  //   전부 같은 규칙으로 다룬다.
  for (const directory of parentDirectoriesOf(plan.deletes)) {
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
function orderedWrites(writes: readonly FileWrite[]): FileWrite[] {
  const record = writes.filter((write) => write.path === HARNESS_CONFIG_PATH);
  const rest = writes.filter((write) => write.path !== HARNESS_CONFIG_PATH);
  return [...record, ...rest];
}

/** 지운 파일들의 «저장소 안» 부모 디렉터리. 저장소 뿌리(".")는 대상이 아니다. */
function parentDirectoriesOf(deleted: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of deleted) {
    const parent = dirname(path);
    if (parent && parent !== "." && parent !== sep) {
      directories.add(parent);
    }
  }
  // 깊은 것부터 — .a/b 를 치워야 .a 가 비워진다.
  return [...directories].sort((left, right) => right.length - left.length);
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
async function writeManagedFile(root: string, write: FileWrite): Promise<void> {
  const absolutePath = join(root, write.path);
  await mkdir(dirname(absolutePath), { recursive: true });
  const previousMode = await fileMode(absolutePath);
  const tmpPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
  // 임시 파일도 «처음부터» 좁게 만든다 — 넓게 만들었다가 좁히면 그 사이가 창이다.
  await writeFile(tmpPath, write.content, { encoding: "utf8", mode: previousMode ?? 0o600 });
  if (previousMode !== undefined) {
    await chmod(tmpPath, previousMode);
  }
  await rename(tmpPath, absolutePath);
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
