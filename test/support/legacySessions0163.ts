/**
 * ★시험 도구 — 옛 CLI 0.16.3(`8924808` · 0.14.0 부터 같은 소스) 의 sessions.ts 를 이름·import 만 바꿔 그대로 옮겼다(재리뷰 r2 P0 반례: 옛 판은 sessions.json 을
 * {@code conversations}·{@code byAgent} 두 묶음으로 통째로 다시 쓴다). 고치지 말 것 — 옛 판의 실제 동작이 기준이다.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { isNodeError, PRIVATE_FILE_MODE } from "../../src/core/fs/privateFiles";
import { AGENT_IDS, DEFAULT_AGENT, type AgentId } from "../../src/core/agent/agents";

type Entry = { sessionId: string; updatedAt: string };
type ByConversation = Record<string, Entry>;

/**
 * (대화 uuid, Agent) → 그 Agent 의 세션 값({@code ~/.ainecto/agent/sessions.json}). 대화가 바뀌면 재개할 곳.
 * ★파일 꼴은 옛 CLI(0.14.0-next.1)와 같이 읽힌다: Claude Code 는 예전 그대로 {@code conversations} 칸, 다른 Agent 는 {@code byAgent.<id>}.
 * 옛 CLI 가 이 파일을 다시 쓰면 {@code byAgent} 는 사라진다(그 Agent 는 새 세션으로 시작할 뿐).
 */
export class LegacySessionMap0163 {
  private map: Record<AgentId, ByConversation> = emptyMap();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as { conversations?: unknown; byAgent?: unknown };
      const map = emptyMap();
      map[DEFAULT_AGENT] = entries(parsed.conversations);
      const byAgent = parsed.byAgent && typeof parsed.byAgent === "object" ? (parsed.byAgent as Record<string, unknown>) : {};
      for (const id of AGENT_IDS) {
        if (id !== DEFAULT_AGENT) map[id] = entries(byAgent[id]);
      }
      this.map = map;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      // 깨진 파일 — 이어 붙이기만 못 할 뿐 serve 는 돈다. 새로 쓴다.
      this.map = emptyMap();
    }
  }

  get(conversationUuid: string, agent: AgentId): string | undefined {
    return this.map[agent][conversationUuid]?.sessionId;
  }

  async set(conversationUuid: string, agent: AgentId, sessionId: string): Promise<void> {
    this.map[agent][conversationUuid] = { sessionId, updatedAt: new Date().toISOString() };
    await this.save();
  }

  async forget(conversationUuid: string, agent: AgentId): Promise<void> {
    delete this.map[agent][conversationUuid];
    await this.save();
  }

  private async save(): Promise<void> {
    const byAgent = Object.fromEntries(AGENT_IDS.filter((id) => id !== DEFAULT_AGENT).map((id) => [id, this.map[id]]));
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: 2, conversations: this.map[DEFAULT_AGENT], byAgent }, null, 2)}\n`,
      { mode: PRIVATE_FILE_MODE });
    await rename(tmp, this.path);
  }
}

function emptyMap(): Record<AgentId, ByConversation> {
  return Object.fromEntries(AGENT_IDS.map((id) => [id, {}])) as Record<AgentId, ByConversation>;
}

/** 읽은 칸에서 {sessionId: 글} 인 것만. */
function entries(value: unknown): ByConversation {
  if (!value || typeof value !== "object") return {};
  const out: ByConversation = {};
  for (const [conversationUuid, entry] of Object.entries(value as Record<string, unknown>)) {
    const e = entry as Partial<Entry> | null;
    if (e && typeof e.sessionId === "string") {
      out[conversationUuid] = { sessionId: e.sessionId, updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : "" };
    }
  }
  return out;
}
