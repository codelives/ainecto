import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { termPaths } from "../src/core/term/paths";
import { IMAGE_KEEP_MS, IMAGE_MAX_BYTES } from "../src/core/term/remoteLimits";
import { imageProblem, pruneImages, saveImage } from "../src/core/term/remoteImage";

const OP = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";
const OP2 = "2b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";

/** 종류마다 맨 앞 magic bytes 만 맞춘 작은 본문. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const GIF = Buffer.from("GIF89a....", "ascii");
const WEBP = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ", "ascii")]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic", "ascii"), Buffer.alloc(8)]);
const HEIF = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypmif1", "ascii"), Buffer.alloc(8)]);

/** 웹 터미널 이미지 붙여넣기 — PC 저장(계약 §3·§4 · web-cmux saveImage 와 같게). */
describe("이미지 붙여넣기 저장 — 모양·크기·magic · 새 파일만 · 0600/0700 · 24시간 정리", () => {
  const dir = (): string => join(mkdtempSync(join(tmpdir(), "ainecto-img-")), "images");

  it("결재 값 — 원본 8 MiB · 24시간", () => {
    expect(IMAGE_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(IMAGE_KEEP_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("저장 폴더 — term 폴더 아래 images(OS 공통 · ~/.ainecto/term/images)", () => {
    expect(termPaths("/Users/r", "darwin").images).toBe(join("/Users/r", ".ainecto", "term", "images"));
    expect(termPaths("/home/r", "linux").images).toBe(join("/home/r", ".ainecto", "term", "images"));
  });

  it("6종 magic 이 맞으면 통과 · 종류·magic·opId 모양·0 바이트·8 MiB 초과는 거절 사유(순수)", () => {
    for (const [mime, bytes] of [["image/png", PNG], ["image/jpeg", JPEG], ["image/gif", GIF], ["image/webp", WEBP],
      ["image/heic", HEIC], ["image/heif", HEIF]] as const) {
      expect(imageProblem(OP, mime, bytes)).toBeUndefined();
    }
    expect(imageProblem(OP, "image/png", JPEG)).toBeDefined();
    expect(imageProblem(OP, "image/jpeg", PNG)).toBeDefined();
    expect(imageProblem(OP, "image/bmp", PNG)).toBeDefined();
    expect(imageProblem(OP, "image/svg+xml", Buffer.from("<svg/>"))).toBeDefined();
    expect(imageProblem(OP.toUpperCase(), "image/png", PNG)).toBeDefined();
    expect(imageProblem(`../${OP}`, "image/png", PNG)).toBeDefined();
    expect(imageProblem(OP, "image/png", Buffer.alloc(0))).toBeDefined();
    const big = Buffer.alloc(IMAGE_MAX_BYTES + 1);
    PNG.copy(big);
    expect(imageProblem(OP, "image/png", big)).toBeDefined();
    expect(imageProblem(OP, "image/png", big.subarray(0, IMAGE_MAX_BYTES))).toBeUndefined();
  });

  it("저장 — <opId>.<ext> 절대 경로 · 내용 그대로 · 파일 0600 · 폴더 0700 · 틀린 것은 TERM_BAD_REQUEST(파일 없음)", async () => {
    const images = dir();
    const saved = await saveImage({ dir: images, opId: OP, mime: "image/jpeg", bytes: JPEG });
    expect(saved.path).toBe(join(images, `${OP}.jpg`));
    expect(readFileSync(saved.path)).toEqual(JPEG);
    if (process.platform !== "win32") {
      expect(statSync(saved.path).mode & 0o777).toBe(0o600);
      expect(statSync(images).mode & 0o777).toBe(0o700);
    }
    await expect(saveImage({ dir: images, opId: OP2, mime: "image/png", bytes: JPEG })).rejects.toMatchObject({ code: "TERM_BAD_REQUEST" });
    await expect(saveImage({ dir: images, opId: "x", mime: "image/png", bytes: PNG })).rejects.toMatchObject({ code: "TERM_BAD_REQUEST" });
    expect(readdirSync(images)).toEqual([`${OP}.jpg`]);
  });

  it("같은 opId 두 번 — 새 파일만(wx): 두 번째는 TERM_BAD_REQUEST · 첫 파일 그대로", async () => {
    const images = dir();
    await saveImage({ dir: images, opId: OP, mime: "image/png", bytes: PNG });
    const other = Buffer.concat([PNG, Buffer.from([9, 9, 9])]);
    await expect(saveImage({ dir: images, opId: OP, mime: "image/png", bytes: other })).rejects.toMatchObject({ code: "TERM_BAD_REQUEST" });
    expect(readFileSync(join(images, `${OP}.png`))).toEqual(PNG);
  });

  it("24시간 지난 저장 이름(소문자 UUID.허용 확장자)만 정리 — 저장할 때 · 따로 부를 때(폴더 없으면 0) · 규칙 밖 이름·하위 폴더는 손대지 않는다", async () => {
    const images = dir();
    expect(await pruneImages(images, Date.now())).toEqual({ removed: 0, failed: 0 });
    await saveImage({ dir: images, opId: OP, mime: "image/png", bytes: PNG });
    const old = join(images, `${OP}.png`);
    const now = Date.now();
    const stale = new Date(now - IMAGE_KEEP_MS - 60_000);
    utimesSync(old, stale, stale);
    // 규칙 밖 이름 — 오래돼도 남는다(사용자가 넣은 파일·대문자 UUID·모르는 확장자·꼬리 붙은 이름).
    // 대소문자 변형은 저장 이름과 겹치지 않는 UUID 로(macOS·Windows 는 대소문자를 가리지 않아 같은 파일이 된다)
    const other = (digit: number): string => `${digit}c2c3d4e-5f60-4718-8293-a4b5c6d7e8f9`;
    const outsiders = ["fresh.png", `${other(3).toUpperCase()}.png`, `${other(4)}.PNG`, `${other(5)}.txt`, `${other(6)}.png.bak`];
    for (const name of outsiders) {
      writeFileSync(join(images, name), PNG);
      utimesSync(join(images, name), stale, stale);
    }
    mkdirSync(join(images, "sub"));
    utimesSync(join(images, "sub"), stale, stale);
    const saved = await saveImage({ dir: images, opId: OP2, mime: "image/gif", bytes: GIF, now });
    expect(saved.pruned).toEqual({ removed: 1, failed: 0 });
    expect(readdirSync(images).sort()).toEqual([`${OP2}.gif`, ...outsiders, "sub"].sort());
    const later = now + IMAGE_KEEP_MS + 60_000;
    expect(await pruneImages(images, later)).toEqual({ removed: 1, failed: 0 });
    expect(readdirSync(images).sort()).toEqual([...outsiders, "sub"].sort());
  });

  it.skipIf(process.platform === "win32")("images 가 링크·파일이면 정리도 저장도 하지 않는다 — 링크 너머 파일은 그대로(두 길 모두 같은 폴더 검사)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ainecto-img-"));
    const target = join(root, "elsewhere");
    mkdirSync(target);
    const victim = join(target, `${OP}.png`);
    writeFileSync(victim, PNG);
    const stale = new Date(Date.now() - IMAGE_KEEP_MS - 60_000);
    utimesSync(victim, stale, stale);
    const linked = join(root, "images");
    symlinkSync(target, linked);
    await expect(pruneImages(linked)).rejects.toThrow(/real directory/);
    await expect(saveImage({ dir: linked, opId: OP2, mime: "image/png", bytes: PNG })).rejects.toThrow(/real directory/);
    expect(existsSync(victim)).toBe(true);
    expect(readdirSync(target)).toEqual([`${OP}.png`]);
    const file = join(root, "plain");
    writeFileSync(file, "x");
    await expect(pruneImages(file)).rejects.toThrow();
  });
});
