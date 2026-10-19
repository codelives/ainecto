import { assertEnv, type AinectoEnv } from "../../core/config/endpoints";

export interface McpBinArgs {
  env?: AinectoEnv;
  endpoint?: string;
  /**
   * 옛 {@code --role} 값 — ★검사하지 않는다(legacyRole.ts). 0.7.x 가 쓴 저장소 설정이 이 판을 띄우므로
   * 여기서 멈추면 그 연결이 전부 끊긴다. 값 없이 끝난 {@code --role} 도 멈추지 않고 «없음»으로 둔다.
   */
  legacyRole?: string;
  help: boolean;
}

export function parseMcpArgs(argv: string[]): McpBinArgs {
  const result: McpBinArgs = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--env") {
      result.env = assertEnv(requireFlagValue(arg, argv[++index]));
    } else if (arg === "--endpoint") {
      result.endpoint = requireFlagValue(arg, argv[++index]);
    } else if (arg === "--role") {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith("--")) {
        result.legacyRole = value;
        index += 1;
      }
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function requireFlagValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}
