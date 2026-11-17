import { createInterface } from "node:readline";
import type { GeneratedToolDefinition } from "../../core/catalog/types";
import { CliCommandError } from "./errors";

export interface ConfirmationIO {
  stdin: NodeJS.ReadStream;
  stderr: NodeJS.WriteStream;
}

export async function confirmDestructiveCommand(options: {
  tool: GeneratedToolDefinition;
  yes: boolean;
  json: boolean;
  io: ConfirmationIO;
}): Promise<void> {
  if (!options.tool.destructive) {
    return;
  }
  if (options.yes) {
    return;
  }
  if (options.json) {
    throw new CliCommandError("CONFIRMATION_REQUIRED", `Destructive command ${options.tool.commandPath.join(" ")} requires --yes in --json mode.`, {
      mcpName: options.tool.mcpName,
    });
  }

  const answer = await promptLine(options.io, `Run destructive command ${options.tool.commandPath.join(" ")}? Type "yes" to continue: `);
  if (answer.trim().toLowerCase() !== "yes") {
    throw new CliCommandError("CONFIRMATION_DECLINED", "Destructive command was not confirmed.", {
      mcpName: options.tool.mcpName,
    });
  }
}

/** 한 줄 묻고 한 줄 받는다(stderr 에 묻는다 — stdout 은 결과 전용). 입력이 끝났으면 빈 줄. */
export async function promptLine(io: ConfirmationIO, message: string): Promise<string> {
  io.stderr.write(message);
  const rl = createInterface({ input: io.stdin, terminal: false });
  try {
    for await (const line of rl) {
      return line;
    }
    return "";
  } finally {
    rl.close();
  }
}
