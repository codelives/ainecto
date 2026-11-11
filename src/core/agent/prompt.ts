/**
 * Claude 에 넣는 한 줄 — 서버가 준 맥락(대화의 프로젝트·열린 문서)을 앞머리 한 줄로 붙인다(순수 함수).
 * «이 프로젝트»·«이 문서»가 무엇인지 Agent 가 되묻지 않게(KAN-1075 dev 종단 P0). 맥락이 없으면 글 그대로.
 */
export interface AgentTurnContext {
  project?: { uuid?: unknown; name?: unknown; workspaceUuid?: unknown; workspaceName?: unknown };
  openDocument?: { uuid?: unknown; title?: unknown; type?: unknown };
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
  if (parts.length === 0) return text;
  return `[AiNecto context — "this project" / "this document" mean these] ${parts.join(" · ")}\n\n${text}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
