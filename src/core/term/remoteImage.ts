import { lstat, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDir, isNodeError, PRIVATE_FILE_MODE } from "../fs/privateFiles";
import { TermError } from "./errors";
import { isUuid } from "./paths";
import { IMAGE_KEEP_MS, IMAGE_MAX_BYTES } from "./remoteLimits";

/**
 * 웹 터미널 이미지 붙여넣기의 PC 저장(계약 §4 — web-cmux agent saveImage 와 같은 규칙). 데몬과 무관하다.
 *
 * <pre>
 * 검사   종류 6가지(mime → 확장자) · opId 는 소문자 UUID · 0 바이트·8 MiB 초과 거절 · 맨 앞 magic bytes 가 그 종류여야
 * 저장   폴더(TermPaths.images) 0700 · `<opId>.<ext>` 새 파일만(wx) 0600 — 같은 opId 두 번이면 거절(덮지 않는다)
 * 정리   24시간 지난 «저장 이름»(소문자 UUID.허용 확장자) 일반 파일만 — 저장할 때 + 원격 다리가 켜질 때.
 *        두 길 모두 저장과 같은 폴더 검사(ensurePrivateDir — 링크·폴더 아님·남의 것이면 거절)를 먼저 거친다.
 *        규칙 밖 이름·하위 폴더·링크는 손대지 않는다
 * </pre>
 * Windows 는 0600·0700 이 뜻이 없다(읽기 전용 표시만) — 그대로 두고 실패하지 않는다.
 */

/** 받는 종류와 저장 확장자(web-cmux 와 같은 6종). */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

/** HEIC·HEIF 의 ftyp 상표(web-cmux 와 같음). */
const HEIF_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"];

/** 맨 앞 바이트가 그 종류인가(순수). */
function magicMatches(mime: string, bytes: Uint8Array): boolean {
  const ascii = (start: number, end: number): string => Buffer.from(bytes.subarray(start, end)).toString("latin1");
  switch (mime) {
    case "image/png":
      return Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(ascii(0, 6));
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "image/heic":
    case "image/heif":
      return ascii(4, 8) === "ftyp" && HEIF_BRANDS.includes(ascii(8, 12));
    default:
      return false;
  }
}

/** 받을 수 없는 이유(순수) — 받을 수 있으면 undefined. 문구는 봉인 답의 detail 에만 간다. */
export function imageProblem(opId: string, mime: string, bytes: Uint8Array): string | undefined {
  if (IMAGE_EXTENSIONS[mime] === undefined) return `The image type "${mime}" is not supported (png, jpeg, gif, webp, heic, heif).`;
  if (!isUuid(opId)) return "The image request id is not a UUID.";
  if (bytes.length === 0) return "The image is empty.";
  if (bytes.length > IMAGE_MAX_BYTES) return `The image is larger than ${IMAGE_MAX_BYTES} bytes.`;
  if (!magicMatches(mime, bytes)) return `The image bytes are not ${mime}.`;
  return undefined;
}

/** 정리 결과 — 지운 수 · 못 지운 수(로그용). */
export interface ImagePrune {
  removed: number;
  failed: number;
}

/** 이 모듈이 저장했을 이름인가(순수) — `<소문자 UUID>.<허용 확장자>` 만. */
export function isSavedImageName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && isUuid(name.slice(0, dot)) && Object.values(IMAGE_EXTENSIONS).includes(name.slice(dot + 1));
}

/**
 * {@code now} 기준 24시간 지난 저장 이름의 일반 파일을 지운다. 폴더는 저장과 같은 검사를 먼저 거친다(없으면 0700 으로 만든다 ·
 * 링크·폴더 아님·남의 것이면 던진다 — 정리하지 않는다). 규칙 밖 이름·하위 폴더·링크는 남긴다.
 */
export async function pruneImages(dir: string, now: number = Date.now()): Promise<ImagePrune> {
  await ensurePrivateDir(dir);
  const names = await readdir(dir);
  const cutoff = now - IMAGE_KEEP_MS;
  const outcome = { removed: 0, failed: 0 };
  for (const name of names) {
    if (!isSavedImageName(name)) continue;
    const path = join(dir, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.mtimeMs >= cutoff) continue;
      await unlink(path);
      outcome.removed += 1;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) outcome.failed += 1;
    }
  }
  return outcome;
}

/**
 * 이미지 한 장을 저장한다 — 절대 경로와 그때 정리한 수. 검사에 걸리거나 같은 이름이 이미 있으면 TermError(TERM_BAD_REQUEST).
 * {@code dir} 은 절대 경로여야 한다(TermPaths.images).
 */
export async function saveImage(input: { dir: string; opId: string; mime: string; bytes: Uint8Array; now?: number })
  : Promise<{ path: string; pruned: ImagePrune }> {
  const problem = imageProblem(input.opId, input.mime, input.bytes);
  if (problem) throw new TermError("TERM_BAD_REQUEST", problem);
  const pruned = await pruneImages(input.dir, input.now);   // 폴더 검사(ensurePrivateDir)도 여기서
  const path = join(input.dir, `${input.opId}.${IMAGE_EXTENSIONS[input.mime]}`);
  try {
    await writeFile(path, input.bytes, { flag: "wx", mode: PRIVATE_FILE_MODE });
  } catch (error) {
    if (isNodeError(error, "EEXIST")) throw new TermError("TERM_BAD_REQUEST", "An image with this request id was already saved.");
    throw error;
  }
  return { path, pruned };
}
