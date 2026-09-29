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
  markerEvidence,
  HARNESS_CONFIG_PATH,
  HARNESS_DOC_PATH,
  HARNESS_RECORD_PATH,
  removeMarkerBlock,
  replaceMarkerBlockWith,
  renderAgentNote,
  renderHarnessDoc,
  upsertMarkerBlock,
} from "./harnessDoc";
import {
  ABSENT,
  emptyRecord,
  fieldsContractProblem,
  legacyManagedNotice,
  legacyManagedRecord,
  readRecord,
  serializeRecord,
  stableStringify,
  type FileContract,
  type InitRecord,
  type Owned,
  type RecordState,
} from "./initRecord";
import { createHash } from "node:crypto";
import { ROLE_ENV_VAR, type HarnessRole } from "./role";

/**
 * init 이 «무엇을 쓸지»를 순수하게 계산한다. 파일을 읽지도 쓰지도 않는다.
 *
 * ★<b>계획과 적용을 가른 이유.</b> 이 명령은 남의 저장소에 파일을 쓴다 — 가장 위험한 종류의
 * 일이다. 계산이 순수하면 「어떤 상태에서 무엇을 쓰는가」를 전부 시험으로 고정할 수 있고,
 * {@code --dry-run} 이 «진짜로 일어날 일»을 그대로 보여 준다(따로 만든 미리보기가 아니다).
 *
 * <p>★★<b>2026-09-27, 여덟 차례의 독립 리뷰 뒤에 경계를 셋으로 나눴다.</b> 다섯 차수 동안 같은
 * 축이 계속 샜고, 마지막 리뷰가 그 이유에 이름을 붙였다 — 기록이 «경로를 키로 한 평행한 map
 * 아홉 개»여서 나온 결함이 거의 전부 「한 map 은 X 라 하고 다른 map 은 Y 라 한다」였다.
 * 고칠 때마다 나는 그중 <b>한 map</b>을 고쳤다.
 * <ol>
 *   <li>{@code initRecord.ts} — 기록의 «형식과 상태». 부재·유효·손상·구판을 명시적으로 돌려준다.</li>
 *   <li><b>이 파일</b> — «파일별 복구 계약». 한 파일의 사실이 한 항목에 모이고,
 *       완료·보존·미해결이 {@link Outcome} 타입으로 갈린다.</li>
 *   <li>{@code initCommand.applyPlan} — 적용과 기록 저장. 실제 변경과 mkdir 결과를 한 경계에서 모은다.</li>
 * </ol>
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
  HARNESS_RECORD_PATH,
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
  /** init 계획이 남기는 기록. {@code .ai-erd/init-record.json} 에 저장된다. */
  record?: InitRecord;
  /**
   * ★<b>아무것도 하지 말아야 하는 이유.</b> 있으면 부르는 쪽이 멈추고 이 문장을 보여 준다.
   *
   * <p>기록을 읽어 내지 못했을 때 그냥 진행하면 그 파일에 든 «남의 원본 백업»을 백업 없이
   * 덮는다 — 읽기를 거절했는데 쓰기는 거절하지 않은 것이다(2026-09-27 8차 독립 리뷰 I1).
   */
  refusal?: string;
  /**
   * 되돌리기가 «치워도 되는» 디렉터리 — 우리가 만든 것뿐이다.
   *
   * <p>★비었다는 것과 우리 것이라는 것은 다른 사실이다(4차 독립 리뷰 S3).
   */
  removableDirectories?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 소유한 값 다루기
// ─────────────────────────────────────────────────────────────────────────────

/** JSON 값을 {@link Owned} 로. {@code present} 가 false 면 «그 자리에 없다»는 뜻이다. */
function ownedJson(value: unknown, present: boolean): Owned {
  return present ? { at: "json", value } : ABSENT;
}

function ownedText(text: string | undefined): Owned {
  return text === undefined ? ABSENT : { at: "text", text };
}

/**
 * 두 소유값이 같은가. ★<b>JSON 타입을 보존한다.</b>
 *
 * <p>예전엔 문자열은 원문 그대로, 객체는 JSON 문자열로 해시해서 <b>객체와 「그 객체의 JSON 을
 * 담은 문자열」이 같은 지문</b>이 됐고, 타입이 다른데도 「원본 복구 완료」로 판정하며 객체
 * 백업을 지웠다(7차 독립 리뷰 I5). 정규화는 «칸 순서와 공백»만 지우는 일이다.
 */
function sameOwned(left: Owned, right: Owned): boolean {
  if (left.at !== right.at) {
    return false;
  }
  if (left.at === "absent") {
    return true;
  }
  if (left.at === "text" && right.at === "text") {
    return left.text === right.text;
  }
  return left.at === "json" && right.at === "json"
    && stableStringify(left.value) === stableStringify(right.value);
}

/** 내용 지문. 암호학적 용도가 아니라 «바뀌었나»만 본다. */
export function contentFingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function serialize(body: unknown): string {
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** 이 경로의 내용 지문. JSON 파일은 칸 순서를 지운 정규형으로 잰다. */
function fingerprintFor(path: string, content: string): string {
  if (!path.endsWith(".json")) {
    return contentFingerprint(content);
  }
  try {
    return contentFingerprint(stableStringify(JSON.parse(content)));
  } catch {
    return contentFingerprint(content);
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// config 의 «우리 칸»
// ─────────────────────────────────────────────────────────────────────────────

interface ConfigBodyValues {
  projectUuid: string;
  projectName: string;
  endpoint: string;
  cliVersion: string;
  versions: Record<string, string>;
}

/** init 이 config 에 쓰는 내용. ★적는 칸의 진실원이 여기 하나다. */
function configBodyOf(values: ConfigBodyValues): Record<string, unknown> {
  return {
    version: 1,
    project: { uuid: values.projectUuid, name: values.projectName },
    endpoint: values.endpoint,
    generatedBy: values.cliVersion,
    promptVersions: values.versions,
  };
}

/**
 * config 에서 «우리 것»인 칸. ★여기 없는 칸은 <b>사용자가 적은 것</b>이고 되돌리기가 손대지 않는다.
 *
 * <p>목록을 {@link configBodyOf} 에서 «뽑아낸다» — 손으로 베끼면 칸이 늘 때 잊는다.
 * 같은 자리를 이미 한 번 틀렸다(4차 독립 리뷰 I3).
 *
 * <p>★{@code managed} 는 이 목록에 «없다». 기록이 자기 파일로 나갔기 때문이다 — 사용자가
 * config 에 {@code managed} 라는 칸을 적어 두어도 그것은 사용자 것이다(7차 독립 리뷰 I2).
 */
const OUR_CONFIG_FIELDS: readonly string[] = Object.keys(configBodyOf({
  projectUuid: "", projectName: "", endpoint: "", cliVersion: "", versions: {},
}));

const hasField = (object: Record<string, unknown>, field: string) =>
  Object.prototype.hasOwnProperty.call(object, field);

// ─────────────────────────────────────────────────────────────────────────────
// 계획 — init
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanInitInput {
  role: HarnessRole;
  env?: "prod" | "dev";
  projectName: string;
  projectUuid: string;
  endpoint: string;
  cliVersion: string;
  files: FileSnapshot;
  /** 직전 실행의 기록 «상태». ★유효하지 않으면 init 이 멈춘다 — 덮으면 백업이 사라진다. */
  previous?: RecordState;
  /** 서버에서 받은 문서 본문. 없으면 패키지 기본값(= 오프라인 기본값)을 쓴다. */
  documents?: { doc?: string; agentNote?: string; versions?: Record<string, string> };
}

/**
 * ★<b>기록 때문에 멈춰야 하나 — «파일만» 보고 답한다.</b>
 *
 * <p>계획을 세우는 것보다 «앞»에 이 질문이 있어야 한다. 예전엔 이 판정이 {@code planInit} 안에만
 * 있었고, 부르는 쪽은 그 전에 프로젝트를 해결했다 — 프로젝트가 0개면 <b>원격에 프로젝트를 만든
 * 뒤에</b> 「아무것도 바꾸지 않았다」는 예외를 냈다(9차 1차 리뷰 B7). 로컬 쓰기가 0이어도
 * 부수효과가 0인 것은 아니다. 그래서 순수 함수로 빼서 원격 호출 전에 물을 수 있게 한다.
 *
 * <p>⚠{@code planInit} 도 이 함수를 쓴다 — 두 곳에 같은 판단을 두면 어긋난다.
 */
export function initRefusal(files: FileSnapshot, previous?: RecordState): string | undefined {
  const state = previous ?? readRecord(files.get(HARNESS_RECORD_PATH));
  if (state.state === "corrupt" || state.state === "legacy") {
    // ★읽어 내지 못한 기록을 덮으면 그 안의 «남의 원본 백업»이 사라진다. 읽기를 거절했으면
    //   쓰기도 거절해야 한다(8차 독립 리뷰 I1).
    return `${state.reason}. Nothing was changed — move that file aside (or restore it) and run again.`;
  }
  if (state.state === "absent" && legacyManagedRecord(files.get(HARNESS_CONFIG_PATH))) {
    // ★구판이 config 에 남긴 기록이다. 우리는 그것을 이행할 수 없고, 덮으면 그 안의 사용자
    //   원본이 «읽을 수는 있지만 쓸 수 없는» 글이 된다 — 아무도 다시 꺼내지 않는다(9차 B6).
    return legacyManagedNotice(HARNESS_CONFIG_PATH);
  }
  const carried = state.state === "valid" ? state.record : emptyRecord();
  for (const [path, contract] of Object.entries(carried.files)) {
    if (contract.scope !== "fields") {
      continue;
    }
    // ★<b>검증 «전» 기록으로 파일을 고치지 않는다.</b> 같은 완전성 검사가 되돌리기에만 있었고,
    //   재init 은 그 기록을 그대로 실행해 «현재 값»을 새 원본으로 적어 버렸다(3차 리뷰 F1).
    //   ⛔로더에 도메인 지식을 넣는 대신, 도메인을 아는 이 경계에서 두 진입점이 같은 검사를 한다.
    const problem = fieldsContractProblem(contract, OUR_CONFIG_FIELDS);
    if (problem !== undefined) {
      return `${HARNESS_RECORD_PATH}'s record for ${path} ${problem}. Nothing was changed — `
        + "restore that file (or move it aside) and run again.";
    }
  }
  return undefined;
}

export function planInit(input: PlanInitInput): InitPlan {
  const previous = input.previous ?? readRecord(input.files.get(HARNESS_RECORD_PATH));
  const refusal = initRefusal(input.files, previous);
  if (refusal !== undefined) {
    return {
      writes: [], deletes: [], notes: [],
      codexCommand: codexAddCommand({ role: input.role, env: input.env, endpoint: input.endpoint }),
      refusal,
    };
  }

  const carriedRecord = previous.state === "valid" ? previous.record : emptyRecord();

  const entry = buildServerEntry({ role: input.role, env: input.env, endpoint: input.endpoint });
  const writes: FileWrite[] = [];
  const notes: string[] = [];
  const record: InitRecord = {
    version: carriedRecord.version,
    files: { ...carriedRecord.files },
    createdDirectories: [...carriedRecord.createdDirectories],
  };

  /**
   * ★<b>이어받은 계약이 아직 참인가.</b> 기록은 «지난 실행의 주장»이고 그 사이에 파일이 바뀔 수
   * 있다. 지금 값이 우리가 쓴 것도 아니고 되돌릴 목표도 아니면 그 백업은 낡은 것이다 —
   * 지금 값이 사용자의 것이므로 그것이 새 기준이 되어야 한다(6차 I3 → 8차 I4).
   */
  const priorOf = (path: string, current: Owned): FileContract | undefined => {
    const prior = record.files[path];
    if (prior === undefined) {
      return undefined;
    }
    if (sameOwned(prior.written, current) || sameOwned(prior.original, current)) {
      return prior;
    }
    delete record.files[path];
    notes.push(`${path}: it changed outside ai-erd, so the older backup was dropped and this is the new baseline.`);
    return undefined;
  };

  // ── MCP 설정 파일들 — 우리가 «항목 하나»를 소유한다 ──────────────────────────
  for (const target of AGENT_TARGETS) {
    const existing = input.files.get(target.path);
    const currentEntry = existing === undefined ? undefined : readServerEntry(existing);
    const prior = priorOf(target.path, ownedJson(currentEntry, currentEntry !== undefined));
    const merged = mergeServerEntry(existing, entry);
    if (existing === merged.content) {
      continue;
    }
    const before = previousRole(existing);
    if (merged.replaced && before && before !== input.role) {
      notes.push(`${target.path}: role ${before} → ${input.role}`);
    }
    const original = prior?.original ?? ownedJson(merged.replacedEntry, merged.replaced);
    if (prior === undefined && original.at !== "absent") {
      notes.push(`${target.path}: your existing "${SERVER_NAME}" entry was saved and will be restored by --undo`);
    }
    record.files[target.path] = {
      scope: "entry",
      createdByUs: prior?.createdByUs ?? existing === undefined,
      original,
      written: ownedJson(readServerEntry(merged.content), true),
      fileFingerprint: fingerprintFor(target.path, merged.content),
    };
    writes.push({ path: target.path, content: merged.content, existed: existing !== undefined });
  }

  // ── HARNESS.md — 우리가 «파일 전체»를 소유한다 ────────────────────────────────
  const existingDoc = input.files.get(HARNESS_DOC_PATH);
  const priorDoc = priorOf(HARNESS_DOC_PATH, ownedText(existingDoc));
  const docContent = renderHarnessDoc({
    projectName: input.projectName,
    projectUuid: input.projectUuid,
    endpoint: input.endpoint,
  }, input.documents?.doc);
  const docOriginal = priorDoc?.original ?? ownedText(existingDoc);
  if (priorDoc === undefined && docOriginal.at !== "absent") {
    notes.push(`${HARNESS_DOC_PATH} already existed; its original was saved and --undo will restore it.`);
  }
  record.files[HARNESS_DOC_PATH] = {
    scope: "whole",
    createdByUs: priorDoc?.createdByUs ?? existingDoc === undefined,
    original: docOriginal,
    written: ownedText(docContent),
    fileFingerprint: fingerprintFor(HARNESS_DOC_PATH, docContent),
  };
  if (docContent !== existingDoc) {
    writes.push({ path: HARNESS_DOC_PATH, content: docContent, existed: existingDoc !== undefined });
  }

  // ── AGENTS.md / CLAUDE.md — 우리가 «블록 하나»를 소유한다 ─────────────────────
  const note = renderAgentNote(input.documents?.agentNote);
  for (const target of NOTE_TARGETS) {
    const existing = input.files.get(target.path);
    if (existing === undefined && !target.createIfMissing) {
      notes.push(`${target.path} not found — skipped; AGENTS.md already reaches this agent.`);
      continue;
    }
    const blockNow = existing === undefined ? undefined : existingMarkerBlock(existing);
    const carried = record.files[target.path];
    // ⚠아래 판정은 «새 기준을 만들기 전에» 온다. 정상 위치에 블록이 있을 때만 검사하면,
    //   그 블록을 고치고 사본을 옆에 둔 파일이 가드를 건너뛰었다(3차 리뷰 B2).
    let content: string;
    try {
      content = upsertMarkerBlock(existing, note);
    } catch (error) {
      // ★우리 블록을 «다시 찾을 수 있게» 넣을 수 없는 파일이다 — 그 파일만 건너뛰고 나머지
      //   init 은 계속한다. ⛔이때 기록은 «한 글자도» 건드리지 않는다: 새 기준도 못 세웠는데
      //   옛 백업을 버리면 양쪽 다 잃는다(7차 독립 리뷰 I4).
      notes.push(`${target.path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (carried?.scope === "block" && unexplainedMarkers(existing, carried) > 0) {
      // ★<b>이 파일의 마커를 기록으로 설명할 수 없다.</b> 우리 블록이 옮겨졌거나 한 벌 더
      //   있을 수 있다는 뜻이다(펜스·인용문 안, 제목만 고친 것, 정상 블록 옆의 사본 포함).
      //   그대로 진행하면 계약을 버려(priorOf) 사용자 원본 백업이 사라지고 파일에는 우리 블록이
      //   둘이 된다 — 그 상태의 undo 는 «새로 더한 것만» 걷어내고 완료로 처리했다(9차 B2).
      //   ⇒ 이 파일은 손대지 않고 기록도 그대로 둔다. 자리를 되돌리는 것은 사람 몫이다.
      notes.push(
        `${target.path}: this file has an ai-erd marker block that is not where ai-erd can find `
        + "it again (inside a code fence, a quote, or edited). Left untouched and the earlier "
        + "backup kept — move that block back to the top level, or remove it, then run again.",
      );
      continue;
    }
    // ★<b>블록을 «못 찾는다»는 사실은 백업을 버릴 근거가 아니다</b>(3차 리뷰 B2). 마커가
    //   변형·삭제돼 우리 블록이 검출되지 않으면 예전엔 계약을 버려 사용자 원본이 사라졌다.
    //   새 기준은 «정상 위치에 사용자 것이 들어와 있을 때»만 세운다 — 그때만 되돌릴 목표가 바뀐다.
    const prior = blockNow === undefined ? carried : priorOf(target.path, ownedText(blockNow));
    if (content === existing) {
      continue;
    }
    const original = prior?.original ?? ownedText(blockNow);
    if (prior === undefined && original.at !== "absent") {
      notes.push(`${target.path}: an existing ai-erd block was saved and will be restored by --undo`);
    }
    record.files[target.path] = {
      scope: "block",
      createdByUs: prior?.createdByUs ?? existing === undefined,
      original,
      written: ownedText(existingMarkerBlock(content)),
      fileFingerprint: fingerprintFor(target.path, content),
      // init «전»에 이 파일에 있던 관리 블록들의 신원. 되돌리기가 「남은 마커를 설명할 수 있나」를
      // 이것으로 묻는다. ★재init 은 이어받는다 — 다시 재면 우리가 쓴 블록이 «원래 있던 것»이 된다.
      // ★{@code carried} 를 먼저 본다 — {@code priorOf} 가 새 기준을 세웠다는 것이 「남의 예제
      //   목록을 다시 모아도 된다」는 허가가 아니다. 다시 모으면 «우리가 옮겨 둔 사본»이
      //   「원래 있던 예제」로 등록되고, 그다음 되돌리기가 그것을 남긴 채 끝났다(3차 리뷰 B2).
      foreignBlocks: carried?.foreignBlocks ?? prior?.foreignBlocks ?? markerEvidence(existing),
    };
    writes.push({ path: target.path, content, existed: existing !== undefined });
  }

  // ── config.json — 우리가 «칸 몇 개»를 소유한다. 나머지는 사용자 것이다 ────────
  const existingConfig = input.files.get(HARNESS_CONFIG_PATH);
  const ourFields = configBodyOf({
    projectUuid: input.projectUuid,
    projectName: input.projectName,
    endpoint: input.endpoint,
    cliVersion: input.cliVersion,
    // ★어느 판의 규칙으로 썼나. 이게 없으면 「무엇이 적혀 있었나」를 나중에 못 되짚는다.
    versions: input.documents?.versions ?? {},
  });
  const theirConfig = existingConfig === undefined ? undefined : parseJsonObject(existingConfig);
  if (existingConfig !== undefined && theirConfig === undefined) {
    // JSON 객체가 아닌 파일은 병합할 수 없다 — 손대지 않는다. ⛔이미 있던 계약도 지우지 않는다:
    // 그 안에 아직 못 되돌린 원본이 있을 수 있다(8차 독립 리뷰 I3).
    notes.push(`${HARNESS_CONFIG_PATH} is not a JSON object — left untouched.`);
  } else {
    const priorConfig = record.files[HARNESS_CONFIG_PATH];
    const originalFields: Record<string, Owned> = {};
    for (const field of OUR_CONFIG_FIELDS) {
      const presentNow = theirConfig !== undefined && hasField(theirConfig, field);
      const currentValue = presentNow ? theirConfig![field] : undefined;
      const priorOriginal = priorConfig?.originalFields?.[field];
      const priorWritten = priorConfig?.writtenFields;
      // ★재init: 사용자가 우리 칸을 고쳤으면 «그 값»이 새 원본이다. 옛 원본을 이어받으면
      //   되돌리기가 두 판 전 값을 복원하며 사용자 편집을 잃는다(8차 독립 리뷰 I4).
      const untouchedByUser = priorWritten !== undefined && hasField(priorWritten, field)
        && stableStringify(currentValue) === stableStringify(priorWritten[field]);
      const next = untouchedByUser && priorOriginal !== undefined
        ? priorOriginal
        : ownedJson(currentValue, presentNow);
      originalFields[field] = next;
      if (priorOriginal !== undefined && !sameOwned(next, priorOriginal)) {
        notes.push(`${HARNESS_CONFIG_PATH}: you changed ${field} — ai-erd now treats your value as the one to put back.`);
      }
    }
    const mergedConfig = serialize({ ...(theirConfig ?? {}), ...ourFields });
    record.files[HARNESS_CONFIG_PATH] = {
      scope: "fields",
      createdByUs: priorConfig?.createdByUs ?? existingConfig === undefined,
      original: ABSENT,
      written: ownedText(mergedConfig),
      fileFingerprint: fingerprintFor(HARNESS_CONFIG_PATH, mergedConfig),
      writtenFields: { ...ourFields },
      originalFields,
    };
    if (mergedConfig !== existingConfig) {
      writes.push({
        path: HARNESS_CONFIG_PATH,
        content: mergedConfig,
        existed: existingConfig !== undefined,
      });
    }
  }

  // ── 기록 — 우리 파일. 통째로 쓰고 통째로 지운다 ───────────────────────────────
  const existingRecord = input.files.get(HARNESS_RECORD_PATH);
  const recordContent = serializeRecord(record);
  // ★변경 없는 재실행은 아무 파일도 안 바꿔야 한다(5차 독립 리뷰 S2). ⚠그렇다고 「쓸 것이
  //   없다」가 「새로 알게 된 사실도 없다」를 뜻해선 안 된다 — mkdir 결과는 적용이 따로 저장한다
  //   (8차 독립 리뷰 S1).
  if (recordContent !== existingRecord) {
    writes.push({
      path: HARNESS_RECORD_PATH,
      content: recordContent,
      existed: existingRecord !== undefined,
    });
  }

  return {
    writes,
    deletes: [],
    codexCommand: codexAddCommand({ role: input.role, env: input.env, endpoint: input.endpoint }),
    codexProfile: codexProfileSetup({ role: input.role, env: input.env, endpoint: input.endpoint }),
    notes,
    record,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 계획 — undo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 한 파일에 대한 처리 «결과». ★완료·보존·미해결을 타입으로 가른다.
 *
 * <p>예전엔 셋이 같은 코드 경로로 흘렀고, 그래서 「손대지 않음」이 「복구 완료」와 같은 결과가
 * 됐다 — 판단 재료가 없어 아무것도 못 한 파일의 백업까지 지웠다(8차 독립 리뷰 I3).
 */
type Outcome =
  /** 목표에 도달했다 — 기록에서 지운다. */
  | { kind: "done"; note?: string }
  /** 되돌렸다 — 파일을 쓰고 기록에서 지운다. */
  | { kind: "write"; content: string; note?: string }
  /** 되돌렸다 — 파일을 지우고 기록에서 지운다. */
  | { kind: "delete"; note?: string }
  /** 이제 사용자 것이다 — 파일은 그대로 두고 기록에서 지운다. */
  | { kind: "keep"; note: string }
  /** 아직 못 했다 — ★기록을 «지키고» 이유를 말한다. */
  | { kind: "unresolved"; note: string };

export interface PlanUndoInput {
  files: FileSnapshot;
  /** 기록 «상태». 없으면 스냅샷에서 읽는다. */
  record?: RecordState;
}

/**
 * ★<b>우리가 쓴 것만 되돌린다.</b> 남의 서버 항목, 사용자가 표식 밖에 적은 글은 그대로 둔다.
 * 파일을 지우는 것은 «우리가 만든 파일»뿐이다.
 */
export function planUndo(input: PlanUndoInput): InitPlan {
  const state = input.record ?? readRecord(input.files.get(HARNESS_RECORD_PATH));
  const writes: FileWrite[] = [];
  const deletes: string[] = [];
  const notes: string[] = [];
  const tail = () => {
    notes.push(`Codex keeps its own global config — remove it with: ${codexRemoveCommand()}`);
    notes.push(`If you set ${ROLE_ENV_VAR} anywhere, unset it too.`);
  };

  if (state.state === "absent") {
    // ★기록이 없으면 «아무것도» 되돌리지 않는다. 예전엔 이름이 우리 것이면 지웠는데,
    //   init 을 한 적도 없는 저장소의 사용자 항목까지 지웠다(독립 재리뷰 I2).
    //   ⚠단 «없다»와 «구판이 다른 자리에 남겼다»는 다른 사실이다. 구판 기록이 있는 저장소에서
    //   「이전 init 기록이 없다」고 말하면, 그 config 안의 사용자 백업을 아무도 다시 꺼내지
    //   않는다 — 되돌릴 것이 없다고 읽기 때문이다(9차 1차 리뷰 B6).
    notes.push(legacyManagedRecord(input.files.get(HARNESS_CONFIG_PATH))
      ? legacyManagedNotice(HARNESS_CONFIG_PATH)
      : `No record of a previous init in ${HARNESS_RECORD_PATH} — no local file was changed.`);
    tail();
    return { writes, deletes, codexCommand: codexRemoveCommand(), notes };
  }
  if (state.state !== "valid") {
    // ⛔손상·구판 기록으로 파일을 «지우지» 않는다. 그 안에 아직 못 되돌린 원본이 있을 수 있고,
    //   우리는 그것을 읽어 내지 못했다(8차 독립 리뷰 I1·S2).
    notes.push(
      `${state.reason}. Nothing was changed — that file is kept because it may hold backups `
      + "--undo still needs. Restore it, or finish the undo with the CLI version that wrote it.",
    );
    tail();
    return { writes, deletes, codexCommand: codexRemoveCommand(), notes };
  }

  const record = state.record;
  /** 남은 의무. ★끝난 항목만 지운다 — 못 한 것은 남는다. */
  const remaining: Record<string, FileContract> = { ...record.files };

  for (const [path, contract] of Object.entries(record.files)) {
    const outcome = undoOne(path, contract, input.files.get(path));
    if (outcome.kind !== "unresolved" && outcome.kind !== "keep" && outcome.note !== undefined) {
      notes.push(outcome.note);
    } else if (outcome.kind === "unresolved" || outcome.kind === "keep") {
      notes.push(outcome.note);
    }
    if (outcome.kind === "unresolved") {
      continue; // 기록을 지킨다.
    }
    delete remaining[path];
    if (outcome.kind === "write") {
      writes.push({ path, content: outcome.content, existed: true });
    } else if (outcome.kind === "delete") {
      deletes.push(path);
    }
  }

  tail();

  // ★기록 파일은 «전부 우리 것»이다 — 남은 의무가 있으면 줄여서 다시 쓰고, 없으면 지운다.
  //   「이 칸이 누구 것인가」를 판정할 일이 없다.
  if (input.files.get(HARNESS_RECORD_PATH) !== undefined) {
    if (Object.keys(remaining).length > 0) {
      const reduced: InitRecord = { ...record, files: remaining };
      writes.push({ path: HARNESS_RECORD_PATH, content: serializeRecord(reduced), existed: true });
      notes.push(
        `${HARNESS_RECORD_PATH}: kept, with the finished items removed — it still holds the backups `
        + "--undo needs. Run --undo again once the items above are resolved.",
      );
    } else {
      deletes.push(HARNESS_RECORD_PATH);
    }
  }

  // ★비었다고 다 치우지 않는다 — 우리가 만든 것만. 그 목록은 적용이 mkdir 결과로 적어 둔다.
  const removableDirectories = parentsOf(deletes)
    .filter((directory) => record.createdDirectories.includes(directory));

  return { writes, deletes, codexCommand: codexRemoveCommand(), notes, removableDirectories };
}

/**
 * ★<b>이 파일에 남은 관리 블록을 기록으로 «설명할 수 있나».</b> 설명되지 않는 것이 하나라도
 * 있으면 우리 블록이 어딘가에 있을 수 있다는 뜻이고, 그러면 의무를 완료로 만들지 않는다.
 *
 * <p>★<b>판정을 뒤집은 자리다</b>(9차 2차 리뷰 B2·N1). 「우리 블록을 알아본다」로 짜면 제목 한 줄
 * 편집·인용문 이동·마커 중첩에 전부 뚫리고, 거꾸로 init 전부터 있던 «똑같은» 예제를 우리 것으로
 * 오인해 정상 되돌리기를 막는다. 그래서 알아보려 하지 않고 <b>기록해 둔 예제를 지워 나간 뒤
 * 남는 것</b>을 센다. 모양 비교는 「적어 둔 예제가 그대로 있나」에만 쓴다.
 */
function unexplainedMarkers(existing: string | undefined, contract: FileContract): number {
  const recorded = [...(contract.foreignBlocks ?? [])];
  let unexplained = 0;
  for (const print of markerEvidence(existing)) {
    const at = recorded.indexOf(print);
    if (at >= 0) {
      recorded.splice(at, 1); // init 전에 있던 그 블록이다 — 우리 일이 아니다.
    } else {
      unexplained += 1;
    }
  }
  return unexplained;
}

/** 이 파일 하나를 어떻게 할까. ★{@link Outcome} 하나만 돌려준다 — 부수효과 없음. */
function undoOne(path: string, contract: FileContract, existing: string | undefined): Outcome {
  if (existing === undefined) {
    if (contract.original.at !== "absent" || contract.scope === "fields") {
      // 백업을 든 파일이 사라졌다. 「없으니 건너뛴다」로 기록을 지우면 그 원본은 영영
      // 사라진다 — 사용자가 파일을 되살릴 수도 있다(5차 독립 리뷰 I2).
      return {
        kind: "unresolved",
        note: `${path} is gone, so what was there before init could not be put back — `
          + "the backup is kept. Restore the file and run --undo again.",
      };
    }
    return { kind: "done" };
  }
  switch (contract.scope) {
    case "entry": return undoEntry(path, contract, existing);
    case "block": return undoBlock(path, contract, existing);
    case "fields": return undoFields(path, contract, existing);
    case "whole": return undoWhole(path, contract, existing);
  }
}

function undoEntry(path: string, contract: FileContract, existing: string): Outcome {
  const current = readServerEntry(existing);
  const currentOwned = ownedJson(current, current !== undefined);
  if (sameOwned(currentOwned, contract.original)) {
    return {
      kind: "done",
      note: contract.original.at === "absent"
        ? `${path}: the "${SERVER_NAME}" entry ai-erd added is already gone.`
        : `${path}: your original "${SERVER_NAME}" entry is already back in place.`,
    };
  }
  // ★안내대로 지운 사람에게 같은 안내를 반복하지 않는다 — 남은 일은 원본을 도로 넣는 것이고
  //   그 경로가 바로 아래에 있다(7차 독립 리뷰 S2).
  const goneButWeHoldTheOriginal = current === undefined && contract.original.at !== "absent";
  if (!goneButWeHoldTheOriginal && !sameOwned(currentOwned, contract.written)) {
    return {
      kind: "unresolved",
      note: `${path}: the "${SERVER_NAME}" entry was edited after init — left in place. `
        + "Remove it by hand if you meant to, then run --undo again.",
    };
  }
  const restore = contract.original.at === "json" ? { value: contract.original.value } : undefined;
  const result = removeServerEntry(existing, restore);
  if (result.emptied && contract.createdByUs) {
    return { kind: "delete" };
  }
  if (result.content !== undefined && result.content !== existing) {
    return {
      kind: "write",
      content: result.content,
      note: restore === undefined ? undefined : `${path}: restored your original "${SERVER_NAME}" entry.`,
    };
  }
  return { kind: "done" };
}

function undoBlock(path: string, contract: FileContract, existing: string): Outcome {
  const current = existingMarkerBlock(existing);
  const currentOwned = ownedText(current);
  // ★<b>「예제가 있다」와 「우리 블록이 옮겨져 남았다」를 개수로 가른다.</b> Boolean 하나로는
  //   둘을 표현할 수 없었고, 예제가 있는 파일에서는 우리 블록이 남아 있어도 완료로 읽혔다
  //   (8차 독립 리뷰 I5).
  // ★기록으로 설명되지 않는 마커가 있으면, 정상 위치의 블록을 걷어내는 것으로 의무가 끝나지
  //   않는다 — 우리 블록이 그 자리에 있을 수 있다. 개수도 모양도 아니라 «증거 대조»다(9차 2차 B2).
  if (unexplainedMarkers(existing, contract) > 0) {
    return {
      kind: "unresolved",
      note: `${path}: this file has an ai-erd marker block that --undo cannot account for `
        + "(inside a code fence, a quote, or edited). Remove it by hand, then run --undo again.",
    };
  }
  if (sameOwned(currentOwned, contract.original)) {
    return {
      kind: "done",
      note: contract.original.at === "absent"
        ? `${path}: the ai-erd block is already gone.`
        : `${path}: the ai-erd block that was there before is already back in place.`,
    };
  }
  if (current === undefined && contract.original.at === "text") {
    // ★안내대로 지웠다 — 원본 블록을 도로 넣는다. 예전엔 여기서도 「손으로 지우고 다시
    //   실행하라」를 반복해, 이미 지운 사람에게 실행되지 않는 경로를 요구했다(8차 S3).
    const body = existing.trim()
      ? `${existing.replace(/\s*$/, "")}\n\n${contract.original.text}\n`
      : `${contract.original.text}\n`;
    return { kind: "write", content: body, note: `${path}: restored the ai-erd block that was there before.` };
  }
  if (!sameOwned(currentOwned, contract.written)) {
    return {
      kind: "unresolved",
      note: `${path}: the ai-erd block was edited after init — left in place. `
        + "Remove the block by hand if you meant to, then run --undo again.",
    };
  }
  let result: { content: string; removed: boolean; emptied: boolean };
  try {
    result = contract.original.at === "text"
      ? { content: replaceMarkerBlockWith(existing, contract.original.text), removed: true, emptied: false }
      : removeMarkerBlock(existing);
  } catch (error) {
    return { kind: "unresolved", note: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!result.removed) {
    return {
      kind: "unresolved",
      note: `${path}: the ai-erd block could not be removed — it is still in the file. `
        + "Remove it by hand, then run --undo again.",
    };
  }
  if (result.emptied && contract.createdByUs) {
    return { kind: "delete" };
  }
  return {
    kind: "write",
    content: result.content,
    note: contract.original.at === "text"
      ? `${path}: restored the ai-erd block that was there before.`
      : undefined,
  };
}

function undoWhole(path: string, contract: FileContract, existing: string): Outcome {
  if (sameOwned(ownedText(existing), contract.original)) {
    // 사용자가 손으로 원본을 되돌려 놨다 — 목표에 이미 도달했다(6차 독립 리뷰 I2).
    return { kind: "done", note: `${path} is already the file that existed before init.` };
  }
  if (!sameOwned(ownedText(existing), contract.written)) {
    if (contract.original.at === "text") {
      return {
        kind: "unresolved",
        note: `${path} was edited after init — left in place instead of restoring the pre-init file. `
          + "The backup is kept; run --undo again once you have resolved it.",
      };
    }
    // 우리가 만든 파일을 사용자가 고쳤다 — 이제 사용자 것이다.
    return { kind: "keep", note: `${path} was edited after init — left in place instead of deleting it.` };
  }
  if (contract.original.at === "text") {
    return {
      kind: "write",
      content: contract.original.text,
      note: `${path}: restored the file that existed before init.`,
    };
  }
  return contract.createdByUs ? { kind: "delete" } : { kind: "done" };
}

function undoFields(path: string, contract: FileContract, existing: string): Outcome {
  const parsed = parseJsonObject(existing);
  if (parsed === undefined) {
    // ★「손대지 않음」은 «복구 완료»가 아니다. 판단 재료가 없으면 백업을 지킨다(8차 I3).
    return {
      kind: "unresolved",
      note: `${path} is not a JSON object any more, so ai-erd could not take its fields back out — `
        + "the backup is kept. Fix the file and run --undo again.",
    };
  }
  // ★<b>로더와 «같은» 검증을 여기서도 한다.</b> 그리고 여기서는 부르는 쪽이 아는 것을 하나 더
  //   넘긴다 — 어느 칸이 우리 것인지. 그래서 「우리가 쓴 칸인데 기록에 없다」까지 걸린다.
  //   ⛔빈 map 으로 메우면 모든 칸이 「우리 것이 아니다」로 읽혀 파일은 그대로 두고 백업만
  //   지운다. 판정 자료가 반쯤 맞으면 그것으로 파일을 고치지 않는다(9차 B1 · 2차 리뷰 B1).
  const contractProblem = fieldsContractProblem(contract, OUR_CONFIG_FIELDS);
  if (contractProblem !== undefined) {
    return {
      kind: "unresolved",
      note: `${path}: ai-erd's record of the fields it wrote ${contractProblem}, so its fields `
        + "were left in place — the backup is kept. Restore that record, or remove the fields by hand.",
    };
  }
  const written = contract.writtenFields!;
  const originals = contract.originalFields!;
  const next: Record<string, unknown> = {};
  const kept: string[] = [];
  for (const [field, value] of Object.entries(parsed)) {
    if (!OUR_CONFIG_FIELDS.includes(field)) {
      next[field] = value; // 사용자 칸 — 손대지 않는다.
      continue;
    }
    if (!hasField(written, field)) {
      // ★우리 칸 이름인데 기록이 그 칸을 말하지 않는다 — 판정 자료가 없다. 「사용자가 고쳤다」도
      //   「우리 것이 아니다」도 근거가 없으므로 완료로 바꾸지 않는다(9차 B1).
      return {
        kind: "unresolved",
        note: `${path}: ai-erd has no record of what it wrote for ${field}, so its fields were `
          + "left in place — the backup is kept. Restore that record, or remove the field by hand.",
      };
    }
    const stillOurs = stableStringify(value) === stableStringify(written[field]);
    if (!stillOurs) {
      // ★이름이 우리 것이어도 «값»은 사용자가 고쳤다. 되돌리기가 그것을 덮지 않는다(7차 I2).
      next[field] = value;
      kept.push(field);
      continue;
    }
    const original = originals[field];
    // ★되돌릴 «목표»를 모르면 지우지 않는다. 예전엔 json 이 아닌 모든 것을 「우리가 더한 칸」으로
    //   묶어 지웠고, 원본이 {at:"text"} 로 바뀐 기록 하나가 config 를 «비웠다»(2차 리뷰 B1).
    //   위 검증이 이미 막지만, 이 판단을 그 검증에만 맡기지 않는다 — 여기가 파일을 고치는 자리다.
    if (original === undefined || (original.at !== "json" && original.at !== "absent")) {
      return {
        kind: "unresolved",
        note: `${path}: ai-erd cannot tell what was in ${field} before it wrote there, so the `
          + "file was left as it is — the backup is kept. Remove the field by hand if you meant to.",
      };
    }
    if (original.at === "json") {
      next[field] = original.value; // 원래 있던 칸 → 원본 값으로.
    }
    // ⚠original 이 absent 면 우리가 «더한» 칸이므로 넣지 않는다 = 지운다.
    // ★사용자가 우리 칸을 «지웠으면» 그 칸은 위 루프에 아예 안 들어온다 — 그래서 되살아나지
    //   않는다. 예전엔 뒤에 보충 루프가 있어 삭제를 무조건 되돌렸다(8차 독립 리뷰 I4).
  }
  const note = kept.length === 0 ? undefined
    : `${path}: you changed ${kept.join(", ")} after init — left as you set it instead of `
      + "putting the pre-init value back.";
  if (Object.keys(next).length === 0 && contract.createdByUs) {
    return { kind: "delete", note };
  }
  // ★파일이 원래 «빈 객체»였으면 빈 객체를 되돌린다 — 부재와 구별한다(8차 독립 리뷰 I6).
  const body = serialize(next);
  return body === existing
    ? { kind: "done", note }
    : {
      kind: "write",
      content: body,
      note: note ?? `${path}: removed what ai-erd wrote and kept the rest.`,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 적용이 쓰는 것
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 기록의 {@code createdDirectories} 를 «실제로 만든 것»으로 갈아 끼운다.
 *
 * <p>★자기 지문을 다시 계산하는 장치가 없다 — 기록이 우리 파일이라 지문을 재지 않기 때문이다.
 * 같은 순환 함정을 세 번 «요령»으로 막은 뒤(4차 I7 · 5차 S3 · 6차) 순환이 생기는 구조를
 * 없애는 쪽이 답이었다.
 */
export function withCreatedDirectories(current: string, directories: readonly string[]): string {
  const state = readRecord(current);
  if (state.state !== "valid") {
    return current;
  }
  return serializeRecord({ ...state.record, createdDirectories: [...directories] });
}

export { readRecord, serializeRecord, emptyRecord } from "./initRecord";
export type { InitRecord, RecordState, FileContract, Owned } from "./initRecord";

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
