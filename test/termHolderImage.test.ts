import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { imageFiles, imageFingerprint, imageOf } from "../src/core/term/holderImage";
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

/**
 * 지금 도는 사본 알아보기(imageOf) — holder 는 뜰 때 이것만 남기고 나머지 사본을 지운다(sweepHolderImages).
 * ★HOME 경로에 링크가 끼면(macOS 임시 폴더 /var → /private/var) 실행 파일 경로(실경로)와 HOME 기준 경로가 글자로 달라,
 * 자기 사본을 «안 쓰는 사본»으로 지우고 새 PTY 를 못 띄웠다(첫 전환 리허설 11-27).
 */
describe("지금 도는 사본(imageOf)", () => {
  it("사본 폴더 바로 안이면 지문 · 밖이면 undefined · ★HOME 이 링크를 거쳐도 같은 사본으로 본다", async () => {
    const real = realpathSync(await mkdtemp(join(tmpdir(), "aterm-image-")));
    try {
      await mkdir(join(real, "home", ".ainecto", "term", "holder", "abc123"), { recursive: true });
      const bundle = join(real, "home", ".ainecto", "term", "holder", "abc123", "ainecto.js");
      await writeFile(bundle, "");
      await symlink(join(real, "home"), join(real, "linked-home"));
      expect(imageOf(bundle, join(real, "home", ".ainecto", "term", "holder"))).toBe("abc123");
      expect(imageOf(join(real, "elsewhere", "dist", "bin", "ainecto.js"), join(real, "home", ".ainecto", "term", "holder"))).toBeUndefined();
      expect(imageOf(bundle, join(real, "linked-home", ".ainecto", "term", "holder"))).toBe("abc123");
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });
});
