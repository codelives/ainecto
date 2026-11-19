import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

  it("project 칸(KAN-1238) — 있으면 그대로 읽고 · 옛 파일(칸 없음)도 그대로 읽힌다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "term-manifest-"));
    try {
      const path = join(dir, "sessions.json");
      const old = { name: "old", cwd: "/tmp", command: null, createdAt: "2026-11-06T00:00:00.000Z", label: "옛" };
      const tagged = { name: "new", cwd: "/tmp", command: null, createdAt: "2026-11-19T00:00:00.000Z",
        project: "0b9a8c7d-1111-4222-8333-444455556666" };
      await writeFile(path, `${JSON.stringify({ sessions: [old, tagged, { ...tagged, name: "broken", project: 7 }] })}\n`);
      expect(await readManifest(path)).toEqual([old, tagged]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
