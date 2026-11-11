import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { DaemonLog } from "../term/daemonLog";
import { AINECTO_TOOL_PREFIX } from "./claudeArgs";
import { documentUuidsIn } from "./documents";
import { AGENT_STOP_WAIT_MS } from "./limits";
import type { AgentLogRecord } from "./log";

/** Claude {@code result} 이벤트에서 쓰는 칸. */
export interface ClaudeResult {
  subtype?: string;
  isError: boolean;
  structuredOutput?: unknown;
  resultText?: string;
  sessionId?: string;
  numTurns?: number;
  costUsd?: number;
}

export type TurnOutcome =
  | { kind: "result"; result: ClaudeResult; documents: string[] }
  | { kind: "timeout" }
  | { kind: "exited"; code: number | null; signal: string | null; stderrTail: string };

export interface ClaudeSpawn {
  (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams;
}

export const spawnClaude: ClaudeSpawn = (args, options) =>
  spawn("claude", args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });

interface Pending {
  resolve(outcome: TurnOutcome): void;
  documents: string[];
}

/**
 * ★대화 하나에 붙은 Claude Code 프로세스 하나({@code -p --input-format stream-json}). 한 차례 = stdin 한 줄 → {@code result} 하나.
 * 쓰기 도구 결과의 문서 줄을 모은다(도구 이름은 tool_use id 로 잇는다). 차례마다 {@code agent_request}/{@code agent_response}.
 */
export class ClaudeAgentProcess {
  sessionId: string | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly toolNames = new Map<string, string>();
  private pending: Pending | undefined;
  private stderrTail = "";
  private exitInfo: { code: number | null; signal: string | null } | undefined;
  private readonly exited: Promise<void>;

  constructor(
    readonly conversationUuid: string,
    readonly resumed: boolean,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; spawnImpl: ClaudeSpawn; writeTools: ReadonlySet<string>; log: DaemonLog<AgentLogRecord> },
  ) {
    this.sessionId = undefined;
    this.child = options.spawnImpl(args, { cwd: options.cwd, env: options.env });
    const pid = this.child.pid ?? -1;
    options.log.write({ event: "process_start", pid, conversationUuid, resume: resumed });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2_000);
    });
    this.exited = new Promise((resolve) => {
      const done = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.exitInfo) return;
        this.exitInfo = { code, signal };
        options.log.write({ event: "process_exit", pid, conversationUuid, code, signal });
        this.finish({ kind: "exited", code, signal, stderrTail: this.stderrTail.trim().slice(-500) });
        resolve();
      };
      this.child.on("exit", done);
      this.child.on("error", (error) => {
        this.stderrTail += `\n${error.message}`;
        done(null, null);
      });
    });
    this.child.stdin.on("error", () => {
      // 프로세스가 먼저 끝나 stdin 이 깨졌다 — exit 이 이유를 남긴다.
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        options.log.write({ event: "bad_line", pid, length: line.length });
        return;
      }
      this.onEvent(event, options.writeTools);
    });
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  get alive(): boolean {
    return this.exitInfo === undefined;
  }

  /** 한 차례 — 기한 안에 result 가 오지 않으면 «timeout»(프로세스는 부른 쪽이 내린다). */
  async runTurn(text: string, timeoutMs: number): Promise<TurnOutcome> {
    if (!this.alive) {
      return { kind: "exited", code: this.exitInfo?.code ?? null, signal: this.exitInfo?.signal ?? null, stderrTail: this.stderrTail.trim().slice(-500) };
    }
    const outcome = new Promise<TurnOutcome>((resolve) => {
      this.pending = { resolve, documents: [] };
    });
    this.child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<TurnOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    });
    try {
      return await Promise.race([outcome, timeout]);
    } finally {
      clearTimeout(timer);
      this.pending = undefined;
    }
  }

  /** stdin 닫기 → B6 → SIGTERM → B6 → SIGKILL. */
  async stop(): Promise<void> {
    if (!this.alive) return;
    this.child.stdin.end();
    if (await this.waitExit(AGENT_STOP_WAIT_MS)) return;
    this.child.kill("SIGTERM");
    if (await this.waitExit(AGENT_STOP_WAIT_MS)) return;
    this.child.kill("SIGKILL");
    await this.waitExit(AGENT_STOP_WAIT_MS);
  }

  private async waitExit(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    try {
      return await Promise.race([this.exited.then(() => true), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  private finish(outcome: TurnOutcome): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(outcome);
  }

  private onEvent(event: Record<string, unknown>, writeTools: ReadonlySet<string>): void {
    if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
      this.sessionId = event.session_id;
      return;
    }
    const content = (event.message as { content?: unknown } | undefined)?.content;
    if (event.type === "assistant" && Array.isArray(content)) {
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") {
          this.toolNames.set(part.id, part.name);
        }
      }
      return;
    }
    if (event.type === "user" && Array.isArray(content) && this.pending) {
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.type !== "tool_result" || typeof part.tool_use_id !== "string") continue;
        const name = this.toolNames.get(part.tool_use_id);
        if (!name?.startsWith(AINECTO_TOOL_PREFIX) || !writeTools.has(name.slice(AINECTO_TOOL_PREFIX.length))) continue;
        for (const uuid of documentUuidsIn(part.content)) {
          if (!this.pending.documents.includes(uuid)) this.pending.documents.push(uuid);
        }
      }
      return;
    }
    if (event.type === "result") {
      if (typeof event.session_id === "string") this.sessionId = event.session_id;
      const documents = this.pending?.documents ?? [];
      this.finish({
        kind: "result",
        documents,
        result: {
          subtype: typeof event.subtype === "string" ? event.subtype : undefined,
          isError: event.is_error === true,
          structuredOutput: event.structured_output,
          resultText: typeof event.result === "string" ? event.result : undefined,
          sessionId: this.sessionId,
          numTurns: typeof event.num_turns === "number" ? event.num_turns : undefined,
          costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined,
        },
      });
    }
  }
}
