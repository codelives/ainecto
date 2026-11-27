import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { imageFiles, imageFingerprint } from "../src/core/term/holderImage";
import { nodePtyNativeDirs } from "../src/core/term/paths";

/**
 * holder 자기 사본(세션 유지 구조 3-1) — 무엇을 복사하나 · 지문. node-pty 는 설치된 그 패키지(이 저장소 node_modules) 그대로 본다.
 */
const NODE_PTY = dirname(createRequire(__filename).resolve("node-pty/package.json"));

describe("holder 사본 파일 목록(imageFiles) · 지문", () => {
  it("번들 + type module + node-pty 의 package.json·lib·★이 플랫폼 네이티브 폴더만(다른 플랫폼 prebuild 는 넣지 않는다)", async () => {
    const mac = (await imageFiles("/x/dist/bin/ainecto.js", NODE_PTY, nodePtyNativeDirs("darwin", "arm64"))).map((file) => file.to);
    expect(mac).toEqual(expect.arrayContaining(["ainecto.js", "package.json", "node_modules/node-pty/package.json", "node_modules/node-pty/lib/index.js",
      "node_modules/node-pty/lib/unixTerminal.js", "node_modules/node-pty/prebuilds/darwin-arm64/pty.node", "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"]));
    expect(mac.filter((to) => to.includes("prebuilds/") && !to.includes("prebuilds/darwin-arm64/"))).toEqual([]);
    expect(mac.filter((to) => to.includes("/src/") || to.includes("third_party") || to.endsWith("binding.gyp"))).toEqual([]);

    // Windows 끄기 경로의 helper(conpty 몫 · 콘솔 목록 agent)도 사본에.
    const windows = (await imageFiles("C:\\x\\dist\\bin\\ainecto.js", NODE_PTY, nodePtyNativeDirs("win32", "x64"))).map((file) => file.to);
    expect(windows).toEqual(expect.arrayContaining(["node_modules/node-pty/prebuilds/win32-x64/conpty.node",
      "node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node", "node_modules/node-pty/lib/conpty_console_list_agent.js"]));
    expect(windows.some((to) => to.startsWith("node_modules/node-pty/prebuilds/win32-x64/conpty/"))).toBe(true);

    // node-pty 가 없으면(선택 의존성 설치 실패) 번들만.
    expect((await imageFiles("/x/ainecto.js", undefined)).map((file) => file.to)).toEqual(["ainecto.js", "package.json"]);
  });

  it("지문 = 경로·내용 — 같으면 같고, 번들 내용이 한 바이트 바뀌면 다르다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aterm-image-"));
    try {
      const bundle = join(dir, "ainecto.js");
      await writeFile(bundle, "export {};\n");
      const first = await imageFingerprint(await imageFiles(bundle, NODE_PTY));
      expect(first).toMatch(/^[0-9a-f]{16}$/);
      expect(await imageFingerprint(await imageFiles(bundle, NODE_PTY))).toBe(first);
      await writeFile(bundle, "export {};\n\n");
      expect(await imageFingerprint(await imageFiles(bundle, NODE_PTY))).not.toBe(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
