import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runAinectoCli } from "../src/adapters/cli/ainectoCli";
import { parseMcpArgs } from "../src/adapters/mcp/args";

describe("CLI env flag guards", () => {
  it("rejects ainecto --env without a value before resolving the default prod endpoint", async () => {
    const io = createIo();

    await expect(runAinectoCli(["tools", "list", "--env"], io)).resolves.toBe(1);
    expect(io.stderrText()).toContain("--env requires a value.");
    expect(io.stdoutText()).toBe("");
  });

  it("rejects mcp --env without a value", () => {
    expect(() => parseMcpArgs(["--env"])).toThrow("--env requires a value.");
  });

  it("marks prod tools catalog output as seed fixture until prod live sync", async () => {
    const io = createIo();

    await expect(runAinectoCli(["tools", "catalog", "--json"], io)).resolves.toBe(0);
    const output = JSON.parse(io.stdoutText()) as { warnings?: string[] };
    expect(output.warnings?.join("\n")).toContain("prod catalog is seed fixture only");
  });

  it("marks dev tools catalog output as a live sync snapshot", async () => {
    const io = createIo();

    await expect(runAinectoCli(["tools", "catalog", "--env", "dev", "--json"], io)).resolves.toBe(0);
    const output = JSON.parse(io.stdoutText()) as { data?: unknown[]; warnings?: string[] };
    expect(output.data?.length).toBeGreaterThan(1);
    expect(output.warnings?.join("\n")).toContain("dev catalog is a checked-in live sync snapshot");
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
