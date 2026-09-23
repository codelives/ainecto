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
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
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
    const begins = body.split(MARKER_BEGIN).length - 1;
    const ends = body.split(MARKER_END).length - 1;
    if (begins !== 1 || ends !== 1) {
      return `${key} must contain exactly one ${MARKER_BEGIN} and one ${MARKER_END}`;
    }
    if (body.indexOf(MARKER_END) < body.indexOf(MARKER_BEGIN)) {
      return `${key} markers are out of order`;
    }
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
 * 블록이 이미 있으면 갈아 끼우고, 없으면 끝에 붙인다. 사용자의 다른 내용은 건드리지 않는다.
 *
 * @throws Error 여는 표식만 있고 닫는 표식이 없을 때. ★<b>붙이면 안 된다</b> —
 *         begin 이 둘, end 가 하나가 되어 다음 실행에서 «앞의 begin ~ 새 end» 가 한 덩이로
 *         잡히고 그 사이의 사용자 글이 사라진다(2026-09-22 독립 리뷰 I3).
 */
export function upsertMarkerBlock(existing: string | undefined, block: string): string {
  const current = existing ?? "";
  assertNoDanglingMarker(current);
  const range = markerRange(current);
  if (!range) {
    const separator = current.trim() ? `${current.replace(/\s*$/, "")}\n\n` : "";
    return `${separator}${block}\n`;
  }
  return `${current.slice(0, range.start)}${block}${current.slice(range.end)}`;
}

/**
 * 표식이 짝이 안 맞으면 그 파일은 «손대지 않는다».
 *
 * <p>사람이 손으로 잘랐거나 코드블록 안에 예제로 적어 둔 경우다. 어느 쪽이든 우리가 범위를
 * 추측해서 지우면 남의 글이 날아간다. 고치는 건 사람 몫이고, 우리는 무엇이 문제인지만 말한다.
 */
export function assertNoDanglingMarker(content: string): void {
  const begins = countOccurrences(content, MARKER_BEGIN);
  const ends = countOccurrences(content, MARKER_END);
  if (begins !== ends || begins > 1) {
    throw new Error(
      `ai-erd markers are unbalanced (${begins} begin, ${ends} end). The file was left untouched — `
      + `remove the stray ${MARKER_BEGIN} / ${MARKER_END} by hand and run again.`,
    );
  }
  if (begins === 0) {
    return;
  }
  const beginAt = content.indexOf(MARKER_BEGIN);
  const endAt = content.indexOf(MARKER_END);
  // ★개수만 세면 «end 가 begin 보다 앞선» 한 쌍을 정상으로 본다 — 그러면 새 블록을 덧붙이고
  //   다음 실행부터 중복으로 거절된다(2026-09-23 독립 재리뷰 I3).
  if (endAt < beginAt) {
    throw new Error(
      `ai-erd markers are out of order (${MARKER_END} appears before ${MARKER_BEGIN}). `
      + "The file was left untouched — fix the markers by hand and run again.",
    );
  }
  // ★코드블록 안의 «예제» 표식을 우리 블록으로 오인해 본문을 갈아 끼우던 것도 같은 결함이다.
  if (isInsideFencedBlock(content, beginAt)) {
    throw new Error(
      "ai-erd markers appear inside a fenced code block, so ownership is unclear. "
      + "The file was left untouched — move the example out of the fence or remove the markers.",
    );
  }
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

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = content.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }
  return count;
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
  const start = content.indexOf(MARKER_BEGIN);
  if (start < 0) {
    return undefined;
  }
  const endMarker = content.indexOf(MARKER_END, start);
  if (endMarker < 0) {
    return undefined;
  }
  return { start, end: endMarker + MARKER_END.length };
}
