import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeInitCommand } from "../src/adapters/cli/initCommand";
import { AGENT_ENV_MARKERS, createReadlinePrompter, isInteractive } from "../src/adapters/cli/prompter";
import type { McpRpcClient } from "../src/core/mcp/rpcClient";
import type { HarnessRole } from "../src/core/harness/role";

/**
 * 0.4.1 최소 대화형(설계 §21-4). 사람이 터미널에서 `ai-erd init` 만 치면 역할·프로젝트를 번호로 묻는다.
 * ★입력은 실제 readline 프롬프터에 «파이프»로 넣는다 — 여러 줄을 한 번에 넣어도 질문마다 한 줄씩 받는지,
 * 입력이 끝나면(EOF) 취소되는지까지 같이 본다.
 */
describe("ai-erd init — interactive (TTY)", () => {
  let root: string;
  const out: string[] = [];
  const said: string[] = [];

  const io = {
    stdout: { write: (text: string) => { out.push(text); return true; } },
    stderr: { write: (text: string) => { said.push(text); return true; } },
  } as unknown as { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream };

  function server(projects: Array<{ uuid: string; name: string }>) {
    const calls: Array<{ name: string; args: unknown }> = [];
    const stub = {
      toolsCall: async (name: string, args: unknown) => {
        calls.push({ name, args });
        const payload = name === "create_projects"
          ? { created: [{ uuid: "p-new", name: (args as { items: Array<{ name: string }> }).items[0]!.name }] }
          : { projects };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      },
    } as unknown as McpRpcClient;
    return { stub, calls };
  }

  /** 사람이 칠 줄들. 끝나면 입력이 닫힌다(EOF). */
  function typed(...lines: string[]) {
    const stdin = new PassThrough();
    stdin.end(lines.map((line) => `${line}\n`).join(""));
    return createReadlinePrompter({ stdin, stderr: io.stderr });
  }

  function run(lines: string[], projects: Array<{ uuid: string; name: string }>, extra: { role?: HarnessRole; argv?: string[] } = {}) {
    const { stub, calls } = server(projects);
    const connectedAs: string[] = [];
    const result = executeInitCommand({
      argv: extra.argv ?? [],
      role: extra.role,
      connect: (role) => {
        connectedAs.push(role);
        return { client: stub };
      },
      prompter: typed(...lines),
      endpoint: "https://ai-erd.com/mcp",
      // 하네스 문서는 받지 않는다(패키지 기본값으로 간다) — 시험이 네트워크에 닿지 않게.
      fetchImpl: (async () => { throw new Error("offline in tests"); }) as unknown as typeof fetch,
      env: "prod",
      cliVersion: "@ai-erd/mcp test",
      cwd: root,
      json: true,
      io,
    });
    return { result, calls, connectedAs };
  }

  async function roleInMcpJson(): Promise<string> {
    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    const args = mcp.mcpServers["ai-erd"].args as string[];
    return args[args.indexOf("--role") + 1]!;
  }

  async function boundProject(): Promise<string> {
    return JSON.parse(await readFile(join(root, ".ai-erd/config.json"), "utf8")).project.uuid;
  }

  const prompts = () => said.join("");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ai-erd-tty-"));
    out.length = 0;
    said.length = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("asks for the role, then connects as that role (never before)", async () => {
    const { result, connectedAs } = run(["2", ""], [{ uuid: "p-1", name: "Billing" }]);

    expect(await result).toBe(0);
    expect(connectedAs).toEqual(["development"]);
    expect(await roleInMcpJson()).toBe("development");
    expect(prompts()).toContain("Which role should AI sessions in this repository have?");
    expect(prompts()).toContain("[4] Validation");
  });

  it("★has no default role — an empty answer asks again", async () => {
    const { result } = run(["", "1", ""], [{ uuid: "p-1", name: "Billing" }]);

    expect(await result).toBe(0);
    expect(prompts()).toContain("there is no default here");
    expect(prompts()).toContain("Enter a number (1-4): ");      // 역할 질문에 [기본값] 표시가 없다
    expect(await roleInMcpJson()).toBe("design");
  });

  it("asks again on a number that is not listed, or on something that is not a number", async () => {
    const { result } = run(["9", "two", "3", ""], [{ uuid: "p-1", name: "Billing" }]);

    expect(await result).toBe(0);
    expect(prompts()).toContain('"9" is not one of the numbers above.');
    expect(prompts()).toContain('"two" is not one of the numbers above.');
    expect(await roleInMcpJson()).toBe("test");
  });

  it("lets the user pick the project by number", async () => {
    const { result, calls } = run(["2", "2"], [{ uuid: "p-1", name: "Billing" }, { uuid: "p-2", name: "Payments" }]);

    expect(await result).toBe(0);
    expect(await boundProject()).toBe("p-2");
    expect(calls.map((call) => call.name)).toEqual(["list_projects"]);
    // 둘 중 무엇도 기본값이 아니다.
    expect(prompts()).toContain("Enter a number (1-2): ");
  });

  it("★offers «Create a new project» to Design, asks the name, and creates it", async () => {
    const { result, calls } = run(["1", "2", "Checkout"], [{ uuid: "p-1", name: "Billing" }]);

    expect(await result).toBe(0);
    expect(prompts()).toContain("Create a new project");
    expect(calls.map((call) => call.name)).toEqual(["list_projects", "create_projects"]);
    expect(calls[1]!.args).toEqual({ items: [{ name: "Checkout" }] });
    expect(prompts()).toContain("Created project Checkout (p-new).");
    expect(await boundProject()).toBe("p-new");
  });

  it("★with no project at all, Design is asked for a name (the folder name by default) instead of --yes", async () => {
    const { result, calls } = run(["1", ""], []);

    expect(await result).toBe(0);
    expect(calls[1]!.args).toEqual({ items: [{ name: basename(root) }] });
  });

  it("★does not offer «Create a new project» outside Design", async () => {
    const { result } = run(["2", ""], [{ uuid: "p-1", name: "Billing" }]);

    expect(await result).toBe(0);
    expect(prompts()).not.toContain("Create a new project");
  });

  it("★outside Design, no project means the same stop as non-interactive — nothing is created", async () => {
    const { result, calls } = run(["2"], []);

    await expect(result).rejects.toThrow(/only a Design session can create one[\s\S]*--role development\./);
    expect(calls.map((call) => call.name)).toEqual(["list_projects"]);
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  });

  it("★input ends mid-question (Ctrl+D) → 130, nothing written, no connection", async () => {
    const { result, calls, connectedAs } = run([], [{ uuid: "p-1", name: "Billing" }]);

    expect(await result).toBe(130);
    expect(prompts()).toContain("Cancelled — nothing was written.");
    expect(connectedAs).toEqual([]);
    expect(calls).toEqual([]);
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
    expect(existsSync(join(root, ".ai-erd"))).toBe(false);
  });

  it("★cancelling at the project question writes nothing either", async () => {
    const { result, calls } = run(["1"], [{ uuid: "p-1", name: "Billing" }, { uuid: "p-2", name: "Payments" }]);

    expect(await result).toBe(130);
    expect(calls.map((call) => call.name)).toEqual(["list_projects"]);
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  });

  it("a role already set on the repository is the default — Enter keeps it", async () => {
    await run(["3", ""], [{ uuid: "p-1", name: "Billing" }]).result;
    said.length = 0;

    const { result } = run(["", ""], [{ uuid: "p-1", name: "Billing" }]);

    expect(await result).toBe(0);
    expect(prompts()).toContain("(now: test)");
    expect(prompts()).toContain("Enter a number (1-4) [3]: ");
    expect(await roleInMcpJson()).toBe("test");
  });

  it("--role and --project skip their questions", async () => {
    const { result } = run([], [{ uuid: "p-1", name: "Billing" }, { uuid: "p-2", name: "Payments" }], {
      role: "validation",
      argv: ["--project", "p-1"],
    });

    expect(await result).toBe(0);
    expect(prompts()).not.toContain("Which role");
    expect(prompts()).not.toContain("Which AI-ERD project");
    expect(await roleInMcpJson()).toBe("validation");
  });
});

describe("isInteractive — the only place that decides whether to ask", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };

  it("asks only when stdin and stdout are both terminals and --json is off", () => {
    expect(isInteractive({ stdin: tty, stdout: tty }, false, {})).toBe(true);
    expect(isInteractive({ stdin: tty, stdout: tty }, true, {})).toBe(false);
    expect(isInteractive({ stdin: pipe, stdout: tty }, false, {})).toBe(false);
    expect(isInteractive({ stdin: tty, stdout: pipe }, false, {})).toBe(false);
    expect(isInteractive({ stdin: {}, stdout: {} }, false, {})).toBe(false);   // 에이전트 셸 도구: isTTY 없음
  });

  it("★does not ask under an agent or CI even on a terminal (pty) — the agent could answer for the user", () => {
    for (const name of AGENT_ENV_MARKERS) {
      expect(isInteractive({ stdin: tty, stdout: tty }, false, { [name]: "1" })).toBe(false);
    }
    expect(AGENT_ENV_MARKERS).toEqual(["CLAUDECODE", "CI", "GEMINI_CLI", "CODEX_SANDBOX", "CURSOR_AGENT"]);
    expect(isInteractive({ stdin: tty, stdout: tty }, false, { CODEX_SANDBOX: "seatbelt" })).toBe(false);
    // 꺼 둔 표지는 없는 것이다.
    expect(isInteractive({ stdin: tty, stdout: tty }, false, { CI: "false", CLAUDECODE: "0", GEMINI_CLI: "" })).toBe(true);
  });
});
