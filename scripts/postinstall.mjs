// Runs on `npm install`. Registers the Chrome native-messaging manifest when a
// built dist is present (i.e. installed as a package). In a source checkout the
// dist is absent → no-op, so `npm install` in this repo never fails here.
// `register` itself skips without failing when no extension id is available.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const bin = join(process.cwd(), "dist/bin/ainecto.js");
if (existsSync(bin)) {
  spawnSync(process.execPath, [bin, "register"], { stdio: "inherit" });
}
