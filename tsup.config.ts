import { defineConfig } from "tsup";
import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

export default defineConfig({
  entry: {
    "bin/mcp": "src/bin/mcp.ts",
    "bin/ainecto": "src/bin/ainecto.ts",
  },
  format: ["esm"],
  target: "node18",
  platform: "node",
  sourcemap: true,
  clean: true,
  splitting: false,
  dts: false,
  define: { __AI_ERD_CLI_VERSION__: JSON.stringify(version) },
});
