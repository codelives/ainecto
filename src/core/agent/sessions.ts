import { readFile, rename, writeFile } from "node:fs/promises";
import { isNodeError, PRIVATE_FILE_MODE } from "../fs/privateFiles";

/** 대화 uuid → Claude 세션 id({@code ~/.ainecto/agent/sessions.json}). 대화가 바뀌면 {@code --resume} 할 곳. */
export class AgentSessionMap {
  private map: Record<string, { sessionId: string; updatedAt: string }> = {};

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as { conversations?: unknown };
      if (parsed.conversations && typeof parsed.conversations === "object") {
        this.map = parsed.conversations as typeof this.map;
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      // 깨진 파일 — 이어 붙이기만 못 할 뿐 serve 는 돈다. 새로 쓴다.
      this.map = {};
    }
  }

  get(conversationUuid: string): string | undefined {
    return this.map[conversationUuid]?.sessionId;
  }

  async set(conversationUuid: string, sessionId: string): Promise<void> {
    this.map[conversationUuid] = { sessionId, updatedAt: new Date().toISOString() };
    await this.save();
  }

  async forget(conversationUuid: string): Promise<void> {
    delete this.map[conversationUuid];
    await this.save();
  }

  private async save(): Promise<void> {
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: 1, conversations: this.map }, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
    await rename(tmp, this.path);
  }
}
