import {
  AGENT_TARGETS,
  readServerEntry,
  buildServerEntry,
  codexAddCommand,
  codexProfileSetup,
  codexRemoveCommand,
  mergeServerEntry,
  readRoleFromEntry,
  removeServerEntry,
  SERVER_NAME,
} from "./agentTargets";
import {
  existingMarkerBlock,
  HARNESS_CONFIG_PATH,
  HARNESS_DOC_PATH,
  MARKER_BEGIN,
  removeMarkerBlock,
  replaceMarkerBlockWith,
  renderAgentNote,
  renderHarnessDoc,
  upsertMarkerBlock,
} from "./harnessDoc";
import { createHash } from "node:crypto";
import { ROLE_ENV_VAR, type HarnessRole } from "./role";

/**
 * init 이 «무엇을 쓸지»를 순수하게 계산한다. 파일을 읽지도 쓰지도 않는다.
 *
 * ★<b>계획과 적용을 가른 이유.</b> 이 명령은 남의 저장소에 파일을 쓴다 — 가장 위험한 종류의
 * 일이다. 계산이 순수하면 「어떤 상태에서 무엇을 쓰는가」를 전부 시험으로 고정할 수 있고,
 * {@code --dry-run} 이 «진짜로 일어날 일»을 그대로 보여 준다(따로 만든 미리보기가 아니다).
 */

/** 규칙 블록을 넣을 지침 파일. 없으면 만드는 것과 있을 때만 고치는 것을 구분한다. */
const NOTE_TARGETS = [
  { path: "AGENTS.md", createIfMissing: true },
  { path: "CLAUDE.md", createIfMissing: false },
] as const;

export const MANAGED_PATHS: readonly string[] = [
  ...AGENT_TARGETS.map((target) => target.path),
  ...NOTE_TARGETS.map((target) => target.path),
  HARNESS_DOC_PATH,
  HARNESS_CONFIG_PATH,
];

/** 경로 → 현재 내용. 값이 {@code undefined} 면 «파일 없음». */
export type FileSnapshot = ReadonlyMap<string, string | undefined>;

export interface FileWrite {
  path: string;
  content: string;
  existed: boolean;
}

export interface InitPlan {
  writes: FileWrite[];
  deletes: string[];
  /** 사용자가 직접 칠 명령 — 우리가 전역 설정을 고치지 않는다. */
  codexCommand: string;
  /** Codex 에서 세션마다 역할을 바꾸는 법(프로필). 되돌리기 계획에는 없다. */
  codexProfile?: string[];
  notes: string[];
  /** init 계획이 남기는 기록. {@code .ai-erd/config.json} 에 함께 저장된다. */
  managed?: ManagedRecord;
  /**
   * 되돌리기가 «치워도 되는» 디렉터리 — 우리가 만든 것뿐이다.
   *
   * <p>★예전엔 「지운 파일의 부모가 비었으면 치운다」였다. 그러면 init 전부터 있던 빈
   * {@code .cursor} 까지 사라진다(2026-09-23 4차 독립 리뷰 S3). 비었다는 것과 우리 것이라는
   * 것은 다른 사실이다.
   */
  removableDirectories?: string[];
}

/**
 * init 이 «무엇을 했는지»의 기록. ★undo 는 이것만 보고 되돌린다.
 *
 * <p>이게 없던 동안 undo 는 「우리가 쓰는 이름이면 지운다」였고, 그래서 init 전부터 있던
 * {@code .ai-erd/HARNESS.md} 나 사용자의 빈 {@code AGENTS.md} 까지 지웠다
 * (2026-09-22 독립 리뷰 I2). 되돌리기는 «한 일»을 알아야 성립한다.
 */
export interface ManagedRecord {
  /** 우리가 «만든» 파일. undo 에서 지워도 되는 것은 이것뿐이다. */
  created: string[];
  /** 우리가 밀어낸 사용자 MCP 항목. undo 가 도로 넣는다. */
  replacedEntries: Record<string, unknown>;
  /** 우리가 규칙 블록을 «넣은» 파일. 블록 제거는 이 목록에 한한다. */
  blockAdded: string[];
  /** 우리가 밀어낸 «기존 규칙 블록» 원문. undo 가 도로 넣는다. */
  replacedBlocks: Record<string, string>;
  /** 우리가 통째로 덮어쓴 파일의 원본(.ai-erd/*). undo 가 되돌린다. */
  originals: Record<string, string>;
  /**
   * ★우리가 마지막으로 «쓴» 내용의 지문. undo 가 지우기 전에 이것과 대조한다.
   * 다르면 사용자가 그 뒤에 손댄 것이므로 지우지 않고 보고한다.
   */
  lastWritten: Record<string, string>;
  /**
   * ★우리가 «소유한 조각»의 지문 — MCP 항목 하나, 또는 관리 블록 하나.
   *
   * <p>파일 전체 지문만으로는 「남이 다른 항목을 더했다」와 「우리 항목을 손댔다」를 구별하지
   * 못한다. 그래서 undo 가 파일은 남기면서 <b>사용자가 우리 블록 안에 적은 글을 지웠다</b>
   * (2026-09-23 독립 재리뷰 I8). 조각 단위로 견주면 그 둘이 갈린다.
   */
  lastWrittenFragment: Record<string, string>;
  /** 우리가 «만든» 디렉터리. undo 에서 비워졌을 때 치워도 되는 것은 이것뿐이다. */
  createdDirectories: string[];
}

export function emptyManagedRecord(): ManagedRecord {
  return {
    created: [], replacedEntries: {}, blockAdded: [], replacedBlocks: {},
    originals: {}, lastWritten: {}, lastWrittenFragment: {}, createdDirectories: [],
  };
}

/**
 * 직전 기록을 이어받는다.
 *
 * <p>★<b>칸 목록의 진실원은 {@link emptyManagedRecord} 하나다.</b> 예전엔 여기서 칸을 하나씩
 * 손으로 베꼈고, {@code lastWrittenFragment} 를 더하면서 이 자리를 안 고쳤다. 그 결과 «내용이
 * 같은» 두 번째 init 뒤에 조각 지문이 전부 사라져, 소유권 판정이 파일 전체 지문으로 후퇴했다
 * (2026-09-23 4차 독립 리뷰 I3). 칸이 늘 때마다 잊을 수 있는 자리를 남기지 않는다.
 *
 * <p>배열은 이어 붙이고 객체는 덮어쓴다 — 둘 다 «직전 것이 이긴다».
 */
function carryForward(previous: ManagedRecord | undefined): ManagedRecord {
  const fresh = emptyManagedRecord() as unknown as Record<string, unknown>;
  const before = (previous ?? {}) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, blank] of Object.entries(fresh)) {
    const carried = before[key];
    out[key] = Array.isArray(blank)
      ? [...(Array.isArray(carried) ? (carried as unknown[]) : [])]
      : { ...(carried && typeof carried === "object" ? (carried as object) : {}) };
  }
  return out as unknown as ManagedRecord;
}

/**
 * 이 «경로»에 대한 기록을 전부 지운다.
 *
 * <p>★칸을 손으로 세지 않는다 — {@link emptyManagedRecord} 의 모양을 훑어 배열이면 걸러내고
 * 객체면 그 키를 지운다. 칸이 늘 때 이 자리를 잊는 실수를 이미 한 번 했다
 * ({@code carryForward}, 2026-09-23 4차 독립 리뷰 I3).
 *
 * <p>⚠{@code createdDirectories} 는 «디렉터리» 목록이라 파일 경로와 절대 같아지지 않는다 —
 * 같은 훑기에 들어와도 걸리는 것이 없다.
 */
function forgetPath(record: ManagedRecord, path: string): void {
  const fields = record as unknown as Record<string, unknown>;
  for (const key of Object.keys(emptyManagedRecord())) {
    const value = fields[key];
    if (Array.isArray(value)) {
      fields[key] = value.filter((entry) => entry !== path);
    } else if (value && typeof value === "object") {
      delete (value as Record<string, unknown>)[path];
    }
  }
}

/** 내용 지문. 암호학적 용도가 아니라 «바뀌었나»만 본다. */
export function contentFingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 조각 지문. 조각이 없으면 «없음»을 뜻하는 고정값 — undefined 와 빈 문자열을 구별한다. */
function fragmentFingerprint(fragment: unknown): string {
  return fragment === undefined
    ? "absent"
    : contentFingerprint(typeof fragment === "string" ? fragment : stableStringify(fragment));
}

function serialize(body: unknown): string {
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * 객체 칸의 «순서»를 지운 JSON.
 *
 * <p>★{@code JSON.parse}→{@code stringify} 는 공백은 정규화하지만 칸 순서는 그대로 둔다.
 * 그래서 사람이 편집기로 열었다 저장만 해도(칸 순서가 바뀌면) 「사용자가 고쳤다」로 잡혔다
 * (2026-09-23 4차 독립 리뷰 S1). 우리가 보려는 것은 «내용»이지 적힌 순서가 아니다.
 *
 * <p>⚠배열 순서는 유지한다 — 거기선 순서가 곧 내용이다(MCP 인자 목록 등).
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 이 경로의 내용 지문. JSON 파일은 칸 순서를 지운 정규형으로 잰다. */
function fingerprintFor(path: string, content: string): string {
  if (path === HARNESS_CONFIG_PATH) {
    return configFingerprint(content);
  }
  if (!path.endsWith(".json")) {
    return contentFingerprint(content);
  }
  try {
    return contentFingerprint(stableStringify(JSON.parse(content)));
  } catch {
    return contentFingerprint(content);
  }
}

/**
 * {@code .ai-erd/config.json} 의 «자기 지문 칸을 뺀» 정규형의 지문.
 *
 * <p>★쓸 때와 볼 때가 <b>같은 규칙</b>을 써야 한다. 파일이 JSON 이 아니면 파일 전체 지문으로
 * 물러선다 — 그래야 「깨진 파일」이 조용히 「안 바뀐 파일」이 되지 않는다.
 */
export function configFingerprint(content: string): string {
  try {
    const parsed = JSON.parse(content) as { managed?: { lastWritten?: Record<string, string> } };
    if (parsed?.managed?.lastWritten) {
      delete parsed.managed.lastWritten[HARNESS_CONFIG_PATH];
    }
    return contentFingerprint(stableStringify(parsed));
  } catch {
    return contentFingerprint(content);
  }
}

export interface PlanInitInput {
  role: HarnessRole;
  env?: "prod" | "dev";
  projectName: string;
  projectUuid: string;
  endpoint: string;
  cliVersion: string;
  files: FileSnapshot;
  /** 직전 init 의 기록. 재실행에서 「이미 우리가 만든 파일」을 잊지 않으려면 필요하다. */
  previous?: ManagedRecord;
  /** 서버에서 받은 문서 본문. 없으면 패키지 기본값(= 오프라인 기본값)을 쓴다. */
  documents?: { doc?: string; agentNote?: string; versions?: Record<string, string> };
}

export function planInit(input: PlanInitInput): InitPlan {
  const entry = buildServerEntry({ role: input.role, env: input.env, endpoint: input.endpoint });
  const writes: FileWrite[] = [];
  const notes: string[] = [];
  const managed: ManagedRecord = carryForward(input.previous);
  /** 「우리가 이 파일을 전에 만졌다」는 기록이 이미 있나. */
  const alreadyOurs = (path: string) =>
    managed.created.includes(path) || managed.lastWritten[path] !== undefined;
  const remember = (path: string, existing: string | undefined) => {
    if (existing === undefined) {
      if (!managed.created.includes(path)) {
        managed.created.push(path);
      }
    } else if (!alreadyOurs(path) && managed.originals[path] === undefined) {
      // 우리가 처음 만지는 «남의» 파일 — 원본을 기억한다.
      managed.originals[path] = existing;
    }
  };

  /**
   * ★<b>이어받은 기록이 아직 참인지 다시 판정한다.</b>
   *
   * <p>기록은 «지난 실행의 주장»이고 그 사이에 파일이 바뀌었을 수 있다. 지금 들어 있는 것이
   * 우리가 쓴 조각도 아니고 백업해 둔 원본도 아니면, 그건 사용자가 새로 적은 값이고 우리
   * 백업은 낡은 것이다. 예전엔 그냥 이어받아서, 되돌리기가 «두 판 전» 값을 복원하며 사용자가
   * 그 뒤에 적은 값을 잃었다(2026-09-27 6차 독립 리뷰 I3).
   *
   * <p>⚠판단 재료가 없으면(지문이 없던 판의 기록, 파일 자체가 없음) 그대로 둔다 —
   * 「모르겠으면 백업을 지킨다」가 이 자리의 안전한 쪽이다.
   */
  const forgetIfStale = (path: string, current: unknown, backup: unknown) => {
    const stamp = managed.lastWrittenFragment[path];
    if (stamp === undefined || current === undefined) {
      return;
    }
    const now = fragmentFingerprint(current);
    if (now === stamp || now === fragmentFingerprint(backup)) {
      return; // 우리 것 그대로거나, 이미 원본으로 돌아가 있다.
    }
    forgetPath(managed, path);
    notes.push(`${path}: it changed outside ai-erd, so the older backup was dropped and this is the new baseline.`);
  };
  /** 통째로 덮는 파일은 «파일 지문»으로 같은 판정을 한다. */
  const forgetIfFileStale = (path: string, current: string | undefined) => {
    const stamp = managed.lastWritten[path];
    if (stamp === undefined || current === undefined) {
      return;
    }
    const now = fingerprintFor(path, current);
    const original = managed.originals[path];
    if (now === stamp || (original !== undefined && now === fingerprintFor(path, original))) {
      return;
    }
    forgetPath(managed, path);
    notes.push(`${path}: it changed outside ai-erd, so the older backup was dropped and this is the new baseline.`);
  };

  for (const target of AGENT_TARGETS) {
    const existing = input.files.get(target.path);
    forgetIfStale(target.path, existing === undefined ? undefined : readServerEntry(existing),
      managed.replacedEntries[target.path]);
    const merged = mergeServerEntry(existing, entry);
    if (existing === merged.content) {
      continue;
    }
    const wasOurs = alreadyOurs(target.path);
    remember(target.path, existing);
    if (merged.replaced) {
      const previous = previousRole(existing);
      if (previous && previous !== input.role) {
        notes.push(`${target.path}: role ${previous} → ${input.role}`);
      }
      // ★«우리가 전에 쓴 적 없는» 항목을 밀어냈다면 원본을 기억한다 — undo 가 도로 넣는다.
      //   예전엔 「args 에 역할이 있으면 우리 것」으로 봤는데, 사용자가 우연히 같은 모양으로
      //   적어 둔 항목(자기 command·env 포함)까지 우리 것으로 삼켰다(독립 재리뷰 I2).
      if (!wasOurs && merged.replacedEntry !== undefined
          && managed.replacedEntries[target.path] === undefined) {
        managed.replacedEntries[target.path] = merged.replacedEntry;
        notes.push(`${target.path}: your existing "${SERVER_NAME}" entry was saved and will be restored by --undo`);
      }
    }
    writes.push({ path: target.path, content: merged.content, existed: existing !== undefined });
    managed.lastWritten[target.path] = fingerprintFor(target.path, merged.content);
    managed.lastWrittenFragment[target.path] = fragmentFingerprint(readServerEntry(merged.content));
  }

  const existingDoc = input.files.get(HARNESS_DOC_PATH);
  forgetIfFileStale(HARNESS_DOC_PATH, existingDoc);
  const docContent = renderHarnessDoc({
    projectName: input.projectName,
    projectUuid: input.projectUuid,
    endpoint: input.endpoint,
  }, input.documents?.doc);
  const docWasOurs = alreadyOurs(HARNESS_DOC_PATH);
  remember(HARNESS_DOC_PATH, existingDoc);
  if (existingDoc !== undefined && !docWasOurs) {
    notes.push(`${HARNESS_DOC_PATH} already existed; its original was saved and --undo will restore it.`);
  }
  writes.push({ path: HARNESS_DOC_PATH, content: docContent, existed: existingDoc !== undefined });
  managed.lastWritten[HARNESS_DOC_PATH] = fingerprintFor(HARNESS_DOC_PATH, docContent);

  const existingConfig = input.files.get(HARNESS_CONFIG_PATH);
  remember(HARNESS_CONFIG_PATH, existingConfig);

  const note = renderAgentNote(input.documents?.agentNote);
  for (const target of NOTE_TARGETS) {
    const existing = input.files.get(target.path);
    if (existing === undefined && !target.createIfMissing) {
      // AGENTS.md 로 이미 닿으므로 파일을 새로 만들지 않는다. 있으면 거기도 얹는다.
      notes.push(`${target.path} not found — skipped; AGENTS.md already reaches this agent.`);
      continue;
    }
    forgetIfStale(target.path, existing === undefined ? undefined : existingMarkerBlock(existing),
      managed.replacedBlocks[target.path]);
    let content: string;
    try {
      content = upsertMarkerBlock(existing, note);
    } catch (error) {
      // ★우리 블록을 «다시 찾을 수 있게» 넣을 수 없는 파일이다 — 그 파일만 건너뛰고 나머지
      //   init 은 계속한다. 손대지 않는 것이 이 자리의 정답이고, init 전체를 죽이는 것은
      //   아니다(MCP 설정·HARNESS.md 는 여전히 맞게 써야 한다).
      notes.push(`${target.path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (content === existing) {
      continue;
    }
    const noteWasOurs = alreadyOurs(target.path);
    remember(target.path, existing);
    // ★우리가 «밀어낸» 기존 블록이 있으면 그 원문을 기억한다 — undo 가 도로 넣는다.
    if (!noteWasOurs && existing !== undefined && managed.replacedBlocks[target.path] === undefined) {
      const previousBlock = existingMarkerBlock(existing);
      if (previousBlock) {
        managed.replacedBlocks[target.path] = previousBlock;
        notes.push(`${target.path}: an existing ai-erd block was saved and will be restored by --undo`);
      }
    }
    writes.push({ path: target.path, content, existed: existing !== undefined });
    managed.lastWritten[target.path] = fingerprintFor(target.path, content);
    managed.lastWrittenFragment[target.path] = fragmentFingerprint(existingMarkerBlock(content));
    if (!managed.blockAdded.includes(target.path)) {
      managed.blockAdded.push(target.path);
    }
  }

  // ★<b>「우리가 만들 디렉터리」를 여기서 «예측하지» 않는다.</b> 예전엔 「지금 없으니 우리가
  //   만들 것」으로 기록했다. 그런데 만들기 전에 init 이 실패하거나, 계획과 적용 사이에
  //   사용자가 그 디렉터리를 만들면, 되돌리기가 «남의» 디렉터리를 지웠다. 뒤에 stat 으로
  //   고치려 했지만 stat 은 「있다」만 말하고 「누가 만들었나」는 말하지 못한다
  //   (2026-09-23 5차 S1 → 2026-09-27 6차 S1).
  //   ⇒ 이 칸의 진실원은 {@code mkdir(recursive)} 의 반환값 하나다. 적용이 채운다.
  //     (직전 실행에서 이어받은 것은 carryForward 가 들고 있다.)

  // ⛔역할을 여기 적지 않는다 — 진실원은 MCP 설정 한 곳이다.
  const configBody = configBodyOf({
    projectUuid: input.projectUuid,
    projectName: input.projectName,
    endpoint: input.endpoint,
    cliVersion: input.cliVersion,
    // ★어느 판의 규칙으로 썼나. 이게 없으면 「무엇이 적혀 있었나」를 나중에 못 되짚는다.
    versions: input.documents?.versions ?? {},
    managed,
  });
  // ★<b>자기 지문을 «자기를 뺀 모습»으로 잰다.</b> 예전엔 문자열을 만든 뒤에 지문을 넣어서
  //   파일에는 자기 지문이 «없었고», 그러면 사용자가 config 를 고쳐도 undo 가 못 알아보고
  //   지웠다(2026-09-23 독립 재리뷰 I7). 그렇다고 대입 순서만 바꾸면 자기 해시를 담은 문서의
  //   해시라는 순환이 생긴다 — 그래서 비교 대상을 «이 칸을 뺀 정규형»으로 못 박는다.
  managed.lastWritten[HARNESS_CONFIG_PATH] = configFingerprint(serialize(configBody));
  const configContent = serialize(configBody);
  writes.push({
    path: HARNESS_CONFIG_PATH,
    content: configContent,
    existed: existingConfig !== undefined,
  });

  return {
    writes,
    deletes: [],
    codexCommand: codexAddCommand({ role: input.role, env: input.env, endpoint: input.endpoint }),
    codexProfile: codexProfileSetup({ role: input.role, env: input.env, endpoint: input.endpoint }),
    notes,
    managed,
  };
}

export interface PlanUndoInput {
  files: FileSnapshot;
  /** {@code .ai-erd/config.json} 에 남긴 기록. 없으면 «지우지 않고» 뺄 것만 뺀다. */
  managed?: ManagedRecord;
}

/**
 * ★<b>우리가 쓴 것만 되돌린다.</b> 남의 서버 항목, 사용자가 표식 밖에 적은 글은 그대로 둔다.
 * 파일을 지우는 것은 «우리 것만 남아 있던 파일»뿐이다.
 */
export function planUndo(input: PlanUndoInput): InitPlan {
  const writes: FileWrite[] = [];
  const deletes: string[] = [];
  const notes: string[] = [];
  const managed = input.managed;
  /**
   * ★되돌리지 «못한» 것이 하나라도 있나.
   *
   * <p>있으면 관리 기록(config)을 지우지도 옛 것으로 덮지도 않는다 — 그 기록 안에 아직
   * 못 돌려놓은 «원본 백업»이 들어 있다. 예전엔 충돌을 남긴 바로 그 실행이 기록을 지워서,
   * 사람이 충돌을 풀고 다시 undo 해도 원본을 못 찾았다(2026-09-23 4차 독립 리뷰 I2).
   */
  let unresolved = false;

  if (!managed) {
    // ★기록이 없으면 «아무것도» 되돌리지 않는다. 예전엔 이름이 우리 것이면 지웠는데,
    //   init 을 한 적도 없는 저장소의 사용자 항목까지 지웠다(2026-09-23 독립 재리뷰 I2).
    notes.push("No record of a previous init in .ai-erd/config.json — no local file was changed.");
    notes.push(`Codex keeps its own global config — remove it with: ${codexRemoveCommand()}`);
    notes.push(`If you set ${ROLE_ENV_VAR} anywhere, unset it too.`);
    return { writes, deletes, codexCommand: codexRemoveCommand(), notes };
  }

  /**
   * ★<b>항목별로 «끝났는지»를 기록에 반영한다.</b>
   *
   * <p>예전엔 기록을 남기거나 통째로 지우는 둘뿐이었다. 그래서 일부만 복구된 상태에서 다시
   * undo 하면 «이미 원본으로 돌아온» 항목을 「사용자가 고쳤다」고 보고 영영 충돌로 남았고,
   * 다음 init 은 그 항목의 낡은 원본을 계속 자기 것으로 이어받았다
   * (2026-09-23 5차 독립 리뷰 I3).
   *
   * <p>끝난 항목은 이 사본에서 지우고, 남은 것이 있으면 «줄어든» 기록을 다시 쓴다.
   */
  const remaining: ManagedRecord = carryForward(managed);
  const forget = (path: string) => forgetPath(remaining, path);
  /**
   * 되돌릴 «목표»와 지금 값이 같은가 — 같으면 이미 끝난 것이고 충돌이 아니다.
   *
   * <p>★<b>목표는 백업이 있으면 그 원본이고, 없으면 «없음»이다.</b> 예전엔 백업이 없을 때
   * 곧바로 false 를 돌려줬다. 그래서 우리가 «더한» 조각(= 되돌릴 목표가 「없음」인 것)을
   * 사용자가 손으로 지운 경우를 영영 충돌로 봤고, 반복 undo 가 끝나지 않았다
   * (2026-09-27 6차 독립 리뷰 I2).
   *
   * <p>{@link fragmentFingerprint} 가 undefined 를 {@code "absent"} 로 재기 때문에 두 종류의
   * 목표가 «한 비교»로 만난다 — 목표를 값으로 만들면 분기가 사라진다.
   */
  const restoreTarget = (path: string) =>
    managed.replacedEntries?.[path] ?? managed.replacedBlocks?.[path];
  const alreadyRestored = (path: string, current: unknown) =>
    fragmentFingerprint(current) === fragmentFingerprint(restoreTarget(path));
  const weCreated = (path: string) => managed.created.includes(path);
  /** 우리가 쓴 뒤에 사람이 손댔나. 손댔으면 지우지 않고 알린다. */
  const changedSinceOurWrite = (path: string) => {
    const current = input.files.get(path);
    const stamp = managed.lastWritten?.[path];
    if (current === undefined || stamp === undefined) {
      return false;
    }
    return fingerprintFor(path, current) !== stamp;
  };
  /**
   * 우리가 소유한 «조각»이 우리가 쓴 그대로인가.
   *
   * <p>★기록이 없던 판으로 쓴 설정이면 파일 전체 지문으로 물러선다. 판단 재료가 없을 때
   * «있다고 치지» 않는다.
   */
  const ourFragmentIsUntouched = (path: string, current: unknown) => {
    const stamp = managed.lastWrittenFragment?.[path];
    if (stamp === undefined) {
      return !changedSinceOurWrite(path);
    }
    return fragmentFingerprint(current) === stamp;
  };

  const dropOrKeep = (path: string) => {
    if (!weCreated(path)) {
      return;
    }
    if (changedSinceOurWrite(path)) {
      notes.push(`${path} was edited after init — left in place instead of deleting it.`);
      return;
    }
    deletes.push(path);
  };

  for (const target of AGENT_TARGETS) {
    const existing = input.files.get(target.path);
    const touched = weCreated(target.path) || managed.lastWritten?.[target.path] !== undefined;
    if (!touched) {
      continue;
    }
    if (existing === undefined) {
      // ★백업을 든 파일 자체가 없어졌다. 「없으니 건너뛴다」로 기록을 지우면 그 원본은
      //   영영 사라진다 — 사용자가 파일을 되살릴 수도 있다(2026-09-23 5차 독립 리뷰 I2).
      if (managed.replacedEntries?.[target.path] !== undefined) {
        notes.push(
          `${target.path} is gone, so your original "${SERVER_NAME}" entry could not be put back — `
          + "the backup is kept. Restore the file and run --undo again.",
        );
        unresolved = true;
      } else {
        forget(target.path);
      }
      continue;
    }
    if (alreadyRestored(target.path, readServerEntry(existing))) {
      // 이미 목표 상태다 — 끝난 일이다. 충돌로 세면 영영 안 끝난다.
      notes.push(restoreTarget(target.path) !== undefined
        ? `${target.path}: your original "${SERVER_NAME}" entry is already back in place.`
        : `${target.path}: the "${SERVER_NAME}" entry ai-erd added is already gone.`);
      forget(target.path);
      continue;
    }
    if (!ourFragmentIsUntouched(target.path, readServerEntry(existing))) {
      // ★사용자가 «우리 항목»을 손댔다. 지우면 그 편집이 사라진다 — 남기고 말한다.
      notes.push(
        `${target.path}: the "${SERVER_NAME}" entry was edited after init — left in place. `
        + "Remove it by hand if you meant to, then run --undo again.",
      );
      unresolved = true;
      continue;
    }
    const restore = managed.replacedEntries?.[target.path];
    const result = removeServerEntry(existing, restore);
    forget(target.path);
    if (result.emptied && weCreated(target.path) && !changedSinceOurWrite(target.path)) {
      deletes.push(target.path);
      continue;
    }
    if (result.content !== undefined && result.content !== existing) {
      writes.push({ path: target.path, content: result.content, existed: true });
      if (restore !== undefined) {
        notes.push(`${target.path}: restored your original "${SERVER_NAME}" entry.`);
      }
    } else if (!result.removed && restore !== undefined) {
      // 항목이 이미 사라진 뒤여도 백업은 도로 넣는다 — 「없으니 건너뛴다」가 유실이었다.
      notes.push(`${target.path}: your original "${SERVER_NAME}" entry was restored.`);
    }
  }

  for (const target of NOTE_TARGETS) {
    const existing = input.files.get(target.path);
    if (!(managed.blockAdded ?? []).includes(target.path)) {
      continue;
    }
    if (existing === undefined) {
      if (managed.replacedBlocks?.[target.path] !== undefined) {
        notes.push(
          `${target.path} is gone, so the ai-erd block that was there before could not be put back — `
          + "the backup is kept. Restore the file and run --undo again.",
        );
        unresolved = true;
      } else {
        forget(target.path);
      }
      continue;
    }
    if (existingMarkerBlock(existing) === undefined && existing.includes(MARKER_BEGIN)) {
      // ★마커가 파일에 «있는데» 우리 것으로 알아볼 수 없다 — 코드펜스 안이거나 들여썼다.
      //   「없으니 끝났다」로 기록을 지우면 블록은 남고 되돌릴 근거만 사라진다
      //   (2026-09-27 6차 독립 리뷰 I4). 알아볼 수 없다는 것은 없다는 뜻이 아니다.
      notes.push(
        `${target.path}: an ai-erd block is in this file but not where --undo can remove it `
        + "(inside a code fence, or indented). Remove it by hand, then run --undo again.",
      );
      unresolved = true;
      continue;
    }
    if (alreadyRestored(target.path, existingMarkerBlock(existing))) {
      notes.push(restoreTarget(target.path) !== undefined
        ? `${target.path}: the ai-erd block that was there before is already back in place.`
        : `${target.path}: the ai-erd block is already gone.`);
      forget(target.path);
      continue;
    }
    if (!ourFragmentIsUntouched(target.path, existingMarkerBlock(existing))) {
      // ★사용자가 우리 블록 «안에» 글을 적었다. 예전엔 그걸 빈 내용으로 갈아 끼웠다.
      notes.push(
        `${target.path}: the ai-erd block was edited after init — left in place. `
        + "Remove the block by hand if you meant to, then run --undo again.",
      );
      unresolved = true;
      continue;
    }
    const replaced = managed.replacedBlocks?.[target.path];
    let result: { content: string; removed: boolean; emptied: boolean };
    try {
      result = replaced !== undefined
        ? { content: replaceMarkerBlockWith(existing, replaced), removed: true, emptied: false }
        : removeMarkerBlock(existing);
    } catch (error) {
      // 표식 짝이 깨졌다 — 범위를 추측해서 지우지 않는다. 기록은 «지키고» 이유를 말한다.
      notes.push(`${target.path}: ${error instanceof Error ? error.message : String(error)}`);
      unresolved = true;
      continue;
    }
    if (!result.removed) {
      notes.push(
        `${target.path}: the ai-erd block could not be removed — it is still in the file. `
        + "Remove it by hand, then run --undo again.",
      );
      unresolved = true;
      continue;
    }
    // ★걷어낸 «뒤에» 기록에서 지운다. 예전엔 먼저 지우고 나서 제거를 시도해, 못 걷어낸
    //   블록이 파일에 남은 채 되돌릴 근거가 사라졌다(2026-09-27 6차 독립 리뷰 I4).
    forget(target.path);
    if (result.emptied && weCreated(target.path) && !changedSinceOurWrite(target.path)) {
      deletes.push(target.path);
    } else {
      writes.push({ path: target.path, content: result.content, existed: true });
      if (replaced !== undefined) {
        notes.push(`${target.path}: restored the ai-erd block that was there before.`);
      }
    }
  }

  for (const path of [HARNESS_DOC_PATH, HARNESS_CONFIG_PATH]) {
    if (input.files.get(path) === undefined) {
      // 파일이 없다 — 원본을 들고 있으면 되돌릴 기회가 아직 남았다는 뜻이다.
      if (managed.originals?.[path] !== undefined) {
        notes.push(`${path} is gone, so the pre-init file was not restored — the backup is kept.`);
        unresolved = true;
      } else {
        forget(path);
      }
      continue;
    }
    if (path === HARNESS_CONFIG_PATH) {
      // config 는 «기록 자체»다 — 마지막에 따로 처리한다(아래).
      continue;
    }
    const original = managed.originals?.[path];
    if (original !== undefined) {
      if (fingerprintFor(path, input.files.get(path)!) === fingerprintFor(path, original)) {
        // ★사용자가 손으로 원본을 되돌려 놨다 — 목표에 이미 도달했으니 끝난 일이다.
        //   예전엔 「우리가 쓴 것과 다르다」만 보고 네 번을 돌려도 미해결로 남겼다
        //   (2026-09-27 6차 독립 리뷰 I2). 조각과 같은 규칙을 «파일 전체»에도 적용한다.
        notes.push(`${path} is already the file that existed before init.`);
        forget(path);
        continue;
      }
      if (changedSinceOurWrite(path)) {
        // ★원본으로 덮으면 «그 뒤의 편집»이 사라진다. 되돌리기가 남의 글을 지워선 안 된다
        //   (2026-09-23 독립 재리뷰 I8). 그리고 되돌릴 일이 «남았»으므로 기록도 지키다
        //   (5차 I2 — 이 분기가 unresolved 에 참여하지 않아 백업이 사라졌다).
        notes.push(
          `${path} was edited after init — left in place instead of restoring the pre-init file. `
          + "The backup is kept; run --undo again once you have resolved it.",
        );
        unresolved = true;
        continue;
      }
      // 우리가 통째로 덮어쓴 남의 파일 — 원본을 되돌린다.
      writes.push({ path, content: original, existed: true });
      notes.push(`${path}: restored the file that existed before init.`);
      forget(path);
      continue;
    }
    if (changedSinceOurWrite(path)) {
      // 우리가 만든 파일을 사용자가 고쳤다 — 지우지 않는다. 되돌릴 일이 남은 것은 아니므로
      // 기록에서는 지운다(그 파일은 이제 사용자 것이다).
      notes.push(`${path} was edited after init — left in place instead of deleting it.`);
      forget(path);
      continue;
    }
    dropOrKeep(path);
    forget(path);
  }

  notes.push(`Codex keeps its own global config — remove it with: ${codexRemoveCommand()}`);
  notes.push(`If you set ${ROLE_ENV_VAR} anywhere, unset it too.`);

  // ★★<b>기록을 지우거나, «줄여서» 다시 쓴다.</b>
  //
  // 예전엔 둘뿐이었다 — 전부 지우거나 통째로 남기거나. 그래서 일부만 복구된 상태에서는
  // 다시 시도할 때마다 이미 끝난 항목까지 충돌로 잡히고(5차 I3), 다음 init 은 완료된 항목의
  // 낡은 원본을 계속 자기 것으로 이어받았다. 끝난 것은 기록에서 지우고 남은 것만 남긴다.
  const currentConfig = input.files.get(HARNESS_CONFIG_PATH);
  if (currentConfig !== undefined) {
    if (unresolved || hasPendingRecovery(remaining)) {
      writes.push({
        path: HARNESS_CONFIG_PATH,
        content: reducedConfig(currentConfig, remaining),
        existed: true,
      });
      notes.push(
        `${HARNESS_CONFIG_PATH}: kept, with the finished items removed — it still holds the backups `
        + "--undo needs. Run --undo again once the items above are resolved.",
      );
    } else {
      // ★<b>되돌릴 것이 없으면 우리 칸만 걷어낸다.</b> 예전엔 여기서 두 길로 갈라졌고 둘 다
      //   사용자 값을 잃었다 — 원본이 있으면 «무조건» 통째로 덮었고(편집을 지웠다), 없으면
      //   「우리가 쓴 그대로니 전부 우리 것」이라 판정해 파일을 지웠다. 그리고 완료된 기록을
      //   지울 길이 없어 다음 init 이 낡은 원본을 이어받았다(6차 독립 리뷰 I1·I3).
      const undone = configWithOurFieldsUndone(currentConfig, managed.originals?.[HARNESS_CONFIG_PATH]);
      if (undone === undefined) {
        deletes.push(HARNESS_CONFIG_PATH);
      } else if (undone !== currentConfig) {
        writes.push({ path: HARNESS_CONFIG_PATH, content: undone, existed: true });
        notes.push(managed.originals?.[HARNESS_CONFIG_PATH] !== undefined
          ? `${HARNESS_CONFIG_PATH}: put back the fields that were there before init; your own fields are untouched.`
          : `${HARNESS_CONFIG_PATH}: removed what ai-erd wrote and kept your own fields.`);
      }
    }
  }

  // ★비었다고 다 치우지 않는다 — 우리가 만든 것만. 그 목록은 init 이 적어 둔다.
  const removableDirectories = parentsOf(deletes)
    .filter((directory) => (managed.createdDirectories ?? []).includes(directory));

  return { writes, deletes, codexCommand: codexRemoveCommand(), notes, removableDirectories };
}

/**
 * config 의 {@code createdDirectories} 만 «실제로 만든 것»으로 갈아 끼운다.
 *
 * <p>★자기 지문을 다시 계산한다 — 안 하면 다음 undo 가 이 파일을 「사용자가 고쳤다」로 본다.
 * (같은 함정을 이 파일에서 두 번 밟았다: I7, 그리고 S3 을 고칠 때.)
 */
export function withCreatedDirectories(current: string, directories: readonly string[]): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(current) as Record<string, unknown>;
  } catch {
    return current;
  }
  const managed = parsed.managed as ManagedRecord | undefined;
  if (!managed) {
    return current;
  }
  const next: ManagedRecord = {
    ...managed,
    createdDirectories: [...directories],
    lastWritten: { ...managed.lastWritten },
  };
  delete next.lastWritten[HARNESS_CONFIG_PATH];
  parsed.managed = next;
  next.lastWritten[HARNESS_CONFIG_PATH] = configFingerprint(serialize(parsed));
  parsed.managed = next;
  return serialize(parsed);
}

interface ConfigBodyValues {
  projectUuid: string;
  projectName: string;
  endpoint: string;
  cliVersion: string;
  versions: Record<string, string>;
  managed: ManagedRecord;
}

/** init 이 config 에 쓰는 내용. ★적는 칸의 진실원이 여기 하나다. */
function configBodyOf(values: ConfigBodyValues): Record<string, unknown> {
  return {
    version: 1,
    project: { uuid: values.projectUuid, name: values.projectName },
    endpoint: values.endpoint,
    generatedBy: values.cliVersion,
    promptVersions: values.versions,
    managed: values.managed,
  };
}

/**
 * config 에서 «우리 것»인 칸. ★여기 없는 칸은 <b>사용자가 적은 것</b>이고, 되돌리기는 그것을
 * 지우지 않는다.
 *
 * <p>목록을 {@link configBodyOf} 에서 «뽑아낸다» — 손으로 베끼면 칸이 늘 때 잊는다.
 * 같은 자리를 이미 한 번 틀렸다({@code carryForward}, 2026-09-23 4차 독립 리뷰 I3).
 */
const OUR_CONFIG_FIELDS: readonly string[] = Object.keys(configBodyOf({
  projectUuid: "", projectName: "", endpoint: "", cliVersion: "",
  versions: {}, managed: emptyManagedRecord(),
}));

/**
 * config 에서 «우리 칸만» 되돌린 내용. 남는 것이 없으면 undefined — 그때만 파일을 지운다.
 *
 * <p>★<b>되돌리기의 단위는 파일이 아니라 칸이다.</b> 예전엔 둘뿐이었다 — 원본으로 통째 덮거나
 * 통째로 지우거나. 그래서 사용자가 config 에 적어 둔 자기 칸이 두 길로 다 사라졌다: 원본
 * 복원이 편집을 덮고, 「우리가 쓴 그대로니 우리 것」이라는 판정이 파일을 지웠다
 * (2026-09-27 6차 독립 리뷰 I1).
 *
 * <p>원래 있던 칸은 원본 값으로 되돌리고, 우리가 «더한» 칸은 지우고, 우리 칸이 아닌 것은
 * 손대지 않는다. 그러면 두 소유권이 한 파일에 공존해도 각자 제 것만 잃는다.
 */
function configWithOurFieldsUndone(current: string, original: string | undefined): string | undefined {
  const parsed = parseJsonObject(current);
  if (!parsed) {
    return current; // 못 읽는 파일은 손대지 않는다.
  }
  const before = original === undefined ? undefined : parseJsonObject(original);
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!OUR_CONFIG_FIELDS.includes(key)) {
      next[key] = value;
      continue;
    }
    if (before && Object.prototype.hasOwnProperty.call(before, key)) {
      next[key] = before[key]; // 원래 있던 칸 → 원본 값으로.
    }
  }
  // 원본에는 있었는데 지금 파일에서는 사라진 우리 칸도 도로 넣는다.
  for (const key of before ? OUR_CONFIG_FIELDS : []) {
    if (Object.prototype.hasOwnProperty.call(before!, key)
        && !Object.prototype.hasOwnProperty.call(next, key)) {
      next[key] = before![key];
    }
  }
  return Object.keys(next).length === 0 ? undefined : serialize(next);
}

function parseJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** 아직 되돌릴 근거가 남았나 — 백업이나 소유 기록이 하나라도 있으면 그렇다. */
function hasPendingRecovery(record: ManagedRecord): boolean {
  // ⚠config 자신은 세지 않는다. 「우리가 config 를 만들었다」는 사실은 되돌릴 «의무»가 아니라
  //   기록 그 자체다 — 세면 기록이 자기 때문에 영영 안 지워진다.
  const others = (paths: readonly string[]) => paths.filter((p) => p !== HARNESS_CONFIG_PATH);
  const keys = (map: Record<string, unknown>) => others(Object.keys(map));
  return others(record.created).length > 0
    || others(record.blockAdded).length > 0
    || keys(record.replacedEntries).length > 0
    || keys(record.replacedBlocks).length > 0
    || keys(record.originals).length > 0;
}

/**
 * 지금 config 에서 {@code managed} 만 «줄어든 기록»으로 갈아 끼운다.
 *
 * <p>⚠사용자가 config 에 적어 둔 자기 칸은 건드리지 않는다. 그리고 자기 지문을 다시 계산한다 —
 * 안 하면 다음 undo 가 이 파일을 「사용자가 고쳤다」로 본다.
 */
function reducedConfig(current: string, remaining: ManagedRecord): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(current) as Record<string, unknown>;
  } catch {
    // 못 읽는 파일은 손대지 않는다.
    return current;
  }
  const next: ManagedRecord = { ...remaining, lastWritten: { ...remaining.lastWritten } };
  delete next.lastWritten[HARNESS_CONFIG_PATH];
  parsed.managed = next;
  next.lastWritten[HARNESS_CONFIG_PATH] = configFingerprint(serialize(parsed));
  parsed.managed = next;
  return serialize(parsed);
}

/** 이 경로들의 «저장소 안» 부모 디렉터리. 깊은 것부터 — .a/b 를 치워야 .a 가 비워진다. */
function parentsOf(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (parent) {
      directories.add(parent);
    }
  }
  return [...directories].sort((left, right) => right.length - left.length);
}

/** 이 저장소에 이미 걸린 역할. 설정 파일들이 어긋나 있으면 전부 돌려준다. */
export function detectRoles(files: FileSnapshot): Map<string, HarnessRole | undefined> {
  const found = new Map<string, HarnessRole | undefined>();
  for (const target of AGENT_TARGETS) {
    const existing = files.get(target.path);
    if (existing === undefined) {
      continue;
    }
    found.set(target.path, previousRole(existing));
  }
  return found;
}

function previousRole(existing: string | undefined): HarnessRole | undefined {
  if (existing === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(existing) as { mcpServers?: Record<string, unknown> };
    return readRoleFromEntry(parsed.mcpServers?.[SERVER_NAME]);
  } catch {
    return undefined;
  }
}
