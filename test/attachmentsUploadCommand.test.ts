import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAinectoCli } from "../src/adapters/cli/ainectoCli";

describe("attachments upload command", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AINECTO_TOKEN;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("uploads a local file through token, PUT, and registration calls", async () => {
    const filePath = createTempFile("notes.txt", "hello");
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        calls.push({
          kind: "put",
          headers: init.headers,
          body: init.body,
        });
        return new Response(JSON.stringify({
          storageKey: "server-storage-key",
          sizeBytes: 5,
          contentType: "text/plain",
        }));
      }

      const body = parseJsonRpcBody(init);
      calls.push(body);
      if (body.params.name === "mcp__ainecto__request_upload_token") {
        return jsonRpcResult(body.id, toolContent({
          token: "upload-token-redacted",
          uploadUrl: "https://uploads.example.test/put",
          storageKey: "server-storage-key",
        }));
      }
      if (body.params.name === "mcp__ainecto__upload_attachments") {
        return jsonRpcResult(body.id, {
          uploaded: [{ uuid: "att-1", filename: "notes.txt" }],
          count: 1,
        });
      }
      throw new Error(`Unexpected tool call ${body.params.name}`);
    }));
    process.env.AINECTO_TOKEN = "mcp-token-redacted";
    const io = createIo();

    await expect(runAinectoCli([
      "attachments",
      "upload",
      "--env",
      "dev",
      "--document-uuid",
      "doc-1",
      filePath,
      "--json",
    ], io)).resolves.toBe(0);

    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      method: "tools/call",
      params: {
        name: "mcp__ainecto__request_upload_token",
        arguments: {
          purpose: "attachment.upload",
        },
      },
    });
    expect(JSON.parse(String((calls[0] as JsonRpcCall).params.arguments.scopeJson))).toEqual({
      documentUuid: "doc-1",
      filename: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 5,
    });
    expect(calls[1]).toMatchObject({
      kind: "put",
      headers: {
        authorization: "Bearer upload-token-redacted",
        "content-type": "text/plain",
      },
    });
    expect(calls[2]).toMatchObject({
      params: {
        name: "mcp__ainecto__upload_attachments",
        arguments: {
          items: [{
            documentUuid: "doc-1",
            filename: "notes.txt",
            storageKey: "server-storage-key",
            contentType: "text/plain",
            sizeBytes: 5,
          }],
        },
      },
    });
    expect(io.stderrText()).toBe("");
    const output = JSON.parse(io.stdoutText());
    expect(output).toMatchObject({ ok: true, data: { count: 1 } });
    expect(io.stdoutText()).not.toContain("upload-token-redacted");
    expect(io.stdoutText()).not.toContain("https://uploads.example.test/put");
  });

  it("rejects missing document uuid before network calls", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli(["attachments", "upload", "--env", "dev", "./notes.txt", "--json"], io)).resolves.toBe(1);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(io.stderrText())).toMatchObject({
      ok: false,
      error: {
        code: "MISSING_REQUIRED_FLAG",
      },
    });
  });

  it("rejects filename override with multiple files", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli([
      "attachments",
      "upload",
      "--env",
      "dev",
      "--document-uuid",
      "doc-1",
      "--name",
      "single.txt",
      "./a.txt",
      "./b.txt",
      "--json",
    ], io)).resolves.toBe(1);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(io.stderrText())).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_FLAG_VALUE",
      },
    });
  });

  it("fails before PUT when the token response omits storageKey", async () => {
    const filePath = createTempFile("notes.txt", "hello");
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        calls.push({ kind: "put" });
        return new Response("{}");
      }
      const body = parseJsonRpcBody(init);
      calls.push(body);
      return jsonRpcResult(body.id, {
        token: "upload-token-redacted",
        uploadUrl: "https://uploads.example.test/put",
      });
    }));
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli([
      "attachments",
      "upload",
      "--env",
      "dev",
      "--document-uuid",
      "doc-1",
      filePath,
      "--json",
    ], io)).resolves.toBe(1);

    expect(calls).toHaveLength(1);
    expect(JSON.parse(io.stderrText())).toMatchObject({
      ok: false,
      error: {
        code: "UPLOAD_TOKEN_PROTOCOL_ERROR",
      },
    });
  });

  it("retries retryable PUT failures before registering the attachment", async () => {
    const filePath = createTempFile("notes.txt", "hello");
    let putAttempts = 0;
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putAttempts += 1;
        calls.push({ kind: "put", attempt: putAttempts });
        if (putAttempts === 1) {
          return new Response(JSON.stringify({ message: "try again" }), { status: 500 });
        }
        return new Response(JSON.stringify({
          storageKey: "server-storage-key",
          sizeBytes: 5,
          contentType: "text/plain",
        }));
      }

      const body = parseJsonRpcBody(init);
      calls.push(body);
      if (body.params.name === "mcp__ainecto__request_upload_token") {
        return jsonRpcResult(body.id, {
          token: "upload-token-redacted",
          uploadUrl: "https://uploads.example.test/put",
          storageKey: "server-storage-key",
        });
      }
      return jsonRpcResult(body.id, { uploaded: [], count: 1 });
    }));
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli([
      "attachments",
      "upload",
      "--env",
      "dev",
      "--document-uuid",
      "doc-1",
      filePath,
      "--json",
    ], io)).resolves.toBe(0);

    expect(putAttempts).toBe(2);
    expect((calls[3] as JsonRpcCall).params.name).toBe("mcp__ainecto__upload_attachments");
  });

  it("wraps repeated PUT network failures in an upload-specific error", async () => {
    const filePath = createTempFile("notes.txt", "hello");
    let putAttempts = 0;
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putAttempts += 1;
        throw new Error("network down");
      }

      const body = parseJsonRpcBody(init);
      calls.push(body);
      return jsonRpcResult(body.id, {
        token: "upload-token-redacted",
        uploadUrl: "https://uploads.example.test/put",
        storageKey: "server-storage-key",
      });
    }));
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli([
      "attachments",
      "upload",
      "--env",
      "dev",
      "--document-uuid",
      "doc-1",
      filePath,
      "--json",
    ], io)).resolves.toBe(1);

    expect(putAttempts).toBe(3);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(io.stderrText())).toMatchObject({
      ok: false,
      error: {
        code: "ATTACHMENT_UPLOAD_FAILED",
        details: {
          cause: "network down",
        },
      },
    });
  });

  it("writes progress to stderr in human mode", async () => {
    const filePath = createTempFile("notes.txt", "hello");
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({
          storageKey: "server-storage-key",
          sizeBytes: 5,
          contentType: "text/plain",
        }));
      }

      const body = parseJsonRpcBody(init);
      if (body.params.name === "mcp__ainecto__request_upload_token") {
        return jsonRpcResult(body.id, {
          token: "upload-token-redacted",
          uploadUrl: "https://uploads.example.test/put",
          storageKey: "server-storage-key",
        });
      }
      return jsonRpcResult(body.id, { uploaded: [], count: 1 });
    }));
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli([
      "attachments",
      "upload",
      "--env",
      "dev",
      "--document-uuid",
      "doc-1",
      filePath,
    ], io)).resolves.toBe(0);

    expect(io.stderrText()).toContain("Uploading notes.txt (1/1)");
    expect(io.stdoutText()).toContain("Uploaded 1 attachment.");
  });

  it("maps PUT size mismatch to a structured upload error", async () => {
    const filePath = createTempFile("notes.txt", "hello");
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({
          storageKey: "server-storage-key",
          sizeBytes: 6,
          contentType: "text/plain",
        }));
      }

      const body = parseJsonRpcBody(init);
      return jsonRpcResult(body.id, {
        token: "upload-token-redacted",
        uploadUrl: "https://uploads.example.test/put",
        storageKey: "server-storage-key",
      });
    }));
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli([
      "attachments",
      "upload",
      "--env",
      "dev",
      "--document-uuid",
      "doc-1",
      filePath,
      "--json",
    ], io)).resolves.toBe(1);

    expect(JSON.parse(io.stderrText())).toMatchObject({
      ok: false,
      error: {
        code: "ATTACHMENT_UPLOAD_SIZE_MISMATCH",
      },
    });
  });

  it("maps PUT conflict to a structured upload error", async () => {
    const filePath = createTempFile("notes.txt", "hello");
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({ message: "exists" }), { status: 409 });
      }

      const body = parseJsonRpcBody(init);
      return jsonRpcResult(body.id, {
        token: "upload-token-redacted",
        uploadUrl: "https://uploads.example.test/put",
        storageKey: "server-storage-key",
      });
    }));
    process.env.AINECTO_TOKEN = "redacted";
    const io = createIo();

    await expect(runAinectoCli([
      "attachments",
      "upload",
      "--env",
      "dev",
      "--document-uuid",
      "doc-1",
      filePath,
      "--json",
    ], io)).resolves.toBe(1);

    expect(JSON.parse(io.stderrText())).toMatchObject({
      ok: false,
      error: {
        code: "ATTACHMENT_UPLOAD_CONFLICT",
      },
    });
  });

  function createTempFile(name: string, content: string): string {
    tempDir ??= mkdtempSync(join(tmpdir(), "ainecto-attachments-test-"));
    const path = join(tempDir, name);
    writeFileSync(path, content);
    return path;
  }
});

interface JsonRpcCall {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

function parseJsonRpcBody(init: RequestInit | undefined): JsonRpcCall {
  return JSON.parse(String(init?.body)) as JsonRpcCall;
}

function jsonRpcResult(id: string | number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function toolContent(value: unknown): unknown {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(value),
    }],
  };
}

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
