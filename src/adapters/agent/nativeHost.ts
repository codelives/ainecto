/*
 * AiNecto Agent — Chrome Native Messaging host.
 *
 * Chrome launches this process over stdin/stdout and speaks the native-messaging
 * framing: [uint32 LE length][UTF-8 JSON]. The host runs claude/codex in a PTY
 * (node-pty) for interactive terminal sessions, and also runs headless jobs
 * (claude -p --output-format stream-json) for structured one-shot tasks.
 *
 * node-pty is an OPTIONAL dependency: if it is unavailable, interactive PTY
 * sessions are disabled but headless jobs still work.
 */
import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const require = createRequire(import.meta.url);

// node-pty is native + optional. Loaded lazily so a missing build never breaks the CLI.
// Typed as any on purpose: no @types dependency, and it may be absent at runtime.
let pty: any;
try {
  pty = require("node-pty");
} catch {
  pty = undefined;
}

export interface AgentHostIO {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
}

interface Session {
  pty: any;
  title: string;
  cwd: string;
  tool: string;
}

/**
 * Run the native-messaging host loop. Returns 0 immediately; the process stays
 * alive via the stdin listener and active child processes until stdin closes.
 */
export function runAgentHost(io: AgentHostIO): number {
  const sessions = new Map<string, Session>();
  const jobs = new Map<string, ReturnType<typeof spawn>>();

  // ---- host -> extension (length-prefixed) ----
  function send(obj: unknown): void {
    const json = Buffer.from(JSON.stringify(obj), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    io.stdout.write(Buffer.concat([header, json]));
  }

  // ---- extension -> host (framing parser) ----
  let buf = Buffer.alloc(0);
  io.stdin.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let msg: any;
      try {
        msg = JSON.parse(body.toString("utf8"));
      } catch {
        continue;
      }
      handle(msg);
    }
  });
  io.stdin.on("end", () => {
    for (const s of sessions.values()) {
      try {
        s.pty.kill();
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  });

  function newId(): string {
    return "s" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  }
  function summary(id: string, s: Session) {
    return { id, title: s.title, cwd: s.cwd, tool: s.tool };
  }
  function sendSessions(): void {
    send({ type: "sessions", list: [...sessions].map(([id, s]) => summary(id, s)) });
  }

  function createSession(msg: any): void {
    const tool = msg.tool === "codex" ? "codex" : "claude";
    const cwd = msg.cwd || os.homedir();
    if (!pty) {
      send({ type: "error", message: "node-pty 미설치: 터미널 세션 불가 (헤드리스 작업은 가능)." });
      return;
    }
    let p: any;
    try {
      p = pty.spawn(tool, [], { name: "xterm-color", cols: 80, rows: 24, cwd, env: process.env });
    } catch (e: any) {
      send({ type: "error", message: `${tool} 실행 실패: ${e.message} (설치/PATH 확인)` });
      return;
    }
    const id = newId();
    const s: Session = { pty: p, title: path.basename(cwd), cwd, tool };
    sessions.set(id, s);
    p.onData((d: string) => send({ type: "output", sessionId: id, data: d }));
    p.onExit(({ exitCode }: { exitCode: number }) => {
      sessions.delete(id);
      send({ type: "exit", sessionId: id, code: exitCode == null ? null : exitCode });
    });
    send({ type: "created", session: summary(id, s) });
  }

  /** Convert one stream-json event into a human-readable progress line. */
  function readableEvent(ev: any): string {
    if (ev.type === "system") {
      return ev.subtype === "init" ? `\x1b[90m● 세션 시작 (${ev.model || "claude"})\x1b[0m\r\n` : "";
    }
    if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
      let out = "";
      for (const c of ev.message.content) {
        if (c.type === "text" && c.text) out += c.text + "\r\n";
        else if (c.type === "tool_use") {
          let brief = "";
          try {
            brief = JSON.stringify(c.input);
            if (brief.length > 70) brief = brief.slice(0, 70) + "…";
          } catch {
            /* ignore */
          }
          out += `\x1b[36m  🔧 ${c.name}\x1b[0m ${brief}\r\n`;
        }
      }
      return out;
    }
    if (ev.type === "user" && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type === "tool_result") return `\x1b[90m  ↳ 결과 수신\x1b[0m\r\n`;
      }
    }
    if (ev.type === "result") {
      return `\r\n\x1b[32m● 완료\x1b[0m (비용 $${(ev.total_cost_usd || 0).toFixed(4)})\r\n`;
    }
    return "";
  }

  function runJob(msg: any): void {
    const tool = msg.tool === "codex" ? "codex" : "claude";
    const cwd = msg.cwd || os.homedir();
    send({ type: "job", jobId: msg.jobId, status: "running" });
    const args = ["-p", msg.prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(tool, args, { cwd, env: process.env });
    } catch (e: any) {
      send({ type: "job", jobId: msg.jobId, status: "failed", result: { ok: false, error: `${tool} 실행 실패: ${e.message}` } });
      return;
    }
    jobs.set(msg.jobId, child);
    let out = "";
    let err = "";
    let finalResult: string | null = null;
    let finalCost: number | null = null;
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      let idx: number;
      while ((idx = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, idx).trim();
        out = out.slice(idx + 1);
        if (!line) continue;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const chunk = readableEvent(ev);
        if (chunk) send({ type: "jobLog", jobId: msg.jobId, chunk });
        if (ev.type === "result") {
          finalResult = ev.result;
          finalCost = ev.total_cost_usd;
        }
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      err += d;
    });
    child.on("close", (code: number | null) => {
      jobs.delete(msg.jobId);
      if (finalResult != null) {
        send({ type: "job", jobId: msg.jobId, status: "succeeded", result: { ok: true, summary: finalResult, cost: finalCost } });
      } else {
        send({
          type: "job",
          jobId: msg.jobId,
          status: code === 0 ? "succeeded" : "failed",
          result: { ok: code === 0, error: code === 0 ? undefined : (err.trim() || `exit ${code}`).slice(0, 800) },
        });
      }
    });
  }

  // ---- folder picker (native dialog on macOS) ----
  function pickFolder(msg: any): void {
    if (process.platform === "darwin") {
      execFile(
        "osascript",
        ["-e", 'POSIX path of (choose folder with prompt "AiNecto: 프로젝트 폴더 선택")'],
        (error, stdout) => {
          const p = error ? null : (stdout || "").trim().replace(/\/$/, "");
          send({ type: "folderPicked", reqId: msg.reqId, path: p || null });
        },
      );
    } else {
      send({ type: "folderPicked", reqId: msg.reqId, path: null });
    }
  }

  // ---- tool health (claude/codex version) ----
  function toolStatus(bin: string, cb: (r: { ok: boolean; version?: string }) => void): void {
    execFile(bin, ["--version"], { timeout: 8000 }, (error, stdout) => {
      if (error) cb({ ok: false });
      else cb({ ok: true, version: ((stdout || "").trim().split("\n")[0] ?? "").slice(0, 40) });
    });
  }
  function checkHealth(msg: any): void {
    toolStatus("claude", (claude) => {
      toolStatus("codex", (codex) => {
        send({ type: "health", reqId: msg.reqId, hostVersion: "0.1.0", node: process.version, claude, codex });
      });
    });
  }

  // ---- path validation ----
  function validatePath(msg: any): void {
    const p = (msg.path || "").trim();
    let exists = false;
    let isDir = false;
    let isGit = false;
    try {
      const st = fs.statSync(p);
      exists = true;
      isDir = st.isDirectory();
      if (isDir) {
        try {
          isGit = fs.existsSync(path.join(p, ".git"));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* not found */
    }
    send({ type: "pathInfo", reqId: msg.reqId, path: p, exists, isDir, isGit });
  }

  function handle(msg: any): void {
    switch (msg.type) {
      case "list":
        sendSessions();
        break;
      case "create":
        createSession(msg);
        break;
      case "pickFolder":
        pickFolder(msg);
        break;
      case "validatePath":
        validatePath(msg);
        break;
      case "checkHealth":
        checkHealth(msg);
        break;
      case "runJob":
        runJob(msg);
        break;
      case "cancelJob": {
        const c = jobs.get(msg.jobId);
        if (c) {
          try {
            c.kill();
          } catch {
            /* ignore */
          }
        }
        break;
      }
      case "input": {
        const s = sessions.get(msg.sessionId);
        if (s) s.pty.write(msg.data);
        break;
      }
      case "resize": {
        const s = sessions.get(msg.sessionId);
        if (s) {
          try {
            s.pty.resize(msg.cols, msg.rows);
          } catch {
            /* ignore */
          }
        }
        break;
      }
      case "kill": {
        const s = sessions.get(msg.sessionId);
        if (s) {
          try {
            s.pty.kill();
          } catch {
            /* ignore */
          }
        }
        break;
      }
    }
  }

  // greeting — extension replies with 'list'
  send({ type: "hello", version: "0.1.0" });
  return 0;
}
