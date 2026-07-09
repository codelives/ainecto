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

  it("marks tools catalog output as seed fixture until live sync", async () => {
    const io = createIo();

    await expect(runAinectoCli(["tools", "catalog", "--json"], io)).resolves.toBe(0);
    const output = JSON.parse(io.stdoutText()) as { warnings?: string[] };
    expect(output.warnings?.join("\n")).toContain("seed fixture only until live sync");
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
