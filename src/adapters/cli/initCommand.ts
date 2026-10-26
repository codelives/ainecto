import { chmod, mkdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isDefaultEndpointFor } from "../../core/config/endpoints";
import { renderSuccess } from "../../core/output/render";
import {
  initRefusal,
  MANAGED_PATHS,
  planAgentName,
  planInit,
  planUndo,
  type FileWrite,
  type InitPlan,
  withCreatedDirectories,
} from "../../core/harness/initPlan";
import { AGENT_NOTE_KEY, DOC_KEY, HARNESS_DOC_PATH, HARNESS_RECORD_PATH } from "../../core/harness/harnessDoc";
import { AGENT_TARGETS, REMOTE_SIGN_IN } from "../../core/harness/agentTargets";
import { fetchHarnessDocuments, type HarnessDocuments } from "../../core/harness/documentFetch";
import { agentNameOf } from "../../core/harness/agentName";
import {
  assertInsideRepository,
  findGitRoot,
  readIfExists,
  readManagedFile,
} from "../../core/harness/repositoryFiles";

export interface InitCommandOptions {
  argv: string[];
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
   * 브라우저 로그인(= {@code ainecto auth login} 과 같은 함수). 없으면 로그인하지 않는다.
   *
   * <p>★init 은 사람이나 에이전트가 «명시적으로» 친 명령이라 여기서 로그인한다. 브리지({@code ainecto mcp})는
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

interface InitArgs {
  /** MCP 설정 파일도 쓴다(설계 결정 #6). 없으면 «우리 브리지 항목이 이미 있는» 파일만 갱신한다. */
  mcp: boolean;
  /** 서버 주소 대신 로컬 중계로 쓴다(setup --local 과 같은 뜻). */
  local: boolean;
  dryRun: boolean;
  undo: boolean;
  /** {@code --agent <이름>} — 이 폴더의 에이전트 이름(앞뒤 공백만 걷은 값). */
  agent?: string;
  /** 0.7.x 의 플래그 — 받아서 무시한다(멈추지 않는다). 안내 한 줄에 이름을 싣는다. */
  ignored: string[];
}

/**
 * {@code ainecto init} — 이 저장소에 AiNecto 작업 규칙을 둔다(설계 §4-2, 0.8.0).
 *
 * <p>★<b>저장소 규칙만 한다.</b> 세션 역할도, 프로젝트 고르기·만들기도 없다 — 도구와 권한은 서버가
 * 사용자 권한으로 정하고, 저장소는 한 프로젝트에 묶이지 않는다. 기기 전역의 에이전트 연결은 {@code setup} 이다.
 * <ul>
 *   <li>쓰는 것: {@code .ainecto/HARNESS.md} · {@code AGENTS.md} 관리 블록(·{@code CLAUDE.md} 가 있으면) ·
 *       {@code .ainecto/config.json}(v2) · 기록.</li>
 *   <li>MCP 설정 파일은 {@code --mcp} 일 때만 — 단 우리 항목이 이미 있으면 다시 쓴다(옛 로컬 중계 → 서버
 *       주소, {@code --local} 이면 판 고정한 로컬 중계). 옛 저장소의 이행은 이 재실행 하나다.</li>
 *   <li>{@code --dry-run} 도 서버 문서를 받는다 — 계획이 실제 실행과 같아야 한다(요구서 8장 P1).</li>
 * </ul>
 */
export async function executeInitCommand(options: InitCommandOptions): Promise<number> {
  const args = parseInitArgs(options.argv);
  if (args.ignored.length > 0) {
    options.io.stderr.write(
      `Ignored ${args.ignored.join(", ")}: init no longer asks for a role or a project — `
      + "every session sees the same tools and your AiNecto permissions decide what they may change.\n",
    );
  }
  const root = resolve(options.cwd);
  // ★하위 폴더에서 치면 멈춘다. 그 자리에 .mcp.json 을 쓰면 에이전트는 루트에서 그것을 못 본다.
  //   undo 도 같은 이유로 루트에서만 한다(기록이 루트에 있다).
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

  // ★<b>원격을 건드리기 «전»에 기록을 본다</b>(9차 1차 리뷰 B7) — 로그인 창을 띄운 뒤 거절하지 않는다.
  const refusal = initRefusal(files);
  if (refusal !== undefined) {
    throw new Error(refusal);
  }

  const signedIn = await ensureSignedIn(options, args.dryRun);
  const documents: HarnessDocuments = signedIn
    ? await fetchHarnessDocuments({
      endpoint: options.endpoint,
      accessToken: await options.accessToken?.(),
      // 서버가 문서의 클라이언트별 변형 키를 이 이름으로 찾는다.
      client: "ainecto-cli",
      // ★init 의 인증된 호출 하나 — 같은 이름을 실어, 서버가 거절하는 이름이면 파일을 쓰기 전에 멈춘다.
      agentName: planAgentName(args.agent, files),
      fetchImpl: options.fetchImpl,
    })
    : { versions: {}, fallbacks: {}, unavailableReason: args.dryRun ? "not signed in, and --dry-run does not sign in" : "not signed in" };

  const plan = planInit({
    env: options.env,
    endpoint: options.endpoint,
    mcp: args.mcp,
    local: args.local,
    cliVersion: options.cliVersion,
    files,
    documents,
    agentName: args.agent,
  });
  if (plan.refusal !== undefined) {
    // ★계획이 「멈춰라」고 하면 멈춘다(2026-09-27 8차 독립 리뷰 I1). 같은 함수라 위의 판정과 갈리지 않는다.
    throw new Error(plan.refusal);
  }
  await applyPlan(root, plan, args.dryRun, files);

  const mcpWritten = plan.writes.some((write) => AGENT_TARGETS.some((target) => target.path === write.path));
  options.io.stdout.write(renderSuccess(
    {
      action: args.dryRun ? "init (dry-run)" : "init",
      endpoint: options.endpoint,
      written: plan.writes.map((write) => `${write.existed ? "updated" : "created"} ${write.path}`),
      // ⚠조용히 기본값으로 떨어지지 않는다 — 서버에서 규칙을 고쳐도 안 바뀌는 이유를 사용자가 영영 못 찾는다.
      //   ★요청 자체의 실패와 «문서별» 되돌림을 둘 다, 어느 «파일»이 그 글을 받는지까지 적는다.
      notes: [...rootNotes, ...plan.notes, ...fallbackNotes(documents, args.dryRun)],
      next: [
        `Read ${HARNESS_DOC_PATH} first. Every session sees the same AiNecto tools; your AiNecto permissions decide what they may change.`,
        mcpWritten
          ? "Claude Code and Cursor pick up the repository's MCP config in a new session."
          : "To connect your coding agents on this machine, run `ainecto setup` once"
            + " (or re-run init with --mcp to also write this repository's .mcp.json and .cursor/mcp.json).",
        // 서버 주소를 썼으면 에이전트가 따로 로그인한다 — setup 과 같은 안내 표 하나.
        ...(mcpWritten && !args.local
          ? [`Each agent signs in to AiNecto by itself the first time: ${AGENT_TARGETS.map((target) => REMOTE_SIGN_IN[target.id]).filter(Boolean).join("; ")}.`]
          : []),
        "Undo everything with: ainecto init --undo",
      ],
    },
    { json: options.json },
  ));
  return 0;
}

/**
 * 패키지 기본값을 쓴 사실과 그 이유 — ★어느 파일이 그 글을 받는지까지. 없으면 빈 배열.
 * dry-run 이면 «실제 실행과 다를 수 있다»를 붙인다(서버 판을 못 받았으므로).
 */
function fallbackNotes(documents: HarnessDocuments, dryRun: boolean): string[] {
  const filesOf: Record<string, string> = {
    [DOC_KEY]: HARNESS_DOC_PATH,
    [AGENT_NOTE_KEY]: "AGENTS.md / CLAUDE.md",
  };
  const caveat = dryRun ? " — the real run may write the server's version instead" : "";
  const reasons: Record<string, string> = documents.unavailableReason
    ? { [DOC_KEY]: documents.unavailableReason, [AGENT_NOTE_KEY]: documents.unavailableReason }
    : documents.fallbacks;
  return Object.entries(reasons).map(([key, reason]) =>
    `${filesOf[key] ?? key}: written from this package's default ${key}, not the server's (${reason})${caveat}.`);
}

/**
 * ★<b>문서를 받기 전에 로그인을 확인한다.</b> 토큰이 없으면(만료 + refresh 없음 포함) 브라우저 로그인을
 * 하고 이어서 진행한다(합격 시나리오 4). 로그인됐으면 true.
 *
 * <p>⚠{@code --dry-run} 은 브라우저를 띄우지도 토큰을 갱신하지도 않는다 — 「아무것도 바꾸지 않는다」는
 * 약속에 사용자의 로그인 상태도 든다. 그때는 false 를 돌려주고, 계획은 패키지 기본값 기준임을 파일별로 적는다.
 */
async function ensureSignedIn(options: InitCommandOptions, dryRun: boolean): Promise<boolean> {
  if (await options.accessToken?.()) {
    return true;
  }
  if (dryRun || options.login === undefined) {
    if (dryRun) {
      options.io.stderr.write(`No usable AiNecto sign-in, so this plan uses the package's default rules. Sign in with: ${loginCommand(options)}\n`);
    }
    return false;
  }
  await options.login();
  options.io.stderr.write("Signed in.\n");
  return true;
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

/**
 * 이 서버에 맞는 로그인 명령 한 줄. ★<b>만드는 곳은 여기 하나다.</b>
 *
 * <p>⚠주소든 env 든 <b>하나는 반드시</b> 실린다 — 안 실으면 dev 에서 막힌 사람이 «운영»에 로그인한다
 * (2026-09-23 4차 독립 리뷰 S2).
 */
export function loginCommand(options: Pick<InitCommandOptions, "env" | "endpoint">): string {
  const target = isDefaultEndpointFor(options.env, options.endpoint)
    ? (options.env === "prod" ? "" : ` --env ${options.env}`)
    : ` --endpoint ${options.endpoint}`;
  return `ainecto auth login${target}`;
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
    // ★<b>복구 기록을 먼저 쓴다.</b> 예전엔 관리 기록(config.json)이 «마지막» 쓰기였다.
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
  const args: InitArgs = { mcp: false, local: false, dryRun: false, undo: false, ignored: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--mcp") {
      args.mcp = true;
    } else if (arg === "--local") {
      args.local = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--undo") {
      args.undo = true;
    } else if (arg === "--agent") {
      const name = agentNameOf(argv[index + 1]?.startsWith("--") ? undefined : argv[index + 1]);
      if (name === undefined) {
        throw new Error("--agent requires a name.");
      }
      args.agent = name;
      index += 1;
    } else if (arg === "--project" || arg === "--project-name") {
      // 0.7.x — 값까지 삼키고 무시한다. 값이 없으면 플래그만.
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith("--")) {
        index += 1;
      }
      args.ignored.push(arg);
    } else if (arg === "--yes" || arg === "-y") {
      args.ignored.push(arg);
    } else if (arg === "--json") {
      // 전역 플래그 — 여기선 무시한다.
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
