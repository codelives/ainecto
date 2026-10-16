import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAinectoCli } from "../src/adapters/cli/ainectoCli";

/**
 * 알림·할 일 폴링 명령 — 종료 코드(0 새 것 · 3 없음 · 1 오류 · 2 사용법)와 «받기 → 처리 → ack» 계약(설계 §6-4 (5)).
 * 서버는 fetch 를 바꿔 흉내 낸다: 도구 이름·인자를 기록하고 정해 둔 결과를 돌려준다.
 */
describe("inbox poll commands", () => {
  let cwd: string;
  let previousCwd: string;
  let calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  let replies: Array<unknown>;

  beforeEach(() => {
    previousCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "ainecto-inbox-"));
    process.chdir(cwd);
    process.env.AINECTO_TOKEN = "token-redacted";
    calls = [];
    replies = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: { name: string; arguments: Record<string, unknown> } };
      calls.push(body.params);
      const next = replies.shift();
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: next }));
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AINECTO_TOKEN;
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("poll saves the batch before printing, repeats it until ack, and exits 3 when nothing is new", async () => {
    const cursor = join(cwd, "state", "inbox.cursor");
    replies.push(tool({ items: [{ id: "n1", seq: 4 }, { id: "n2", seq: 5 }], ackToken: "ack-4-5", stream: "s1", hasMore: false }));

    const first = io();
    expect(await runAinectoCli(["notifications", "poll", "--env", "dev", "--cursor-file", cursor, "--direct-only", "--json"], first)).toBe(0);
    expect(JSON.parse(first.out()).data.items).toHaveLength(2);
    expect(calls[0]).toEqual({ name: "mcp__ainecto__list_notifications", arguments: { cursor: "saved", directOnly: true } });
    const saved = JSON.parse(readFileSync(cursor, "utf8"));
    expect(saved).toMatchObject({ ackToken: "ack-4-5", stream: "s1", filter: { directOnly: true } });

    const again = io();
    expect(await runAinectoCli(["notifications", "poll", "--env", "dev", "--cursor-file", cursor, "--direct-only", "--json"], again)).toBe(0);
    expect(JSON.parse(again.out()).data).toMatchObject({ pending: true });
    expect(calls).toHaveLength(1);   // ack 전 — 서버에 묻지 않는다

    replies.push(tool({ items: [{ id: "n3", seq: 6 }], ackToken: "ack-6", stream: "s1" }));
    expect(await runAinectoCli(["notifications", "ack", "--env", "dev", "--cursor-file", cursor], io())).toBe(0);
    expect(calls[1]?.arguments).toMatchObject({ cursor: "saved", ack: "ack-4-5", directOnly: true, limit: 1 });
    expect(JSON.parse(readFileSync(cursor, "utf8")).ackToken).toBeUndefined();

    replies.push(tool({ items: [], stream: "s1" }));
    expect(await runAinectoCli(["notifications", "poll", "--env", "dev", "--cursor-file", cursor, "--direct-only"], io())).toBe(3);
    expect(await runAinectoCli(["notifications", "ack", "--env", "dev", "--cursor-file", cursor], io())).toBe(3);
  });

  it("a pending batch for another filter is an error, too-soon polls exit 3, usage errors exit 2", async () => {
    const cursor = join(cwd, "inbox.cursor");
    replies.push(tool({ items: [{ id: "n1", seq: 1 }], ackToken: "a1", stream: "s" }));
    expect(await runAinectoCli(["notifications", "poll", "--env", "dev", "--cursor-file", cursor], io())).toBe(0);
    const other = io();
    expect(await runAinectoCli(["notifications", "poll", "--env", "dev", "--cursor-file", cursor, "--kinds", "COMMENT_MENTIONED"], other)).toBe(1);
    expect(other.err()).toContain("different filter");

    const fresh = join(cwd, "other.cursor");
    replies.push(tool({ items: [], retryAfterSeconds: 12, stream: "s" }));
    const soon = io();
    expect(await runAinectoCli(["notifications", "poll", "--env", "dev", "--cursor-file", fresh], soon)).toBe(3);
    expect(soon.err()).toContain("12s");

    expect(await runAinectoCli(["notifications", "poll", "--env", "dev"], io())).toBe(2);
    expect(await runAinectoCli(["notifications", "poll", "--env", "dev", "--cursor-file", fresh, "--bogus"], io())).toBe(2);
  });

  it("agent-todos poll --only-new exits 0 only for to-dos it has not seen", async () => {
    const seen = join(cwd, "todos.seen");
    replies.push(tool({ items: [{ todoId: "t1" }], hasMore: false }));
    const first = io();
    expect(await runAinectoCli(["agent-todos", "poll", "--env", "dev", "--only-new", "--seen-file", seen, "--json"], first)).toBe(0);
    expect(calls[0]).toEqual({ name: "mcp__ainecto__list_agent_todos", arguments: { state: ["OPEN"], limit: 50 } });

    replies.push(tool({ items: [{ todoId: "t1" }], hasMore: false }));
    expect(await runAinectoCli(["agent-todos", "poll", "--env", "dev", "--only-new", "--seen-file", seen], io())).toBe(3);

    replies.push(tool({ items: [{ todoId: "t1" }, { todoId: "t2" }], hasMore: false }));
    const third = io();
    expect(await runAinectoCli(["agent-todos", "poll", "--env", "dev", "--only-new", "--seen-file", seen, "--json"], third)).toBe(0);
    expect(JSON.parse(third.out()).data.items).toEqual([{ todoId: "t2" }]);

    expect(await runAinectoCli(["agent-todos", "poll", "--env", "dev", "--only-new"], io())).toBe(2);
  });

  it("scope filters: workspaceUuids/projectUuids arrays, only given axes, a lone project without workspace is the legacy string", async () => {
    replies.push(tool({ items: [], stream: "s" }));
    await runAinectoCli(["notifications", "poll", "--env", "dev", "--cursor-file", join(cwd, "one.cursor"), "--project", "p1"], io());
    expect(calls[0]?.arguments).toEqual({ cursor: "saved", projectUuid: "p1" });

    replies.push(tool({ items: [], stream: "s" }));
    await runAinectoCli(["notifications", "poll", "--env", "dev", "--cursor-file", join(cwd, "many.cursor"),
      "--workspace", "w2", "--workspace", "w1", "--project", "p2", "--project", "p1", "--project", "p2"], io());
    expect(calls[1]?.arguments).toEqual({ cursor: "saved", workspaceUuids: ["w1", "w2"], projectUuids: ["p1", "p2"] });

    replies.push(tool({ items: [], stream: "s" }));
    await runAinectoCli(["notifications", "poll", "--env", "dev", "--cursor-file", join(cwd, "ws.cursor"), "--workspace", "w1", "--project", "p1"], io());
    expect(calls[2]?.arguments).toEqual({ cursor: "saved", workspaceUuids: ["w1"], projectUuids: ["p1"] });

    replies.push(tool({ items: [], hasMore: false }));
    await runAinectoCli(["agent-todos", "poll", "--env", "dev", "--project", "p1"], io());
    expect(calls[3]?.arguments).toEqual({ state: ["OPEN"], projectUuid: "p1", limit: 50 });

    replies.push(tool({ items: [], hasMore: false }));
    await runAinectoCli(["agent-todos", "poll", "--env", "dev", "--workspace", "w1"], io());
    expect(calls[4]?.arguments).toEqual({ state: ["OPEN"], workspaceUuids: ["w1"], limit: 50 });

    replies.push(tool({ items: [], hasMore: false }));
    await runAinectoCli(["agent-todos", "poll", "--env", "dev", "--project", "p2", "--project", "p1"], io());
    expect(calls[5]?.arguments).toEqual({ state: ["OPEN"], projectUuids: ["p1", "p2"], limit: 50 });
  });

  it("a pending batch is replayed for the same scope sets in any order, refused for another scope, and acked with its scope", async () => {
    const cursor = join(cwd, "scope.cursor");
    replies.push(tool({ items: [{ id: "n1", seq: 1 }], ackToken: "a1", stream: "s" }));
    expect(await runAinectoCli(["notifications", "poll", "--env", "dev", "--cursor-file", cursor,
      "--workspace", "w1", "--workspace", "w2", "--project", "p1", "--project", "p2"], io())).toBe(0);

    // 같은 집합(순서·중복만 다름) — 보류 배치를 다시 낸다, 서버에 묻지 않는다.
    expect(await runAinectoCli(["notifications", "poll", "--env", "dev", "--cursor-file", cursor,
      "--workspace", "w2", "--workspace", "w1", "--workspace", "w2", "--project", "p2", "--project", "p1"], io())).toBe(0);
    expect(calls).toHaveLength(1);

    for (const scope of [
      ["--project", "p1", "--project", "p2"],
      ["--workspace", "w1", "--workspace", "w2", "--project", "p1"],
      ["--workspace", "w1", "--project", "p1", "--project", "p2"],
    ]) {
      const other = io();
      expect(await runAinectoCli(["notifications", "poll", "--env", "dev", "--cursor-file", cursor, ...scope], other)).toBe(1);
      expect(other.err()).toContain("different filter");
    }
    expect(calls).toHaveLength(1);

    replies.push(tool({ items: [], stream: "s" }));
    expect(await runAinectoCli(["notifications", "ack", "--env", "dev", "--cursor-file", cursor], io())).toBe(0);
    expect(calls[1]?.arguments).toEqual({ cursor: "saved", ack: "a1", workspaceUuids: ["w1", "w2"], projectUuids: ["p1", "p2"], limit: 1 });
  });

  it("a 0.7.0 cursor file with a single projectUuid still matches --project and acks with it", async () => {
    const cursor = join(cwd, "legacy.cursor");
    writeFileSync(cursor, JSON.stringify({ v: 1, filter: { projectUuid: "p1", directOnly: false }, stream: "s", ackToken: "a1", pendingItems: [{ id: "n1" }] }));
    expect(await runAinectoCli(["notifications", "poll", "--env", "dev", "--cursor-file", cursor, "--project", "p1"], io())).toBe(0);
    expect(calls).toHaveLength(0);
    replies.push(tool({ items: [], stream: "s" }));
    expect(await runAinectoCli(["notifications", "ack", "--env", "dev", "--cursor-file", cursor], io())).toBe(0);
    expect(calls[0]?.arguments).toEqual({ cursor: "saved", ack: "a1", projectUuid: "p1", limit: 1 });
  });

  it("a tool error exits 1 with the server's reason", async () => {
    replies.push({ isError: true, content: [{ type: "text", text: "CURSOR_STREAM_MISMATCH: different filter" }] });
    const out = io();
    expect(await runAinectoCli(["notifications", "poll", "--env", "dev", "--cursor-file", join(cwd, "c")], out)).toBe(1);
    expect(out.err()).toContain("CURSOR_STREAM_MISMATCH");
  });
});

function tool(value: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function io() {
  let stdout = "";
  let stderr = "";
  const stdin = new PassThrough();
  stdin.end("");
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: { write: (chunk: string) => { stdout += chunk; return true; } } as NodeJS.WriteStream,
    stderr: { write: (chunk: string) => { stderr += chunk; return true; } } as NodeJS.WriteStream,
    out: () => stdout,
    err: () => stderr,
  };
}
