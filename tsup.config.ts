import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "bin/mcp": "src/bin/mcp.ts",
    "bin/ainecto": "src/bin/ainecto.ts",
    "bin/agent-host": "src/bin/agent-host.ts",
  },
  format: ["esm"],
  target: "node18",
  platform: "node",
  sourcemap: true,
  clean: true,
  splitting: false,
  dts: false,
  // node-pty is a native optional dependency — never bundle it; require at runtime.
  external: ["node-pty"],
});
