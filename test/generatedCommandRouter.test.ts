import { PassThrough } from "node:stream";
import { describe, expect, it, vi, afterEach } from "vitest";
import { runAinectoCli } from "../src/adapters/cli/ainectoCli";
import { assertNoCommandCollisions, matchGeneratedCommand } from "../src/adapters/cli/generatedCommandRouter";
import { generatedTools as devTools } from "../src/core/catalog/generated.dev";

describe("generated command router", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AINECTO_TOKEN;
  });

  it("keeps all dev catalog command paths reachable without alias or bespoke collisions", () => {
    expect(() => assertNoCommandCollisions("dev")).not.toThrow();
    for (const tool of devTools) {
      expect(matchGeneratedCommand("dev", tool.commandPath)?.tool.mcpName).toBe(tool.mcpName);
    }
  });

  it("executes scalar flags with kebab-case and schema-case aliases", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tasks: [] } }));
    }));
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli([
      "task",
      "list-tasks",
      "--env",
      "dev",
      "--document-uuid",
      "doc-1",
      "--statusUuid",
      "status-1",
      "--include-archived",
      "false",
      "--limit",
      "2",
      "--json",
    ], io)).resolves.toBe(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "tools/call",
      params: {
        name: "mcp__ainecto__task_list_tasks",
        arguments: {
          documentUuid: "doc-1",
          statusUuid: "status-1",
          includeArchived: false,
          limit: 2,
        },
      },
    });
    expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: true });
  });

  it("fails generated commands with missing required scalar flags", async () => {
    const io = createIo();

    await expect(runAinectoCli(["task", "list-tasks", "--env", "dev", "--json"], io)).resolves.toBe(1);
    expect(JSON.parse(io.stderrText())).toMatchObject({
      ok: false,
      error: {
        code: "MISSING_REQUIRED_FLAG",
      },
    });
  });

  it("rejects bare string flags before server calls", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli(["task", "list-tasks", "--env", "dev", "--document-uuid", "--json"], io)).resolves.toBe(1);
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
    vi.stubGlobal("fetch", fetchImpl);
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
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
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
        name: "mcp__ainecto__delete_documents",
        arguments: { uuids: ["doc-1"] },
      },
    });
  });

  it("keeps binary-upload generated commands on raw MCP argument contract only", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { uploadUrl: "redacted", storageKey: "key" } }));
    }));
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli(["tools", "run", "request-upload-token", "--env", "dev", "--purpose", "mcp.call", "--json"], io)).resolves.toBe(0);

    expect(calls[0]).toMatchObject({
      params: {
        name: "mcp__ainecto__request_upload_token",
        arguments: { purpose: "mcp.call" },
      },
    });
    expect(JSON.parse(io.stdoutText()).warnings.join("\n")).toContain("raw MCP argument contract only");
  });

  it("does not implement the bespoke attachments upload command before contract confirmation", async () => {
    const io = createIo();

    await expect(runAinectoCli(["attachments", "upload", "--env", "dev", "./file.png", "--json"], io)).resolves.toBe(1);
    expect(JSON.parse(io.stderrText())).toMatchObject({
      ok: false,
      error: {
        code: "COMMAND_NOT_IMPLEMENTED",
      },
    });
  });

  it("renders enriched table output for human mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
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
