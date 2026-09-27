import { AGENT_TARGETS, SERVER_NAME } from "./agentTargets";
import { ROLE_ENV_VAR } from "./role";

/**
 * 저장소에 쓰는 글. ⚠<b>사용자 노출 문자열은 영어</b>로 쓴다 — 이 저장소의 기존 관례이고
 * (help·에러 메시지가 전부 영어) 공개 npm 패키지가 남의 저장소에 써 넣는 파일이다.
 * 주석·설계 메모만 한국어다.
 *
 * ★<b>역할을 여기 적지 않는다.</b> 역할의 진실원은 MCP 서버 설정 한 곳이고, 지금 무엇인지는
 * 서버가 {@code initialize} 안내문으로 말해 준다. 이 글에도 적으면 역할을 바꿀 때마다 두
 * 곳을 맞춰야 하고, 어긋나는 순간 에이전트는 틀린 쪽을 믿는다.
 */

export const MARKER_BEGIN = "<!-- ai-erd:begin -->";
export const MARKER_END = "<!-- ai-erd:end -->";

export const HARNESS_DOC_PATH = ".ai-erd/HARNESS.md";
export const HARNESS_CONFIG_PATH = ".ai-erd/config.json";

/**
 * ★<b>되돌리기 기록의 자리. 이 파일은 «전부 우리 것»이다.</b>
 *
 * <p>예전엔 기록이 {@code config.json} 안에 살았다. 그 파일은 사용자도 칸을 더하고 고치는
 * 파일이라, 한 파일에 주인이 둘이었다 — 그래서 되돌리기가 매번 「이 칸이 누구 것인가」를
 * 판정해야 했고, <b>그 판정이 네 차수 연속 샜다</b>(2026-09-23 4차 I7 → 5차 I2·S3 →
 * 6차 I1·I3 → 2026-09-27 7차 I1·I2·I3).
 *
 * <p>기록을 우리 파일로 내보내면 그 질문 자체가 사라진다:
 * <ul>
 *   <li>우리 파일 — 통째로 쓰고 통째로 지운다. 병합도 소유 판정도 없다.</li>
 *   <li>남의 파일({@code config.json}·{@code .mcp.json}·{@code AGENTS.md}) — «병합»해서 쓰고,
 *       우리 조각만 되돌린다.</li>
 * </ul>
 * ★<b>그리고 자기 지문의 순환도 같이 사라진다.</b> 「자기 해시를 담은 문서의 해시」를 피하려고
 * 정규형에서 그 칸을 빼던 장치가 필요 없다 — 우리 파일은 지문을 «재지 않는다». 사용자가
 * 고칠 파일이 아니고, 고쳐져 있으면 읽기가 실패해 「기록 없음」으로 안전하게 떨어진다.
 */
export const HARNESS_RECORD_PATH = ".ai-erd/init-record.json";

export interface HarnessDocInput {
  projectName: string;
  projectUuid: string;
  endpoint: string;
}

/**
 * 저장소에 쓸 문서. ★<b>서버 본문과 패키지 기본값이 «같은 채움 경로»를 쓴다.</b>
 * 두 경로로 갈리면 서버 판만 고쳤을 때 오프라인 사용자에게는 다른 글이 나간다.
 *
 * @param template 서버에서 받은 본문. 없으면 이 패키지의 기본값(= 오프라인 기본값)을 쓴다.
 */
export function renderHarnessDoc(input: HarnessDocInput, template?: string): string {
  return fillTemplate(template ?? DEFAULT_HARNESS_DOC, {
    projectName: input.projectName,
    projectUuid: input.projectUuid,
    endpoint: input.endpoint,
  });
}

/**
 * {{name}} 자리표시자를 채운다.
 *
 * <p>★<b>문법은 서버 레지스트리의 것이다.</b> 예전엔 이 패키지만 {@code {name}} 을 썼는데,
 * 같은 본문을 관리자 검증기가 거절했다 — 저장소를 공유하면서 계약이 둘이었다
 * (2026-09-23 독립 재리뷰 I2).
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  // ★원본을 «한 번만» 훑는다. 값을 하나씩 갈아 끼우면, 먼저 넣은 값 안의 자리표시자 모양
  //   글자가 다음 차례에 또 치환된다 — 프로젝트 이름에 {{endpoint}} 라고 적어 둔 사람의
  //   이름 일부가 실제 주소로 바뀌었다(2026-09-23 4차 독립 리뷰 S4).
  // ⚠모르는 이름은 그대로 둔다 — 지우면 「못 채웠다」를 아무도 못 본다.
  return template.replace(/\{\{([a-zA-Z0-9_]+)}}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name]! : whole);
}

export const DOC_KEY = "HARNESS.DOC";
export const AGENT_NOTE_KEY = "HARNESS.AGENT_NOTE";

/** 각 문서가 반드시 담아야 할 변수 이름 — 서버의 REQUIRED_VARIABLES 와 같은 목록이다. */
const REQUIRED_VARIABLES: Record<string, string[]> = {
  [DOC_KEY]: ["projectName", "projectUuid", "endpoint"],
  [AGENT_NOTE_KEY]: ["harnessDocPath", "serverName"],
};

/**
 * 받은 본문을 저장소에 «써도 되는가». 쓰면 안 되면 그 이유, 괜찮으면 undefined.
 *
 * <p>둘을 본다: ①필수 변수가 원문에 «있는가» — 없으면 채워도 그 값이 안 들어간다.
 * ②AGENT_NOTE 라면 관리 마커가 정확히 한 쌍 있는가 — 없으면 우리 블록을 다시 찾을 수 없어
 * 재실행마다 덧붙고 undo 도 못 걷어낸다.
 */
export function documentContractProblem(key: string, body: string): string | undefined {
  for (const name of REQUIRED_VARIABLES[key] ?? []) {
    if (!body.includes(`{{${name}}}`)) {
      return `${key} is missing the required {{${name}}} placeholder`;
    }
  }
  if (key === AGENT_NOTE_KEY) {
    return managedBlockProblem(key, body);
  }
  return undefined;
}

const DEFAULT_HARNESS_DOC = `# AI-ERD Harness

This repository is wired to an AI-ERD project. The design source of truth lives in AI-ERD,
not in this repository's files.

- Project: **{{projectName}}** (\`{{projectUuid}}\`)
- MCP endpoint: {{endpoint}}

## One session, one role

A session picks exactly one role and keeps it for the whole session. The role comes from the
MCP server configuration — not from this file, and not from anything an agent can change at
runtime. The server exposes only the tools that role is allowed to use, so a tool that is out
of role is not merely discouraged: it is absent.

| Role | Owns | Must not |
| --- | --- | --- |
| Design | Requirements, ERD, domain and module boundaries, dependency direction, tasks | Write product or test code |
| Development | Product code, following the approved design | Change requirements, ERD, architecture, or data ownership |
| Test | Test scenarios and test code, running them and reading results | Change product code to make a test pass; change the design |
| Validation | Judging the result against the design and the rules | Change anything; it reports PASS or FAIL with evidence |

Every role can **read** the whole source of truth. Reading the design is how the other roles
do their job. A session that cannot do something reports it in the session, to you.

## When you are blocked

If the work needs something your role cannot do, **stop and say so**. Do not look for a way
around it: not by editing files the tools would have written, not by asking for the role to be
changed mid-session, not by deferring the decision into the implementation.

    The work needs a design change.
    This is a Development Session, so I cannot make it.
    Settle it in a Design Session, then continue here.

Validation reports \`PASS\`, or \`FAIL\` with the rule violated, where it happened, the evidence,
and which session should pick it up next.

## Not every change needs four sessions

A small change that fits the design already recorded in AI-ERD starts at Development. The rule
is not "always run four steps" — it is that when a step is needed, it does not happen inside
another role's session.

## Switching roles

Change the role in the MCP server configuration and start a new session:

${AGENT_TARGETS.map((target) => `    ${target.label.padEnd(12)} ${target.path}`).join("\n")}
    Codex        global config — use a profile: codex -p <role>, or set ${ROLE_ENV_VAR}

Or run \`ai-erd init --role <design|development|test|validation>\` to rewrite them.

---
Generated by \`ai-erd init\`. Remove everything it wrote with \`ai-erd init --undo\`.
`;

/**
 * AGENTS.md / CLAUDE.md 에 넣는 블록. ★<b>짧게 쓴다.</b> 이 파일들은 사용자의 것이고
 * 이미 다른 규칙이 들어 있다. 우리는 한 문단만 빌리고 전문은 우리 파일로 보낸다.
 */
export function renderAgentNote(template?: string): string {
  return fillTemplate(template ?? DEFAULT_AGENT_NOTE, {
    harnessDocPath: HARNESS_DOC_PATH,
    serverName: SERVER_NAME,
  });
}

const DEFAULT_AGENT_NOTE = `${MARKER_BEGIN}
## AI-ERD Harness

This repository uses AI-ERD as its design source of truth, and each session has one role
(Design / Development / Test / Validation). Read \`{{harnessDocPath}}\` before doing work that
touches requirements, the ERD, or architecture.

The role of this session comes from the \`{{serverName}}\` MCP server configuration, and from the
access token when you signed in with a role; the server states it in its \`initialize\`
instructions and exposes only that role's tools. If the work needs something outside the role,
stop and report which session is required.
${MARKER_END}`;

/**
 * 이 본문이 <b>통째로 «관리 블록 하나»</b>인가. 아니면 그 이유.
 *
 * <p>★예전엔 「마커가 한 쌍 있나」만 봤다. 그래서 마커 «밖»에 머리말·꼬리말이 달린 본문이
 * 통과했고, 그 바깥 글은 init 때마다 한 번씩 더 붙고 undo 로도 안 걷혔다 — 우리가 걷어내는
 * 범위는 마커 «사이»뿐이기 때문이다(2026-09-23 4차 독립 리뷰 I4).
 *
 * <p>「넣는 범위」와 「빼는 범위」가 다르면 차이만큼 남의 파일에 쌓인다. 그래서 «넣을 것»도
 * 뺄 수 있는 모양이어야 한다: 앞뒤 공백을 빼면 정확히 한 블록.
 */
export function managedBlockProblem(key: string, body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed.startsWith(MARKER_BEGIN)) {
    return `${key} must begin with ${MARKER_BEGIN} — text outside the block is never removed by --undo`;
  }
  if (!trimmed.endsWith(MARKER_END)) {
    return `${key} must end with ${MARKER_END} — text outside the block is never removed by --undo`;
  }
  const inner = trimmed.slice(MARKER_BEGIN.length, trimmed.length - MARKER_END.length);
  if (inner.includes(MARKER_BEGIN) || inner.includes(MARKER_END)) {
    return `${key} must contain exactly one ${MARKER_BEGIN} and one ${MARKER_END}`;
  }
  // ★<b>수락하는 모양과 «다시 찾을 수 있는» 모양이 같아야 한다.</b> 예전엔 양끝 문자열만 봐서
  //   한 줄짜리 블록이나 앞에 공백이 붙은 마커를 수락했다. 그런데 소유 판정은 「들여쓰기 없이
  //   줄 맨 앞, 그 줄에 마커만」이라 방금 쓴 블록을 못 찾고, 재실행마다 블록이 하나씩 늘었다
  //   (2026-09-23 5차 독립 리뷰 I4).
  if (!inner.startsWith("\n")) {
    return `${key} must put ${MARKER_BEGIN} alone on its own line`;
  }
  if (!inner.endsWith("\n")) {
    return `${key} must put ${MARKER_END} alone on its own line`;
  }
  // 안에 닫히지 않은 코드펜스가 있으면, 파일에 합친 뒤 종료 마커가 그 펜스 «안»으로 들어간다.
  if (hasUnclosedFence(inner)) {
    return `${key} contains an unclosed code fence — the closing marker would fall inside it`;
  }
  return undefined;
}

/** 이 글이 코드펜스를 열어 둔 채 끝나는가. */
function hasUnclosedFence(content: string): boolean {
  let open: { char: string; length: number } | undefined;
  for (const line of content.split("\n")) {
    const fence = fenceOf(line);
    if (!fence) continue;
    if (!open) open = { char: fence.char, length: fence.length };
    else if (fence.char === open.char && fence.length >= open.length && fence.info === "") open = undefined;
  }
  return open !== undefined;
}

/**
 * 저장되는 모양 하나. ★<b>쓰기·교체가 모두 이것을 쓴다.</b>
 *
 * <p>끝 개행은 «블록의 것이 아니라 파일 합성의 것»이다. 예전엔 블록에 딸려온 개행을 남긴 채
 * 합성이 하나를 더 붙여, 같은 입력으로 다시 돌릴 때마다 파일이 1바이트씩 자랐다
 * (605 → 606 → 607, 2026-09-23 5차 독립 리뷰 S2). 변경 없는 재실행은 파일을 안 바꿔야 한다.
 */
export function canonicalManagedBlock(block: string): string {
  return block.trim();
}

/**
 * 블록이 이미 있으면 갈아 끼우고, 없으면 끝에 붙인다. 사용자의 다른 내용은 건드리지 않는다.
 *
 * @throws Error 여는 표식만 있고 닫는 표식이 없을 때. ★<b>붙이면 안 된다</b> —
 *         begin 이 둘, end 가 하나가 되어 다음 실행에서 «앞의 begin ~ 새 end» 가 한 덩이로
 *         잡히고 그 사이의 사용자 글이 사라진다(2026-09-22 독립 리뷰 I3).
 */
export function upsertMarkerBlock(existing: string | undefined, block: string): string {
  const current = existing ?? "";
  assertNoDanglingMarker(current);
  // ★개행의 소유를 한 곳으로 모은다 — 블록은 마커로 끝나고, 뒤의 한 줄은 «파일»의 것이다.
  const normalized = canonicalManagedBlock(block);
  const range = markerRange(current);
  const composed = range
    ? `${current.slice(0, range.start)}${normalized}${current.slice(range.end)}`
    : `${current.trim() ? `${current.replace(/\s*$/, "")}\n\n` : ""}${normalized}\n`;
  assertComposedBlockIsOurs(composed, current);
  return composed;
}

/**
 * ★<b>다시 찾을 수 있을 때만 쓴다.</b> 합성 «결과»를 소유 판정으로 되읽어, 관리 블록이
 * 정확히 하나로 보이는지 확인한다.
 *
 * <p>예전엔 «새 블록 안»만 검사했다. 그런데 소유 판정({@link ownedMarkerIndex})은 <b>파일
 * 문맥</b>을 본다 — 기존 파일이 코드펜스를 열어 둔 채 끝나면 멀쩡한 블록도 그 펜스 «안»으로
 * 들어가 우리 것으로 안 보인다. 그래서 init 마다 블록이 하나씩 늘고 undo 는 아무것도 못
 * 걷어냈다(2026-09-27 6차 독립 리뷰 I4).
 *
 * <p>「넣는 범위 = 빼는 범위」라는 규칙을 <b>블록이 아니라 합성 결과에</b> 적용한 것이다.
 * 검사할 대상은 우리가 만든 글이 아니라 «파일에 들어간 모습»이다.
 */
function assertComposedBlockIsOurs(composed: string, existing: string): void {
  if (ownedMarkerCount(composed, MARKER_BEGIN) === 1 && ownedMarkerCount(composed, MARKER_END) === 1) {
    return;
  }
  const reason = hasUnclosedFence(existing)
    ? "this file ends inside an unclosed code fence, so the block would sit inside it"
    : "the block could not be found again once merged into this file";
  throw new Error(
    `ai-erd could not place its block where --undo would find it again — ${reason}. `
    + "The file was left untouched; fix that and run again.",
  );
}

/**
 * 표식이 짝이 안 맞으면 그 파일은 «손대지 않는다».
 *
 * <p>사람이 손으로 잘랐거나 붙여 넣다 만 경우다. 우리가 범위를 추측해서 지우면 남의 글이
 * 날아간다. 고치는 건 사람 몫이고, 우리는 무엇이 문제인지만 말한다.
 *
 * <p>★<b>세는 대상은 «우리 것으로 알아볼 수 있는» 표식뿐이다</b>({@link ownedMarkerIndex}).
 * 인용문·코드펜스·들여쓴 예제 안의 표식은 애초에 우리 것이 아니므로 짝을 세지 않는다 —
 * 예전엔 그런 예제까지 세어서 멀쩡한 파일을 「짝이 안 맞는다」고 거절했다.
 */
export function assertNoDanglingMarker(content: string): void {
  const begins = ownedMarkerCount(content, MARKER_BEGIN);
  const ends = ownedMarkerCount(content, MARKER_END);
  if (begins !== ends || begins > 1) {
    throw new Error(
      `ai-erd markers are unbalanced (${begins} begin, ${ends} end). The file was left untouched — `
      + `remove the stray ${MARKER_BEGIN} / ${MARKER_END} by hand and run again.`,
    );
  }
  if (begins === 0) {
    return;
  }
  // ★개수만 세면 «end 가 begin 보다 앞선» 한 쌍을 정상으로 본다 — 그러면 새 블록을 덧붙이고
  //   다음 실행부터 중복으로 거절된다(2026-09-23 독립 재리뷰 I3).
  if (ownedMarkerIndex(content, MARKER_END, 0) < ownedMarkerIndex(content, MARKER_BEGIN, 0)) {
    throw new Error(
      `ai-erd markers are out of order (${MARKER_END} appears before ${MARKER_BEGIN}). `
      + "The file was left untouched — fix the markers by hand and run again.",
    );
  }
}

function ownedMarkerCount(content: string, marker: string): number {
  let count = 0;
  for (let at = ownedMarkerIndex(content, marker, 0); at >= 0;
       at = ownedMarkerIndex(content, marker, at + 1)) {
    count += 1;
  }
  return count;
}

/**
 * 이 위치가 코드펜스 «안»인가.
 *
 * <p>★예전엔 줄 맨 앞의 백틱 세 개를 «세어서» 홀짝으로 판정했다. 그래서 tilde 펜스,
 * 들여쓴 펜스, 그리고 «더 긴 펜스 안에 든 짧은 백틱 줄»을 전부 놓쳤고 — 예제로 적어 둔
 * 마커를 우리 블록으로 오인해 남의 본문을 갈아 끼웠다(2026-09-23 독립 재리뷰 I9).
 *
 * <p>지금은 Markdown 의 실제 규칙을 따른다: 펜스는 백틱 또는 tilde 세 개 이상으로 열리고,
 * 들여쓰기는 세 칸까지, 닫는 펜스는 <b>같은 문자</b>로 <b>연 것보다 짧지 않게</b>, 뒤에 아무것도
 * 없어야 한다. 완전한 파서는 아니지만 판정이 틀리는 쪽은 «안전한 쪽»(손대지 않음)이다.
 */
function isInsideFencedBlock(content: string, index: number): boolean {
  let open: { char: string; length: number } | undefined;
  let offset = 0;
  for (const line of content.split("\n")) {
    const nextOffset = offset + line.length + 1;
    if (index < nextOffset) {
      // 표식이 이 줄에 있다 — 이 줄 «전»까지의 상태가 답이다.
      return open !== undefined;
    }
    const fence = fenceOf(line);
    if (fence) {
      if (!open) {
        open = { char: fence.char, length: fence.length };
      } else if (fence.char === open.char && fence.length >= open.length && fence.info === "") {
        open = undefined;
      }
    }
    offset = nextOffset;
  }
  return open !== undefined;
}

/** 이 줄이 펜스면 그 모양. 아니면 undefined. */
function fenceOf(line: string): { char: string; length: number; info: string } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) {
    return undefined;
  }
  const run = match[1]!;
  const info = match[2]!.trim();
  // 백틱 펜스의 정보 문자열에는 백틱이 못 들어간다(Markdown 규칙).
  if (run.startsWith("`") && info.includes("`")) {
    return undefined;
  }
  return { char: run[0]!, length: run.length, info };
}

export interface MarkerRemoval {
  content: string;
  removed: boolean;
  /** 블록을 빼고 나니 빈 파일이 됐나 — 우리가 만든 파일이면 지울 수 있다. */
  emptied: boolean;
}

export function removeMarkerBlock(existing: string | undefined): MarkerRemoval {
  const current = existing ?? "";
  assertNoDanglingMarker(current);
  const range = markerRange(current);
  if (!range) {
    return { content: current, removed: false, emptied: !current.trim() };
  }
  // ★<b>이어붙는 자리만</b> 손본다. 예전엔 파일 «전체»에 /\n{3,}/ 를 돌려, 우리가 쓰지도 않은
  //   문단 사이 빈 줄까지 줄여 놓았다(2026-09-22 독립 리뷰 I2). 안 건드린 곳은 안 건드린다.
  //
  // ⚠원래 파일이 «끝 줄바꿈 없이» 끝났다면 그것까지는 되살리지 못한다 — upsert 가 붙일 때
  //   이미 지운 정보다. 그래서 「바이트 원복」이라고 말하지 않는다. 한 줄을 더한다.
  const before = current.slice(0, range.start).replace(/\n*$/, "");
  const after = current.slice(range.end).replace(/^\n*/, "");
  const stripped = before && after
    ? `${before}\n\n${after}`
    : before
      ? `${before}\n`
      : after;
  return { content: stripped.trim() ? stripped : "", removed: true, emptied: !stripped.trim() };
}

/** 관리 블록을 «원래 있던 블록»으로 갈아 끼운다. undo 가 쓴다. */
export function replaceMarkerBlockWith(content: string, block: string): string {
  const range = markerRange(content);
  return range ? `${content.slice(0, range.start)}${block}${content.slice(range.end)}` : content;
}

/**
 * 짝이 맞지 않는 마커 하나. 중첩·잘림도 «설명해야 할 것»이므로 증거에 자리를 차지한다.
 *
 * <p>★<b>여는 것과 닫는 것을 구별한다</b>(3차 리뷰 B2). 하나의 문자열로 뭉쳤더니
 * 「원래 있던 «닫는» 예제」와 「우리 블록에서 남은 «여는» 마커」가 서로 상쇄돼, 증거가 맞는 것처럼
 * 보이고 사용자 원본 백업이 버려졌다. 종류가 다르면 다른 증거다.
 */
export const UNPAIRED_BEGIN = "(unpaired ai-erd begin)";
export const UNPAIRED_END = "(unpaired ai-erd end)";

/**
 * ★<b>init «전»에 이 파일에 있던 관리 블록들의 신원.</b> 되돌리기가 「이 파일에 남은 마커를
 * 내 기록으로 «설명할 수 있나»」를 묻는 데 쓰는 증거다.
 *
 * <p>★<b>왜 개수도, 모양 비교도 아닌가</b>(2026-09-27 9차 2차 리뷰 B2·N1). 두 번 틀렸다:
 * <ul>
 *   <li>개수는 「예제를 지우고 그 자리에 우리 블록을 옮기기」를 못 본다 — 총수가 그대로다.</li>
 *   <li>우리 블록을 «모양»으로 알아보려 하면, 제목 한 줄만 고쳐도·인용문({@code > })으로
 *       옮겨도·마커를 겹쳐도 못 알아보고 그것을 「블록이 없다」로 읽어 백업을 버렸다.
 *       거꾸로 init 전부터 있던 «똑같은» 예제는 우리 블록으로 오인해 정상 되돌리기를 막았다.</li>
 * </ul>
 * ⇒ 판정을 뒤집는다. 우리 블록을 알아보려 하지 않고, <b>기록에 있는 예제를 지워 나간 뒤 남는
 * 것을 «설명되지 않은 것»으로 본다.</b> 모양 비교는 「기록해 둔 예제가 그대로 있나」를 볼 때만
 * 쓰고, 의무 완료는 <b>증거 대조</b>가 정한다.
 *
 * <p>⚠사용자가 «자기 예제»를 고쳐 놓으면 그것도 설명되지 않은 것이 되어 되돌리기가 사람에게
 * 넘어간다. 백업을 지우는 것보다는 그쪽이 맞다 — 우리는 그 둘을 가를 근거를 갖고 있지 않다.
 */
export function markerEvidence(content: string | undefined): string[] {
  if (!content) {
    return [];
  }
  // ★<b>우리 블록을 «빼고» 본 파일이 증거다.</b> 소유 범위를 남겨 두면 그 경계를 가로질러 짝이
  //   지어진다 — 원래 «여는 마커만» 적어 둔 예제가 우리 블록의 «닫는 마커»와 한 쌍으로 묶여,
  //   init 이 자기가 쓴 블록 때문에 «새로운 남의 증거»를 만들어 냈다(3차 리뷰 N2).
  //   빼고 보면 불변식이 선다: 우리 블록을 더하거나 걷어내도 남의 증거는 그대로다.
  const owned = markerRange(content);
  const rest = owned === undefined
    ? content
    : content.slice(0, owned.start) + content.slice(owned.end);
  const evidence: string[] = [];
  let cursor = 0;
  let begins = 0;
  let ends = 0;
  while (true) {
    const begin = rest.indexOf(MARKER_BEGIN, cursor);
    const close = rest.indexOf(MARKER_END, cursor);
    if (begin < 0 && close < 0) {
      break;
    }
    if (begin < 0 || (close >= 0 && close < begin)) {
      ends += 1; // 여는 것 없이 닫는 것이 먼저 나왔다.
      cursor = close + MARKER_END.length;
      continue;
    }
    const pairEnd = rest.indexOf(MARKER_END, begin + MARKER_BEGIN.length);
    if (pairEnd < 0) {
      begins += 1;
      cursor = begin + MARKER_BEGIN.length;
      continue;
    }
    evidence.push(blockShape(rest.slice(begin, pairEnd + MARKER_END.length)));
    cursor = pairEnd + MARKER_END.length;
  }
  for (let i = 0; i < begins; i += 1) evidence.push(UNPAIRED_BEGIN);
  for (let i = 0; i < ends; i += 1) evidence.push(UNPAIRED_END);
  return evidence;
}

/** 들여쓰기와 빈 줄을 지운 «모양». 펜스·목록 안으로 옮겨져도 같은 예제로 알아본다. */
function blockShape(block: string): string {
  return block.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).join("\n");
}

/** 파일에 이미 들어 있던 관리 블록 원문. 없으면 undefined. undo 가 이것을 도로 넣는다. */
export function existingMarkerBlock(content: string | undefined): string | undefined {
  if (!content) {
    return undefined;
  }
  const range = markerRange(content);
  return range ? content.slice(range.start, range.end) : undefined;
}

/** 짝이 맞는 것은 {@link assertNoDanglingMarker} 가 이미 보장한다 — 여긴 범위만 잡는다. */
function markerRange(content: string): { start: number; end: number } | undefined {
  const start = ownedMarkerIndex(content, MARKER_BEGIN, 0);
  if (start < 0) {
    return undefined;
  }
  const endMarker = ownedMarkerIndex(content, MARKER_END, start);
  if (endMarker < 0) {
    return undefined;
  }
  return { start, end: endMarker + MARKER_END.length };
}

/**
 * ★<b>판정을 뒤집었다.</b> 「예제인지 알아내서 피한다」가 아니라
 * <b>「우리 것임을 확인할 수 있는 형태만 수락한다」</b>이다.
 *
 * <p>예제를 알아내려던 쪽은 계속 샜다 — tilde 펜스, 들여쓴 펜스, 더 긴 펜스 안의 짧은 줄,
 * 인용문 안의 코드, 네 칸 들여쓴 코드 블록…(2026-09-22 I3 → 2026-09-23 3차 I9 → 4차 I6).
 * Markdown 의 «안에 담는 문맥»은 끝이 없어서, 못 알아낸 하나가 곧 남의 본문을 지운다.
 *
 * <p>그래서 우리가 쓰는 <b>정확한 한 가지 형태</b>만 우리 것으로 본다:
 * 들여쓰기 없이 줄 맨 앞에서 시작하고, 그 줄에 표식 말고는 아무것도 없으며, 코드펜스 밖일 것.
 * ⚠이보다 느슨하게 적힌 우리 블록이 있다면 그것도 «못 알아본다» — 그 경우 덧붙이지도
 * 지우지도 않고 표식이 없는 파일처럼 다룬다. 남의 글을 지우는 쪽보다 낫다.
 */
function ownedMarkerIndex(content: string, marker: string, from: number): number {
  for (let at = content.indexOf(marker, from); at >= 0; at = content.indexOf(marker, at + 1)) {
    const lineStart = content.lastIndexOf("\n", at - 1) + 1;
    if (lineStart !== at) {
      continue; // 들여썼거나 인용문(">") 뒤다 — 우리가 쓰는 형태가 아니다.
    }
    const lineEnd = content.indexOf("\n", at);
    const rest = (lineEnd < 0 ? content.slice(at) : content.slice(at, lineEnd)).slice(marker.length);
    if (rest.trim() !== "") {
      continue; // 같은 줄에 다른 글이 있다.
    }
    if (isInsideFencedBlock(content, at)) {
      continue;
    }
    return at;
  }
  return -1;
}
