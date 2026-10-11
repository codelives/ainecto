import {
  HARNESS_CONFIG_PATH,
  HARNESS_DIR,
  HARNESS_DOC_PATH,
  HARNESS_RECORD_PATH,
  LEGACY_HARNESS_DIR,
} from "./harnessDoc";
import { legacyManagedNotice, legacyManagedRecord, readRecord, serializeRecord } from "./initRecord";
import type { FileSnapshot, FileWrite, InitPlan } from "./initPlan";

/**
 * 0.4.x 의 하네스 폴더({@code .ai-erd/})를 새 폴더({@code .ainecto/})로 옮긴다 — 순수 함수 둘.
 *
 * <p>★<b>왜 «이동»인가(읽기 대체가 아니라).</b> 읽기 대체(옛 폴더가 있으면 계속 그 폴더를 쓴다)는 경로가
 * 저장소마다 달라진다 — 기록의 경로 키·AGENTS.md 블록이 가리키는 문서 경로·되돌리기·안내문이 전부
 * «어느 폴더인가»를 들고 다녀야 하고, 두 배치가 영구히 남는다. 이동은 한 번이다: 계획은 언제나 새 경로만
 * 보고({@link adoptLegacyLayout} 이 옛 파일을 새 경로에 놓인 것처럼 보여 준다), 적용이 새 경로에 쓰고 옛
 * 파일을 지운다({@link withLegacyMoves}). init·undo 계획 코드는 한 줄도 옛 이름을 모른다.
 *
 * <p>★<b>옮기는 것은 «0.4.x 기록이 있을 때»뿐이다.</b> 기록이 우리 것임을 증명하지 않으면 그 폴더의 파일을
 * 우리 것으로 옮길 근거가 없다 — 그때는 손대지 않고 그 사실만 말한다. 기록을 못 읽으면(손상·다른 판) 멈춘다:
 * 읽기를 거절했으면 쓰기도 거절한다(initRecord 의 원칙 그대로).
 *
 * <p>⚠기록의 형식은 그대로다(판 2). 바뀌는 것은 경로 키({@code .ai-erd/…} → {@code .ainecto/…})와
 * 신원(kind)뿐이고, 두 일 모두 여기서 끝난다.
 */

/** 새 경로 → 옛 경로. */
export const LEGACY_PATHS: ReadonlyMap<string, string> = new Map(
  [HARNESS_DOC_PATH, HARNESS_CONFIG_PATH, HARNESS_RECORD_PATH].map((path) => [path, toLegacy(path)]),
);

export const LEGACY_RECORD_PATH = toLegacy(HARNESS_RECORD_PATH);

/** 스냅샷이 디스크에서 읽어야 할 옛 경로들. */
export const LEGACY_SNAPSHOT_PATHS: readonly string[] = [...LEGACY_PATHS.values()];

export interface LegacyMove {
  from: string;
  to: string;
}

export interface LayoutView {
  /** 계획이 보는 스냅샷 — 새 경로만 있다. 옮길 파일은 새 경로에 놓인 것처럼 들어 있다. */
  files: FileSnapshot;
  moves: LegacyMove[];
  /** 옛 폴더를 0.4.x 가 «만들었나» — 그때만 다 옮긴 뒤 빈 폴더를 치운다. */
  legacyDirCreatedByUs: boolean;
  notes: string[];
  /** 있으면 아무것도 하지 않고 이 문장을 보여 준다. */
  refusal?: string;
}

export function adoptLegacyLayout(disk: FileSnapshot): LayoutView {
  const files = new Map<string, string | undefined>();
  for (const [path, content] of disk) {
    if (!LEGACY_SNAPSHOT_PATHS.includes(path)) {
      files.set(path, content);
    }
  }
  const view: LayoutView = { files, moves: [], legacyDirCreatedByUs: false, notes: [] };
  if (!LEGACY_SNAPSHOT_PATHS.some((path) => disk.get(path) !== undefined)) {
    return view;
  }

  const legacyRecord = disk.get(LEGACY_RECORD_PATH);
  if (legacyRecord === undefined) {
    const legacyConfig = LEGACY_PATHS.get(HARNESS_CONFIG_PATH)!;
    if (disk.get(HARNESS_RECORD_PATH) === undefined && legacyManagedRecord(disk.get(legacyConfig))) {
      // ★구판(0.2)이 config 에 남긴 기록 — 이행할 수 없고, 무시하고 새 폴더에 쓰면 그 안의 사용자 원본을
      //   아무도 다시 꺼내지 않는다(initRecord.legacyManagedRecord 와 같은 이유).
      return { ...view, refusal: legacyManagedNotice(legacyConfig) };
    }
    view.notes.push(
      `${LEGACY_HARNESS_DIR}/ was left in place — there is no ${LEGACY_RECORD_PATH} showing that an earlier `
      + "version of this CLI wrote it. Remove it by hand if it is a leftover.",
    );
    return view;
  }

  const state = readRecord(legacyRecord, LEGACY_RECORD_PATH);
  if (state.state !== "valid") {
    return {
      ...view,
      refusal: state.state === "absent"
        ? `${LEGACY_RECORD_PATH} could not be read. Nothing was changed.`
        : `${state.reason}. Nothing was changed — move that file aside (or restore it) and run again.`,
    };
  }
  const clash = [...LEGACY_PATHS]
    .filter(([to, from]) => disk.get(to) !== undefined && disk.get(from) !== undefined)
    .map(([to]) => to);
  if (clash.length > 0) {
    // ★두 배치가 함께 있다 — 옛 CLI(0.4.x)가 이 CLI 뒤에 init 했거나, 이동이 중간에 끊겼다. 어느 쪽 기록이
    //   지금 파일을 설명하는지 우리가 고를 근거가 없다. 고르면 한쪽 백업을 잃는다.
    return {
      ...view,
      refusal: `Both ${LEGACY_HARNESS_DIR}/ and ${HARNESS_DIR}/ hold AiNecto setup files (${clash.join(", ")}): `
        + "an older version of this CLI (0.4.x) ran here after this one, or a move was interrupted. "
        + "Nothing was changed. Undo the older setup with `npx -y -p @ai-erd/mcp@0.4.6 ai-erd init --undo` "
        + `(or remove the ${LEGACY_HARNESS_DIR}/ leftovers by hand), then run again.`,
    };
  }

  const record = state.record;
  const renamed = {
    ...record,
    files: Object.fromEntries(Object.entries(record.files).map(([path, contract]) => [toCurrent(path), contract])),
    // «하네스 폴더를 우리가 만들었다»는 같은 사실이다 — 이름만 옮긴다. 새 폴더를 이번에 만들면 적용이 또 적는다.
    createdDirectories: record.createdDirectories.map(toCurrent),
  };
  const moves: LegacyMove[] = [];
  for (const [to, from] of LEGACY_PATHS) {
    const content = disk.get(from);
    if (content === undefined) {
      continue;
    }
    files.set(to, to === HARNESS_RECORD_PATH ? serializeRecord(renamed) : content);
    moves.push({ from, to });
  }
  return {
    files,
    moves,
    legacyDirCreatedByUs: record.createdDirectories.includes(LEGACY_HARNESS_DIR),
    notes: [`${LEGACY_HARNESS_DIR}/ → ${HARNESS_DIR}/: moved what an earlier version of this CLI wrote (the folder was renamed).`],
  };
}

/**
 * 새 경로만 보고 세운 계획에 «옮기기»를 얹는다.
 *
 * <p>계획이 그 파일을 쓰면 그 내용이 새 경로에 가고, 지우면 새 경로엔 아무것도 안 생긴다. 계획이 손대지
 * 않으면 옛 내용 그대로 새 경로로 간다. 어느 경우든 옛 파일은 지운다 — 옛 폴더에 사본이 남지 않는다.
 */
export function withLegacyMoves(plan: InitPlan, view: LayoutView): InitPlan {
  if (view.moves.length === 0) {
    return view.notes.length === 0 ? plan : { ...plan, notes: [...view.notes, ...plan.notes] };
  }
  const movedTo = new Set(view.moves.map((move) => move.to));
  const planned = new Set([...plan.writes.map((write) => write.path), ...plan.deletes]);
  const carried: FileWrite[] = view.moves
    .filter((move) => !planned.has(move.to))
    .map((move) => ({ path: move.to, content: view.files.get(move.to)!, existed: false }));
  return {
    ...plan,
    // 새 경로는 디스크에 아직 없다 — «만든다»가 사실이다.
    writes: [...plan.writes.map((write) => (movedTo.has(write.path) ? { ...write, existed: false } : write)), ...carried],
    // 새 경로의 삭제는 디스크에 없는 파일이다 — 대신 옛 파일을 지운다.
    deletes: [...plan.deletes.filter((path) => !movedTo.has(path)), ...view.moves.map((move) => move.from)],
    notes: [...view.notes, ...plan.notes],
    removableDirectories: view.legacyDirCreatedByUs
      ? [...(plan.removableDirectories ?? []), LEGACY_HARNESS_DIR]
      : plan.removableDirectories,
  };
}

function toLegacy(path: string): string {
  return `${LEGACY_HARNESS_DIR}${path.slice(HARNESS_DIR.length)}`;
}

function toCurrent(path: string): string {
  return path === LEGACY_HARNESS_DIR || path.startsWith(`${LEGACY_HARNESS_DIR}/`)
    ? `${HARNESS_DIR}${path.slice(LEGACY_HARNESS_DIR.length)}`
    : path;
}
