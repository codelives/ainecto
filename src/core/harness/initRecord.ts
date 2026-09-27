import { HARNESS_RECORD_PATH } from "./harnessDoc";

/**
 * 되돌리기 «기록»의 형식과 그 <b>상태 판정</b>. ★이 파일의 책임은 하나다 —
 * 「디스크에 있는 이것이 우리 기록인가, 그렇다면 온전한가」에 <b>명시적으로</b> 답하는 것.
 *
 * <p>★<b>왜 파일을 따로 두는가.</b> 다섯 차수에 걸쳐 같은 축이 샜고, 마지막 독립 리뷰가 그 이름을
 * 붙였다(2026-09-27 8차): <b>「파일 경로가 그 안의 내용이 유효하다는 증거는 아니다」</b>.
 * 기록을 우리 파일로 내보낸 것(7차)은 「이 칸이 누구 것인가」를 없앴지만, 그다음 질문을 남겼다 —
 * 「이 파일이 우리 것이라는 사실이 그 내용을 신뢰할 근거인가」. 아니다.
 *
 * <p>그때 무슨 일이 일어났나:
 * <ul>
 *   <li>{@code kind} 가 다르거나 JSON 이 깨진 파일을 «부재»로 읽고, init 이 백업 없이 덮었다.
 *       읽기를 거절했는데 쓰기는 거절하지 않은 것이다(8차 I1).</li>
 *   <li>{@code kind} 만 맞으면 {@code managed} 가 배열이어도, {@code version} 이 999 여도,
 *       지문 칸이 통째로 없어도 «정상 기록»으로 읽혔다. 그리고 그 기록으로 돌린 undo 가
 *       <b>사용자가 편집한 문서를 지웠다</b>(8차 I2). 빈 기본값으로 채우는 관용이
 *       불확실성을 «확실»로 바꾼 것이다.</li>
 * </ul>
 * ⛔그래서 여기서는 {@code as unknown as} 로 모양을 «주장»하지 않고, 빈 값으로 «메우지» 않는다.
 * 읽어 낼 수 없으면 읽어 낼 수 없다고 말한다 — 그것이 부르는 쪽이 필요한 정보다.
 */

/** 기록 파일의 신원. 사용자가 같은 이름으로 둔 파일을 실행 근거로 삼지 않는다. */
export const RECORD_KIND = "ai-erd/init-record";

/** 이 판이 읽고 쓰는 형식. 모르는 판은 «손상»이 아니라 «지원하지 않음»이다. */
export const RECORD_VERSION = 2;

/**
 * 우리가 «소유한 것»의 값. ★명시적 타입이라 세 가지가 갈린다:
 * 「그 자리에 아무것도 없었다」 · 「JSON 값이었다(null 일 수도 있다)」 · 「글이었다」.
 *
 * <p>예전엔 {@code undefined} 하나로 앞의 둘을 덮었고, 그래서 사용자가 저장해 둔 {@code null} 이
 * «백업 없음»으로 바뀌었다(7차 I5).
 */
export type Owned =
  | { at: "absent" }
  | { at: "json"; value: unknown }
  | { at: "text"; text: string };

export const ABSENT: Owned = { at: "absent" };

/** 우리가 그 파일의 «무엇을» 소유하나. 넣는 법과 빼는 법이 여기서 갈린다. */
export type OwnedScope =
  /** 파일 본문 전체를 우리가 쓴다(.ai-erd/HARNESS.md). */
  | "whole"
  /** JSON 안의 MCP 서버 항목 하나(.mcp.json · .cursor/mcp.json). */
  | "entry"
  /** Markdown 안의 마커 블록 하나(AGENTS.md · CLAUDE.md). */
  | "block"
  /** JSON 안의 «칸 몇 개»(.ai-erd/config.json). 나머지 칸은 사용자 것이다. */
  | "fields";

/**
 * 한 파일에 대한 복구 계약. ★<b>한 파일의 사실이 한 곳에 모인다.</b>
 *
 * <p>예전 기록은 경로를 키로 한 «평행한 map 아홉 개»였다({@code created}·{@code replacedEntries}·
 * {@code blockAdded}·{@code replacedBlocks}·{@code originals}·{@code lastWritten}·
 * {@code lastWrittenFragment}·{@code lastWrittenBody}·{@code foreignMarkers}). 그래서 지금까지
 * 나온 결함이 거의 전부 <b>「한 map 은 X 라 하고 다른 map 은 Y 라 한다」</b>였고, 고칠 때마다
 * 그중 «한 map»만 고쳤다. 한 항목으로 묶으면 그 어긋남이 생길 자리가 없다.
 */
export interface FileContract {
  scope: OwnedScope;
  /** 우리가 이 파일을 «만들었나». 지워도 되는 것은 이것뿐이다. */
  createdByUs: boolean;
  /** 되돌릴 «목표» — 우리가 밀어낸 것. {@code absent} 면 「우리가 더했다」는 뜻이다. */
  original: Owned;
  /** 우리가 «실제로 쓴» 것. 「지금 값이 아직 우리 것인가」의 유일한 근거다. */
  written: Owned;
  /**
   * 우리가 쓴 «파일 전체»의 지문. 파일을 지워도 되는지 판정할 때만 쓴다.
   *
   * <p>⚠없으면 «모른다»는 뜻이고, 모를 때는 지우지 않는다. 예전엔 지문이 없으면
   * {@code changedSinceOurWrite} 가 false 를 돌려줘서 「안 바뀌었다」로 읽혔고, 그 판정이
   * 사용자 문서 삭제의 근거가 됐다(8차 I2).
   */
  fileFingerprint?: string;
  /** {@code scope==="fields"} 전용 — 우리가 쓴 칸의 값. 칸 단위 대조의 근거다. */
  writtenFields?: Record<string, unknown>;
  /**
   * {@code scope==="fields"} 전용 — 우리가 덮기 «전»에 그 칸에 있던 것. 칸마다 따로 든다.
   *
   * <p>★파일 전체를 원본으로 들면 두 가지를 못 한다(8차 I4·I6):
   * <ul>
   *   <li>재init 에서 사용자가 고친 칸을 «새 기준»으로 삼기 — 파일 단위로는 어느 칸이 바뀐
   *       것인지 말할 수 없다.</li>
   *   <li>원래 «빈 객체»였던 config 를 빈 객체로 되돌리기 — 파일 부재와 빈 객체가 같은
   *       결과로 뭉쳤고, 그래서 프로젝트 연결이 남았다.</li>
   * </ul>
   * ⚠「파일이 아예 없었다」는 {@link #createdByUs} 가 말한다. 이 칸은 «있던 파일 안의 칸»만 다룬다.
   */
  originalFields?: Record<string, Owned>;
  /**
   * {@code scope==="block"} 전용 — init «전»에 이 파일에 있던 관리 블록들의 «신원».
   * {@code markerEvidence} 가 만든 목록이고, 짝이 안 맞는 마커는 그 자리에 표시가 하나 들어간다.
   *
   * <p>★<b>개수에서 목록으로 두 번 옮겨 왔다</b>(8차 I5 → 9차 B2·N1):
   * <ul>
   *   <li>Boolean 하나로는 「원래 예제가 있다」와 「우리 블록이 옮겨져 남았다」를 못 갈랐다.</li>
   *   <li>개수로는 「예제를 지우고 그 자리에 우리 블록을 옮기기」를 못 봤다 — 총수가 그대로다.</li>
   *   <li>우리 블록을 «모양»으로 알아보려 하면 제목 한 줄 편집·인용문 이동·중첩에 뚫렸고,
   *       반대로 init 전부터 있던 똑같은 예제를 우리 것으로 오인해 정상 되돌리기를 막았다.</li>
   * </ul>
   * ⇒ 우리 블록을 알아보려 하지 않는다. <b>이 목록으로 설명되지 않는 마커가 파일에 있으면</b>
   * 되돌리기를 완료로 만들지 않고 백업을 지킨다.
   */
  foreignBlocks?: string[];
}

export interface InitRecord {
  version: number;
  /** 경로 → 그 파일에 대한 계약. */
  files: Record<string, FileContract>;
  /** 우리가 «실제로 만든» 디렉터리. 적용이 mkdir 결과로 채운다. */
  createdDirectories: string[];
}

export function emptyRecord(): InitRecord {
  return { version: RECORD_VERSION, files: {}, createdDirectories: [] };
}

/**
 * 디스크에 있는 것의 «상태». ★부르는 쪽이 넷을 구별해서 다뤄야 한다 —
 * 특히 {@code corrupt}·{@code legacy} 는 「없음」이 아니다. 덮으면 안 된다.
 */
export type RecordState =
  | { state: "absent" }
  | { state: "valid"; record: InitRecord }
  | { state: "corrupt"; reason: string }
  | { state: "legacy"; reason: string };

/**
 * ★<b>단일 로더.</b> 기록을 읽는 곳은 여기 하나다.
 *
 * <p>⛔관용을 베풀지 않는다. 한 칸이라도 계약을 벗어나면 «손상»이다 — 그 기록으로 파일을 지우는
 * 것이 되돌리기가 하는 일이고, 판단 재료가 반쯤 맞는 상태로 그 일을 해선 안 된다.
 */
export function readRecord(content: string | undefined): RecordState {
  if (content === undefined) {
    return { state: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { state: "corrupt", reason: `${HARNESS_RECORD_PATH} is not valid JSON` };
  }
  if (!isObject(parsed)) {
    return { state: "corrupt", reason: `${HARNESS_RECORD_PATH} is not a JSON object` };
  }
  if (parsed.kind !== RECORD_KIND) {
    return {
      state: "corrupt",
      reason: `${HARNESS_RECORD_PATH} exists but is not an ai-erd record (kind=`
        + `${JSON.stringify(parsed.kind)})`,
    };
  }
  if (parsed.version !== RECORD_VERSION) {
    // ★모르는 판은 손상이 아니다 — 다른 판의 CLI 가 쓴 «온전한» 기록일 수 있다.
    //   그 기록의 뜻을 우리가 추측해선 안 되고, 덮어서도 안 된다.
    return {
      state: "legacy",
      reason: `${HARNESS_RECORD_PATH} was written by another version of this CLI `
        + `(record version ${JSON.stringify(parsed.version)}, this CLI reads ${RECORD_VERSION})`,
    };
  }
  const files = parsed.files;
  if (!isObject(files)) {
    return { state: "corrupt", reason: `${HARNESS_RECORD_PATH} has no "files" object` };
  }
  const out: Record<string, FileContract> = {};
  for (const [path, raw] of Object.entries(files)) {
    const read = readContract(raw);
    if ("problem" in read) {
      return {
        state: "corrupt",
        reason: `${HARNESS_RECORD_PATH} has an unusable entry for ${path} — it ${read.problem}`,
      };
    }
    out[path] = read.contract;
  }
  const directories = parsed.createdDirectories;
  if (directories !== undefined && !isStringArray(directories)) {
    return { state: "corrupt", reason: `${HARNESS_RECORD_PATH} has a malformed createdDirectories` };
  }
  return {
    state: "valid",
    record: {
      version: RECORD_VERSION,
      files: out,
      createdDirectories: directories === undefined ? [] : [...directories],
    },
  };
}

/** 기록 파일의 저장 모양. ★지문을 담지 않는다 — 자기 해시를 담은 문서의 해시라는 순환이 생긴다. */
export function serializeRecord(record: InitRecord): string {
  return `${JSON.stringify({
    kind: RECORD_KIND,
    version: RECORD_VERSION,
    files: record.files,
    createdDirectories: record.createdDirectories,
  }, null, 2)}\n`;
}

/**
 * 한 항목을 읽는다. ★읽어 내지 못하면 «무엇이 어긋났나»를 함께 돌려준다 —
 * 사용자가 손대야 할 파일이라 「읽을 수 없다」만으로는 고칠 수 없다.
 */
type ContractRead = { contract: FileContract } | { problem: string };

function readContract(raw: unknown): ContractRead {
  if (!isObject(raw)) {
    return { problem: "is not a JSON object" };
  }
  const scope = raw.scope;
  if (scope !== "whole" && scope !== "entry" && scope !== "block" && scope !== "fields") {
    return { problem: `has an unknown scope (${JSON.stringify(raw.scope)})` };
  }
  if (typeof raw.createdByUs !== "boolean") {
    return { problem: "does not say whether ai-erd created the file" };
  }
  const original = readOwned(raw.original);
  const written = readOwned(raw.written);
  if (original === undefined) {
    return { problem: "has no readable record of what was there before" };
  }
  if (written === undefined) {
    return { problem: "has no readable record of what ai-erd wrote" };
  }
  if (raw.fileFingerprint !== undefined && typeof raw.fileFingerprint !== "string") {
    return { problem: "has a malformed fileFingerprint" };
  }
  if (raw.writtenFields !== undefined && !isObject(raw.writtenFields)) {
    return { problem: "has a malformed writtenFields" };
  }
  let originalFields: Record<string, Owned> | undefined;
  if (raw.originalFields !== undefined) {
    if (!isObject(raw.originalFields)) {
      return { problem: "has a malformed originalFields" };
    }
    originalFields = {};
    for (const [field, value] of Object.entries(raw.originalFields)) {
      const owned = readOwned(value);
      if (owned === undefined) {
        return { problem: `has no readable original for the field ${field}` };
      }
      originalFields[field] = owned;
    }
  }
  if (raw.foreignBlocks !== undefined && !isStringArray(raw.foreignBlocks)) {
    return { problem: "has a malformed foreignBlocks" };
  }
  if (scope === "block" && raw.foreignBlocks === undefined) {
    // ★블록 계약은 「이 파일에 원래 무엇이 있었나」 없이는 완료를 판정할 수 없다. 없으면 없다고 한다.
    return { problem: 'owns a marker block but does not say what marker blocks were already in the file' };
  }
  if (scope === "fields") {
    const problem = fieldsContractProblem({
      written,
      writtenFields: isObject(raw.writtenFields) ? raw.writtenFields : undefined,
      originalFields,
    });
    if (problem !== undefined) {
      return { problem };
    }
  }
  const contract: FileContract = {
    scope, createdByUs: raw.createdByUs, original, written,
  };
  if (typeof raw.fileFingerprint === "string") contract.fileFingerprint = raw.fileFingerprint;
  if (isObject(raw.writtenFields)) contract.writtenFields = { ...raw.writtenFields };
  if (originalFields !== undefined) contract.originalFields = originalFields;
  if (isStringArray(raw.foreignBlocks)) contract.foreignBlocks = [...raw.foreignBlocks];
  return { contract };
}

/**
 * {@code scope==="fields"} 계약이 «스스로 어긋나지» 않았나. ★로더와 계획이 <b>같은 이 함수</b>를
 * 쓴다 — 두 곳에 두면 「한쪽은 괜찮다 하고 다른 쪽은 아니라 한다」가 또 생긴다.
 *
 * <p>★<b>칸이 «있는지»에서 멈추면 반쯤 맞는 기록으로 파일을 고친다</b>(9차 B1). 세 번 뚫렸다:
 * <ul>
 *   <li>{@code writtenFields.endpoint} 하나만 지운 기록을 유효로 읽었고, 되돌리기는 그 칸을
 *       「사용자가 고쳤다」로 읽어 우리 값을 남긴 뒤 <b>사용자 원본이 든 기록까지</b> 지웠다.</li>
 *   <li>두 map 에서 «동시에» 지우면 그것도 유효였다 — 칸 집합끼리만 맞춰 봤기 때문이다.
 *       그래서 우리가 쓴 본문에 있는 «우리 칸»이 기록에 적혀 있는지도 본다(2차 리뷰 B1).</li>
 *   <li>★원본을 {@code {at:"text"}} 로 바꿔 두면 유효로 읽혔고, 되돌리기는 «되돌릴 수 없는
 *       모양»을 부재로 취급해 그 칸을 지웠다 — config 가 {@code &#123;&#125;} 가 되고 기록이 사라졌다.
 *       fields 의 원본은 {@code absent} 또는 {@code json} 뿐이다(2차 리뷰 B1).</li>
 * </ul>
 *
 * @param ownedFields 부르는 쪽이 아는 «우리 칸» 이름. 계획은 넘기고(그래서 양쪽 방향을 다 본다),
 *                    로더는 넘기지 않는다 — 어느 칸이 우리 것인지는 형식 층의 지식이 아니다.
 */
export function fieldsContractProblem(
  contract: {
    written: Owned;
    writtenFields?: Record<string, unknown>;
    originalFields?: Record<string, Owned>;
  },
  ownedFields?: readonly string[],
): string | undefined {
  const { written, writtenFields, originalFields } = contract;
  if (writtenFields === undefined) {
    return "owns only some fields of the file but does not say which ones it wrote (writtenFields)";
  }
  if (originalFields === undefined) {
    return "owns only some fields of the file but does not say what was in them before (originalFields)";
  }
  const writtenKeys = Object.keys(writtenFields).sort();
  const originalKeys = Object.keys(originalFields).sort();
  if (writtenKeys.length !== originalKeys.length
      || writtenKeys.some((key, at) => key !== originalKeys[at])) {
    return `lists different fields as written (${writtenKeys.join(", ") || "none"}) and as `
      + `backed up (${originalKeys.join(", ") || "none"})`;
  }
  for (const key of writtenKeys) {
    // ★되돌리기가 할 수 있는 일은 「그 값을 도로 넣기」와 「그 칸을 빼기」뿐이다. 그 둘이 아닌
    //   모양을 들고 있으면 그것은 판정 자료가 아니라 손상이다.
    const original = originalFields[key]!;
    if (original.at !== "absent" && original.at !== "json") {
      return `records the original of ${key} as ${original.at}, which is not something --undo `
        + "can put back into a JSON field";
    }
  }
  if (written.at !== "text") {
    return "owns only some fields of the file but does not hold the file text it wrote";
  }
  let body: unknown;
  try {
    body = JSON.parse(written.text);
  } catch {
    return "holds a written file body that is not valid JSON";
  }
  if (!isObject(body)) {
    return "holds a written file body that is not a JSON object";
  }
  for (const key of writtenKeys) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) {
      return `says it wrote ${key}, but that field is not in the file body it recorded`;
    }
    if (stableStringify(body[key]) !== stableStringify(writtenFields[key])) {
      return `records a different value for ${key} than the file body it wrote`;
    }
  }
  if (ownedFields !== undefined) {
    // ★반대 방향. 우리가 쓴 본문에 «우리 칸»이 있는데 기록이 그 칸을 말하지 않으면, 그 칸에 대한
    //   판정 자료가 없다는 뜻이다 — 두 map 에서 동시에 지운 기록이 그래서 유효로 읽혔다.
    for (const key of ownedFields) {
      if (Object.prototype.hasOwnProperty.call(body, key)
          && !Object.prototype.hasOwnProperty.call(writtenFields, key)) {
        return `wrote ${key} into the file but does not record what it put there`;
      }
    }
  }
  return undefined;
}

function readOwned(raw: unknown): Owned | undefined {
  if (!isObject(raw)) {
    return undefined;
  }
  if (raw.at === "absent") {
    return ABSENT;
  }
  if (raw.at === "json") {
    // ⚠value 는 «없어도» 되는 칸이 아니다 — 키가 있어야 한다. null 이 값이기 때문이다.
    return Object.prototype.hasOwnProperty.call(raw, "value")
      ? { at: "json", value: raw.value }
      : undefined;
  }
  if (raw.at === "text") {
    return typeof raw.text === "string" ? { at: "text", text: raw.text } : undefined;
  }
  return undefined;
}

/**
 * 객체 칸의 «순서»를 지운 JSON.
 *
 * <p>★{@code JSON.parse}→{@code stringify} 는 공백은 정규화하지만 칸 순서는 그대로 둔다.
 * 그래서 사람이 편집기로 열었다 저장만 해도 「사용자가 고쳤다」로 잡혔다(4차 독립 리뷰 S1).
 *
 * <p>★<b>여기 한 벌만 둔다.</b> 기록의 «상호 일치» 판정과 계획의 «값이 바뀌었나» 판정이 다른
 * 정규형을 쓰면 「한 쪽은 같다고 하고 다른 쪽은 다르다고 한다」가 또 생긴다 — 그것이 다섯 차수를
 * 관통한 실패의 이름이었다.
 *
 * <p>⚠배열 순서는 유지한다 — 거기선 순서가 곧 내용이다(MCP 인자 목록 등).
 */
export function stableStringify(value: unknown): string {
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

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
