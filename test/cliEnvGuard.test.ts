import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir as isolationTmpdir } from "node:os";
import { join as isolationJoin } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runAinectoCli } from "../src/adapters/cli/ainectoCli";
import { parseMcpArgs } from "../src/adapters/mcp/args";

describe("CLI env flag guards", () => {
  // ★저장소 역할 탐색(0.4.2)은 cwd 에서 위로 올라간다. 이 저장소의 조상 폴더에 사람의 설정이 있어도
  //   시험이 흔들리지 않게, 아무 설정도 없는 임시 폴더에서 돈다.
  let isolatedCwd: string;
  let previousCwd: string;
  beforeEach(() => {
    previousCwd = process.cwd();
    isolatedCwd = mkdtempSync(isolationJoin(isolationTmpdir(), "ai-erd-cwd-"));
    process.chdir(isolatedCwd);
  });
  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(isolatedCwd, { recursive: true, force: true });
  });

  it("rejects ainecto --env without a value before resolving the default prod endpoint", async () => {
    const io = createIo();

    await expect(runAinectoCli(["tools", "list", "--env"], io)).resolves.toBe(1);
    expect(io.stderrText()).toContain("--env requires a value.");
    expect(io.stdoutText()).toBe("");
  });

  it("rejects mcp --env without a value", () => {
    expect(() => parseMcpArgs(["--env"])).toThrow("--env requires a value.");
  });

  it("marks prod tools catalog output as a checked-in snapshot of prod tools/list", async () => {
    const io = createIo();

    await expect(runAinectoCli(["tools", "catalog", "--json"], io)).resolves.toBe(0);
    const output = JSON.parse(io.stdoutText()) as { warnings?: string[] };
    expect(output.warnings?.join("\n")).toContain("prod catalog is a checked-in snapshot of that server's tools/list");
    expect(output.warnings?.join("\n")).not.toContain("seed fixture");
  });

  it("marks dev tools catalog output as a live sync snapshot", async () => {
    const io = createIo();

    await expect(runAinectoCli(["tools", "catalog", "--env", "dev", "--json"], io)).resolves.toBe(0);
    const output = JSON.parse(io.stdoutText()) as { data?: unknown[]; warnings?: string[] };
    expect(output.data?.length).toBeGreaterThan(1);
    expect(output.warnings?.join("\n")).toContain("dev catalog is a checked-in snapshot of that server's tools/list");
  });
});

function createIo() {
  let stdout = "";
  let stderr = "";
  const stdin = new PassThrough();
  stdin.end();
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
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
