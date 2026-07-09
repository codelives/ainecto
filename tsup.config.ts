import { defineConfig } from "tsup";

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
});
