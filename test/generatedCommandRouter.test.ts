import { stubOperationFetch } from "./support/operationServer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir as isolationTmpdir } from "node:os";
import { join as isolationJoin } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { runAinectoCli } from "../src/adapters/cli/ainectoCli";
import { assertNoCommandCollisions, matchGeneratedCommand } from "../src/adapters/cli/generatedCommandRouter";
import { generatedTools as devTools } from "../src/core/catalog/generated.dev";

describe("generated command router", () => {
  // ★저장소 역할 탐색(0.4.2)은 cwd 에서 위로 올라간다. 이 저장소의 조상 폴더에 사람의 설정이 있어도
  //   시험이 흔들리지 않게, 아무 설정도 없는 임시 폴더에서 돈다.
  let isolatedCwd: string;
  let previousCwd: string;
  beforeEach(() => {
    previousCwd = process.cwd();
    isolatedCwd = mkdtempSync(isolationJoin(isolationTmpdir(), "ainecto-cwd-"));
    process.chdir(isolatedCwd);
  });
  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(isolatedCwd, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AINECTO_TOKEN;
  });

  it("keeps all dev catalog command paths reachable without alias or bespoke collisions", () => {
    expect(() => assertNoCommandCollisions("dev")).not.toThrow();
    for (const tool of devTools) {
      expect(matchGeneratedCommand(devTools, tool.commandPath)?.tool.mcpName).toBe(tool.mcpName);
    }
  });

  it("executes scalar flags with kebab-case and schema-case aliases", async () => {
    const calls: unknown[] = [];
    stubOperationFetch(vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { cards: [] } }));
    }));
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli([
      "kanban",
      "list-cards",
      "--env",
      "dev",
      "--board-uuid",
      "board-1",
      "--projectUuid",
      "project-1",
      "--include-done",
      "false",
      "--limit",
      "2",
      "--json",
    ], io)).resolves.toBe(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "tools/call",
      params: {
        name: "kanban_list_cards",
        arguments: {
          boardUuid: "board-1",
          projectUuid: "project-1",
          includeDone: false,
          limit: 2,
        },
      },
    });
    expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: true });
  });

  it("fails generated commands with missing required scalar flags", async () => {
    const io = createIo();

    await expect(runAinectoCli(["kanban", "card-action", "--env", "dev", "--json"], io)).resolves.toBe(1);
    expect(JSON.parse(io.stderrText())).toMatchObject({
      ok: false,
      error: {
        code: "MISSING_REQUIRED_FLAG",
      },
    });
  });

  it("rejects bare string flags before server calls", async () => {
    const fetchImpl = vi.fn();
    stubOperationFetch(fetchImpl);
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli(["kanban", "card-action", "--env", "dev", "--card-uuid", "--json"], io)).resolves.toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(io.stderrText())).toMatchObject({
      ok: false,
      error: {
        code: "FLAG_REQUIRES_VALUE",
      },
    });
  });

  it("rejects array/object schema fields as scalar flags", async () => {
    const fetchImpl = vi.fn();
    stubOperationFetch(fetchImpl);
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli(["attachments", "delete", "--env", "dev", "--uuids", "att-1", "--yes", "--json"], io)).resolves.toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(io.stderrText())).toMatchObject({
      ok: false,
      error: {
        code: "UNSUPPORTED_FLAG_PAYLOAD",
      },
    });
  });

  it("requires --yes for destructive commands in json mode", async () => {
    const io = createIo();

    await expect(runAinectoCli(["documents", "delete", "--env", "dev", "-f", "-", "--json"], {
      ...io,
      stdin: streamWith("{\"uuids\":[\"doc-1\"]}"),
    })).resolves.toBe(1);

    expect(JSON.parse(io.stderrText())).toMatchObject({
      ok: false,
      error: {
        code: "CONFIRMATION_REQUIRED",
      },
    });
  });

  it("prompts destructive human commands unless --yes is supplied", async () => {
    const calls: unknown[] = [];
    stubOperationFetch(vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { deleted: 1 } }));
    }));
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo("yes\n");

    await expect(runAinectoCli(["documents", "delete", "--env", "dev", "{\"uuids\":[\"doc-1\"]}"], io)).resolves.toBe(0);
    expect(io.stderrText()).toContain("Run destructive command documents delete?");
    expect(calls[0]).toMatchObject({
      params: {
        name: "delete_documents",
        arguments: { uuids: ["doc-1"] },
      },
    });
  });

  it("keeps binary-upload generated commands on raw MCP argument contract only", async () => {
    const calls: unknown[] = [];
    stubOperationFetch(vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { uploadUrl: "redacted", storageKey: "key" } }));
    }));
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli(["tools", "run", "request-upload-token", "--env", "dev", "--purpose", "mcp.call", "--json"], io)).resolves.toBe(0);

    expect(calls[0]).toMatchObject({
      params: {
        name: "request_upload_token",
        arguments: { purpose: "mcp.call" },
      },
    });
    expect(JSON.parse(io.stdoutText()).warnings.join("\n")).toContain("raw MCP argument contract only");
  });

  it("routes a command the snapshot lacks through the server's live operation list (search) — no CLI release per new operation", async () => {
    const calls: Array<{ method: string; params?: { name?: string; arguments?: Record<string, unknown> } }> = [];
    const search = { name: "search", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {
      action: { type: "array", items: { type: "string", enum: ["read", "create"] } },
      object: { type: "array", items: { type: "string", enum: ["document"] } },
    } } };
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
      const args = body.params?.arguments ?? {};
      const result = body.method === "tools/list" ? { tools: [search] }
        : body.params.name === "search" && args.operation
          ? text({ operation: "html_render_preview", summary: "preview", executor: "execute_read", annotations: { readOnlyHint: true },
            inputSchema: { type: "object", properties: { uuid: { type: "string" } } } })
          : body.params.name === "search"
            ? text({ items: [{ operation: "html_render_preview", summary: "preview", rank: 1 }] })
            : text({ ok: true });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    }));
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli(["tools", "run", "html-render-preview", "--env", "dev", "--uuid", "d-1", "--json"], io)).resolves.toBe(0);
    expect(calls.map((call) => call.params?.name ?? call.method)).toEqual(["tools/list", "search", "search", "execute_read"]);
    expect(calls[1]).toMatchObject({ params: { arguments: { action: ["read", "create"], object: ["document"], limit: 50 } } });
    expect(calls[2]).toMatchObject({ params: { arguments: { operation: "html_render_preview" } } });
    expect(calls[3]).toMatchObject({ params: { arguments: { operation: "html_render_preview", args: { uuid: "d-1" } } } });
  });

  it("still answers «Unknown command» when neither the snapshot nor the live list has it", async () => {
    stubOperationFetch(vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }));
    }));
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli(["no-such", "thing", "--env", "dev"], io)).resolves.toBe(1);
    expect(io.stderrText()).toContain('Unknown command "no-such"');
  });

  it("leaves bespoke attachments upload outside generated routing", () => {
    expect(matchGeneratedCommand(devTools, ["attachments", "upload"])).toBeUndefined();
  });

  it("renders enriched table output for human mode", async () => {
    stubOperationFetch(vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { projects: [{ uuid: "p1", name: "Project 1", projectKey: "P1" }] },
      }));
    }));
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli(["projects", "list", "--env", "dev"], io)).resolves.toBe(0);
    expect(io.stdoutText()).toContain("uuid");
    expect(io.stdoutText()).toContain("Project 1");
  });
});

function createIo(stdinText = "") {
  let stdout = "";
  let stderr = "";
  return {
    stdin: streamWith(stdinText),
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

function streamWith(text: string): NodeJS.ReadStream {
  const stream = new PassThrough();
  stream.end(text);
  return stream as unknown as NodeJS.ReadStream;
}
