import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDir, isNodeError } from "../fs/privateFiles";
import { CLI_BUNDLED } from "../version";
import { TermError } from "./errors";
import { nodePtyNativeDirs, type TermPaths } from "./paths";

/**
 * holder 자기 사본(세션 유지 구조 설계 3-1) — holder 는 처음 뜰 때 자기에게 필요한 파일을 `<holderImages>/<지문>/` 에 복사하고 거기서 돈다.
 * npx 캐시(설치본)를 지워도 holder 가 새 PTY 를 띄우고(spawn-helper·pty.node 는 사본에) Windows 끄기 경로의 helper(node-pty conpty 몫)도 사본에 있다.
 *   사본 = CLI 번들 하나(holder 코드 · @xterm/headless · addon-serialize 가 그 안에 묶여 있다) + `{"type":"module"}` + node-pty 의
 *          package.json · lib · 이 플랫폼 네이티브 폴더(paths.nodePtyNativeDirs 중 처음 있는 것).
 *   지문 = 복사할 파일들의 경로·내용 해시 — 같은 설치본이면 같은 폴더(다시 쓰지 않는다), 다른 판이면 다른 폴더.
 * 번들 밖 실행(vitest·tsx 의 소스)은 사본을 만들지 않는다 — 소스 트리 그대로 돈다.
 */

/** 다 쓴 사본 폴더의 표지 — 이 파일이 있어야 그 폴더를 쓴다(복사 중에 죽은 폴더를 쓰지 않는다). */
const COMPLETE_MARK = ".complete";

/** 사본에 넣을 파일 하나 — `from` 을 사본 폴더의 `to` 로(내용 `text` 가 있으면 그것을 쓴다). */
export interface ImageFile {
  to: string;
  from?: string;
  text?: string;
}

export interface HolderImage {
  /** 사본 폴더 이름 = 지문. */
  fingerprint: string;
  /** holder 를 띄울 진입 파일(사본 안의 CLI 번들). */
  entry: string;
}

/**
 * holder 사본을 준비한다(있으면 그대로) — 번들 밖이면 undefined(지금 진입 그대로 띄운다).
 * 복사에 실패하면 TERM_DAEMON_START 로 끊는다(설치본에서 몰래 띄우지 않는다 — 그러면 캐시를 지운 뒤 새 PTY 가 막힌다).
 */
export async function prepareHolderImage(paths: TermPaths): Promise<HolderImage | undefined> {
  if (!CLI_BUNDLED) return undefined;
  const bundle = fileURLToPath(import.meta.url);
  try {
    return await ensureImage(paths.holderImages, await imageFiles(bundle, nodePtyDir(bundle)));
  } catch (error) {
    throw new TermError("TERM_DAEMON_START", `Could not copy the term holder into ${paths.holderImages}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 지금 이 프로세스가 도는 사본의 지문 — 사본 폴더 밖에서 돌면 undefined. */
export function runningImage(paths: TermPaths): string | undefined {
  if (!CLI_BUNDLED) return undefined;
  return imageOf(fileURLToPath(import.meta.url), paths.holderImages);
}

/**
 * `file` 이 `<images>/<지문>/` 바로 안에 있으면 그 지문 — 아니면 undefined. ★실경로로 견준다 — 실행 파일 경로는 실경로인데 `images` 는
 * HOME 기준이라, HOME 경로에 링크가 끼면(macOS /var → /private/var 등) 글자로는 달라 holder 가 자기 사본을 지우고 새 PTY 를 못 띄웠다.
 */
export function imageOf(file: string, images: string): string | undefined {
  const folder = dirname(realOrAsIs(file));
  return dirname(folder) === realOrAsIs(images) ? basename(folder) : undefined;
}

/** 실경로 — 아직 없는 경로(ENOENT)는 그대로(없는 사본 폴더와는 어차피 견줄 것이 없다). */
function realOrAsIs(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return path;
    throw error;
  }
}

/**
 * 쓰지 않는 사본 폴더를 지운다 — holder 가 잠금을 쥔 뒤에 부른다(holder 는 PC 에 한 벌이라 다른 사본을 쓰는 holder 가 없다).
 * 지금 도는 사본(`keep`)만 남긴다. 지운 폴더 이름들.
 */
export async function sweepHolderImages(paths: TermPaths, keep: string | undefined): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(paths.holderImages);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const removed = names.filter((name) => name !== keep);
  for (const name of removed) {
    await rm(join(paths.holderImages, name), { recursive: true, force: true });
  }
  return removed;
}

/** 번들 옆에서 풀리는 node-pty 폴더 — 없으면(선택 의존성 설치 실패) undefined: 사본에도 없고, holder 는 세션을 띄울 때 지금처럼 사람 말로 끊는다. */
function nodePtyDir(bundle: string): string | undefined {
  try {
    return dirname(createRequire(bundle).resolve("node-pty/package.json"));
  } catch {
    // 없는 선택 의존성 — 사본에 넣을 것이 없다(오류는 세션을 띄울 때 session.loadNodePty 가 낸다).
    return undefined;
  }
}

/** 사본에 넣을 파일 목록(정렬) — 번들 · type module · node-pty(package.json · lib · 이 플랫폼 네이티브 폴더). */
export async function imageFiles(bundle: string, nodePty: string | undefined, nativeDirs: readonly string[] = nodePtyNativeDirs()): Promise<ImageFile[]> {
  const files: ImageFile[] = [{ to: "ainecto.js", from: bundle }, { to: "package.json", text: `${JSON.stringify({ type: "module" })}\n` }];
  if (nodePty) {
    const native = nativeDirs.find((dir) => existsSync(join(nodePty, dir)));
    files.push({ to: "node_modules/node-pty/package.json", from: join(nodePty, "package.json") });
    for (const dir of ["lib", ...(native ? [native] : [])]) {
      for (const file of await filesUnder(join(nodePty, dir))) {
        files.push({ to: `node_modules/node-pty/${relative(nodePty, file).split("\\").join("/")}`, from: file });
      }
    }
  }
  return files.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

/** 지문 — 파일마다 (사본 안 경로 · 내용)의 해시. 순수(읽기만). */
export async function imageFingerprint(files: readonly ImageFile[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.to).update("\0").update(file.text ?? await readFile(file.from!)).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function ensureImage(root: string, files: readonly ImageFile[]): Promise<HolderImage> {
  const fingerprint = await imageFingerprint(files);
  const folder = join(root, fingerprint);
  const image = { fingerprint, entry: join(folder, "ainecto.js") };
  if (existsSync(join(folder, COMPLETE_MARK))) return image;
  await ensurePrivateDir(root);
  // 남이 같은 지문을 만드는 중일 수 있다 — 자기 임시 폴더에 다 쓴 뒤 rename 으로 한 번에 내놓는다.
  const staging = join(root, `.staging-${randomUUID()}`);
  try {
    for (const file of files) {
      const target = join(staging, file.to);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      if (file.text !== undefined) {
        await writeFile(target, file.text, { mode: 0o600 });
      } else {
        await copyFile(file.from!, target);
        // spawn-helper 같은 실행 파일의 실행 권한을 그대로(남에게 열린 권한은 뺀다).
        await chmod(target, (await stat(file.from!)).mode & 0o700);
      }
    }
    await writeFile(join(staging, COMPLETE_MARK), "", { mode: 0o600 });
    await rm(folder, { recursive: true, force: true });
    try {
      await rename(staging, folder);
    } catch (error) {
      // 그 사이 다른 쪽이 같은 지문을 다 써 내놓았다 — 그것을 쓴다.
      if (!existsSync(join(folder, COMPLETE_MARK))) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return image;
}

async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}
