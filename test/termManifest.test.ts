import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, writeManifest } from "../src/core/term/manifest";

describe("term manifest", () => {
  it("writes the manifest atomically with 0600 and reads it back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "term-manifest-"));
    try {
      const path = join(dir, "sessions.json");
      expect(await readManifest(path)).toEqual([]);
      const entry = { name: "s", cwd: "/tmp", command: ["claude", "--resume"], createdAt: "2026-11-06T00:00:00.000Z" };
      await writeManifest(path, [entry]);
      expect(await readManifest(path)).toEqual([entry]);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ sessions: [entry] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
