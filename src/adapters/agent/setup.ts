/*
 * AiNecto Agent — onboarding orchestrator.
 *
 * Bundles the setup steps into one command:
 *   1) verify Claude Code is installed
 *   2) connect the Ainecto MCP (claude mcp add)
 *   3) register the Chrome native-messaging manifest
 *   4) login guidance
 * Best-effort: a failed step never blocks the next one.
 */
import { execSync } from "node:child_process";
import { resolveEndpoint, type AinectoEnv } from "../../core/config/endpoints";
import { runRegister } from "./register";

interface IO {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

function has(bin: string): boolean {
  try {
    execSync(process.platform === "win32" ? `where ${bin}` : `command -v ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function runSetup(io: IO, env: AinectoEnv = "prod"): number {
  const endpoint = resolveEndpoint({ env }).endpoint;
  const step = (n: number, msg: string) => io.stdout.write(`\n[${n}] ${msg}\n`);

  // 1) Claude Code
  step(1, "Checking Claude Code");
  if (has("claude")) {
    io.stdout.write("  ✓ claude found\n");
  } else {
    io.stdout.write("  ✗ claude not found → install:  npm i -g @anthropic-ai/claude-code\n");
  }

  // 2) MCP connection
  step(2, `Connecting MCP (ainecto → ${endpoint})`);
  if (has("claude")) {
    try {
      execSync(`claude mcp add --transport http ainecto ${endpoint}`, { stdio: "inherit" });
      io.stdout.write("  ✓ mcp add done\n");
    } catch {
      io.stdout.write("  · already registered or failed — skipped\n");
    }
  } else {
    io.stdout.write("  · claude missing — skipped (run `ainecto setup` again after install)\n");
  }

  // 3) native-messaging manifest
  step(3, "Registering Chrome native-messaging manifest");
  runRegister([], io);

  // 4) login guidance
  step(4, "Login");
  io.stdout.write("  Complete the Claude login on first run.\n");
  io.stdout.write('\nDone! Click "Run agent" in the browser to open a local terminal.\n');
  return 0;
}
