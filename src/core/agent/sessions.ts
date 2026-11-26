import { readFile } from "node:fs/promises";
import { SHORT_WRITE_LOCK, withFileLock, type FileLockOptions } from "../fs/fileLock";
import { isNodeError, writePrivateFileAtomic } from "../fs/privateFiles";
import { AGENT_IDS, DEFAULT_AGENT, type AgentId } from "./agents";

/**
 * (대화, Agent) 칸 하나(설계 connect-agent-dedicated-session r3 §3-4).
 * {@code cursor} = 서버가 준 «이 세션 기억에 이 대화의 어디까지 들어 있나»(불투명 · 그 {@code sessionId} 와 짝) ·
 * {@code owner} = 쓴 계정(서버 주소 + 사용자 id — 모르면 없음).
 */
export interface AgentSessionEntry {
  sessionId: string;
  cursor?: string;
  owner?: string;
}

/**
 * 칸 자리 하나 — {@code rev} = 그 자리의 세대(쓸 때마다 1 씩 · ★지워도 남는다 — 지운 자리는 {@code {rev}} 만 남긴 표지).
 * 옛 CLI 가 쓴 칸·처음 자리는 0. {@code entry} = 재개할 세션(지웠거나 없으면 없음).
 */
export interface AgentSessionSlot {
  entry?: AgentSessionEntry;
  rev: number;
}

/** 바꿀 값 — {@code undefined} 면 그 칸을 지운다. */
export type AgentSessionWrite = { sessionId: string; cursor?: string; owner?: string } | undefined;

/**
 * (대화 uuid, Agent) → 그 Agent 의 세션 칸({@code ~/.ainecto/agent/sessions.json}). ★파일이 진실원이다 — 메모리 사본을 두지 않고 매번 읽는다.
 * ★파일 꼴은 옛 CLI(0.14.0-next.1~)와 같이 읽힌다: Claude Code 는 예전 그대로 {@code conversations} 칸, 다른 Agent 는 {@code byAgent.<id>}.
 * 옛 CLI 는 {@code sessionId}·{@code updatedAt} 만 읽고 다시 쓰므로 그 칸의 {@code cursor}·{@code owner}·{@code rev} 는 사라진다(→ 처음 규칙).
 *
 * <p>★쓰기·지우기는 {@link write} 하나 — 잠금(`sessions.json.lock`) 안에서 파일을 다시 읽고, 그 칸의 {@code rev} 가 부른 쪽이 읽은 값과 같을 때만
 * 그 칸 하나를 바꾼다(CAS). 다르면 늦은 결과로 보고 버린다. 다른 칸·모르는 칸은 읽은 그대로 둔다.
 */
export class AgentSessionMap {
  constructor(private readonly path: string, private readonly lock: FileLockOptions = SHORT_WRITE_LOCK) {}

  /** 그 자리 — 파일이 없거나 깨졌으면 빈 자리(rev 0). 그 밖의 읽기 오류는 던진다(부른 쪽이 재개 없이 돈다). */
  async read(conversationUuid: string, agent: AgentId): Promise<AgentSessionSlot> {
    return slotOf(slot(await this.readFile(), agent)?.[conversationUuid]);
  }

  /**
   * 그 칸을 {@code next} 로(undefined 면 지운다 — 세대 {@code {rev}} 는 남긴다) — 잠금 안에서 다시 읽은 자리의 rev 가 {@code expectedRev} 일 때만.
   * ★파일이 없을 때(ENOENT)·깨졌을 때만 새로 쓴다. 그 밖의 읽기 오류는 던진다 — 읽지 못한 파일의 다른 칸을 지우지 않는다.
   * @return 썼으면 "written", rev 가 달라 버렸으면 "stale"(부른 쪽이 로그 한 줄)
   */
  async write(conversationUuid: string, agent: AgentId, expectedRev: number, next: AgentSessionWrite): Promise<"written" | "stale"> {
    return await withFileLock(`${this.path}.lock`, this.lock, async () => {
      const file = (await this.readFile()) ?? {};
      if (slotOf(slot(file, agent)?.[conversationUuid]).rev !== expectedRev) return "stale";
      const byConversation = agent === DEFAULT_AGENT ? objectIn(file, "conversations") : objectIn(objectIn(file, "byAgent"), agent);
      if (next === undefined) {
        byConversation[conversationUuid] = { rev: expectedRev + 1 };   // 지운 자리 — 늦은 작성자가 옛 세대로 되살리지 못하게
      } else {
        byConversation[conversationUuid] = {
          sessionId: next.sessionId,
          updatedAt: new Date().toISOString(),
          ...(next.cursor !== undefined ? { cursor: next.cursor } : {}),
          ...(next.owner !== undefined ? { owner: next.owner } : {}),
          rev: expectedRev + 1,
        };
      }
      file.version = 2;
      objectIn(file, "conversations");   // 옛 CLI 가 쓰던 꼴 그대로 — Claude Code 칸 묶음은 비어도 둔다
      await writePrivateFileAtomic(this.path, `${JSON.stringify(file, null, 2)}\n`);
      return "written";
    });
  }

  /** 읽은 파일 객체 — 없거나(ENOENT) 깨졌으면 undefined(다음 쓰기가 새로 쓴다). 그 밖의 읽기 오류(권한 등)는 던진다. */
  private async readFile(): Promise<Record<string, unknown> | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return isObject(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * 이 차례가 쓸 칸 — ★칸의 주인과 지금 주인이 둘 다 알려져 있고 다르면(계정·서버가 바뀜) 재개 값·커서를 함께 쓰지 않는다.
 * 어느 한쪽을 모르면(옛 CLI 가 쓴 칸 · 토큰에서 사용자를 못 읽음) 재개는 예전대로 — 커서는 주인이 같다고 확인될 때만 쓴다(serve).
 */
export function usableEntry(stored: AgentSessionEntry | undefined, owner: string | undefined): AgentSessionEntry | undefined {
  if (stored?.owner !== undefined && owner !== undefined && stored.owner !== owner) return undefined;
  return stored;
}

/**
 * 칸의 주인 = 서버 주소 + 사용자 id. 사용자 id 는 이 CLI 의 로그인 토큰(JWT)의 {@code sub} — 서버가 사용자 id 로 낸다({@code NimbusJwtIssuer}).
 * 서명은 보지 않는다(서버가 모든 호출에서 본다) — 이 값은 «이 칸을 누가 썼나»를 가르는 표지일 뿐이다. 읽지 못하면 undefined.
 */
export function agentOwner(endpoint: string, accessToken: string | undefined): string | undefined {
  const payload = accessToken?.split(".")[1];
  if (!payload) return undefined;
  try {
    const sub: unknown = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub !== "" ? `${endpoint} ${sub}` : undefined;
  } catch {
    return undefined;
  }
}

/** 그 Agent 의 칸 묶음 — Claude Code 는 {@code conversations}, 다른 Agent 는 {@code byAgent.<id>}. */
function slot(file: Record<string, unknown> | undefined, agent: AgentId): Record<string, unknown> | undefined {
  if (!file || !(AGENT_IDS as readonly string[]).includes(agent)) return undefined;
  const value = agent === DEFAULT_AGENT ? file.conversations : isObject(file.byAgent) ? file.byAgent[agent] : undefined;
  return isObject(value) ? value : undefined;
}

/** 자리 하나 — 세대는 지운 표지에도 있다. 칸은 {sessionId: 글} 일 때만, 나머지 칸은 꼴이 맞을 때만 싣는다. */
function slotOf(value: unknown): AgentSessionSlot {
  if (!isObject(value)) return { rev: 0 };
  const rev = typeof value.rev === "number" && Number.isSafeInteger(value.rev) && value.rev > 0 ? value.rev : 0;
  if (typeof value.sessionId !== "string") return { rev };
  return {
    entry: {
      sessionId: value.sessionId,
      ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
      ...(typeof value.owner === "string" ? { owner: value.owner } : {}),
    },
    rev,
  };
}

/** {@code parent[key]} 가 객체가 아니면 빈 객체를 두고 돌려준다. */
function objectIn(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (isObject(value)) return value;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
