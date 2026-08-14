import { chmod } from "node:fs/promises";
import { join } from "node:path";

await Promise.all([
  chmod(join(process.cwd(), "dist/bin/mcp.js"), 0o755),
  chmod(join(process.cwd(), "dist/bin/ainecto.js"), 0o755),
  chmod(join(process.cwd(), "dist/bin/agent-host.js"), 0o755),
]);
