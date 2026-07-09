import { assertEnv, type AinectoEnv } from "../../core/config/endpoints";

export interface McpBinArgs {
  env?: AinectoEnv;
  endpoint?: string;
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
