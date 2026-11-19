/**
 * Agent(Claude Code·Codex)에 넣는 한 줄 — 서버가 준 맥락(대화의 프로젝트·열린 문서)을 앞머리 한 줄로 붙인다(순수 함수).
 * «이 프로젝트»·«이 문서»가 무엇인지 Agent 가 되묻지 않게(KAN-1075 dev 종단 P0). 맥락이 없으면 글 그대로.
 * 웹에서 메시지에 붙인 파일(KAN-1110)은 이름만 온다 — 내용은 PC 로 넘어오지 않는다고 함께 적는다(옛 서버는 칸이 없다).
 * 칸반 카드 대화면 그 카드(KAN-1229 ⑦)도 — «이 카드»가 무엇인지(옛 서버는 칸이 없다).
 */
export interface AgentTurnContext {
  project?: { uuid?: unknown; name?: unknown; workspaceUuid?: unknown; workspaceName?: unknown };
  openDocument?: { uuid?: unknown; title?: unknown; type?: unknown };
  card?: { uuid?: unknown; key?: unknown; title?: unknown };
  attachments?: unknown;
}

export function agentPromptText(text: string, context: AgentTurnContext | undefined): string {
  const parts: string[] = [];
  const p = context?.project;
  if (p && typeof p.uuid === "string") {
    parts.push(`project «${str(p.name)}» (projectUuid ${p.uuid}${typeof p.workspaceUuid === "string"
      ? `, workspace «${str(p.workspaceName)}» ${p.workspaceUuid}` : ""})`);
  }
  const d = context?.openDocument;
  if (d && typeof d.uuid === "string") {
    parts.push(`open document «${str(d.title)}» (documentUuid ${d.uuid}${typeof d.type === "string" ? `, ${d.type}` : ""})`);
  }
  const c = context?.card;
  if (c && typeof c.uuid === "string") {
    parts.push(`card «${str(c.title)}» (${typeof c.key === "string" ? `${c.key}, ` : ""}cardUuid ${c.uuid})`);
  }
  const files = Array.isArray(context?.attachments)
    ? context.attachments.map((f) => str((f as { filename?: unknown } | null)?.filename)).filter((name) => name !== "")
    : [];
  if (files.length > 0) {
    parts.push(`attached files ${files.map((name) => `«${name}»`).join(", ")} (names only — the files are not available on this machine)`);
  }
  if (parts.length === 0) return text;
  return `[AiNecto context — "this project" / "this document" / "this card" mean these] ${parts.join(" · ")}\n\n${text}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
