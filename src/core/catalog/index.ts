import { generatedTools as prodTools } from "./generated.prod";
import { generatedTools as devTools } from "./generated.dev";
import type { AinectoEnv } from "../config/endpoints";

export function getGeneratedTools(env: AinectoEnv) {
  return env === "dev" ? devTools : prodTools;
}
