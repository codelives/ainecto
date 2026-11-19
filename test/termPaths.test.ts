import { appHome, isUuid, webSessionFolder } from "../src/core/term/paths";

describe("앱 홈 — OS 관례 앱 데이터 아래 ainecto (웹 세션 폴더)", () => {
  it("macOS ~/Library/Application Support · Windows %LOCALAPPDATA% · Linux ${XDG_DATA_HOME:-~/.local/share}", () => {
    expect(appHome("darwin", {}, "/Users/r")).toBe("/Users/r/Library/Application Support/ainecto");
    expect(appHome("win32", { LOCALAPPDATA: "C:\\Users\\r\\AppData\\Local" }, "C:\\Users\\r")).toBe("C:\\Users\\r\\AppData\\Local\\ainecto");
    expect(appHome("win32", {}, "C:\\Users\\r")).toBe("C:\\Users\\r\\AppData\\Local\\ainecto");
    expect(appHome("linux", { XDG_DATA_HOME: "/data/r" }, "/home/r")).toBe("/data/r/ainecto");
    expect(appHome("linux", {}, "/home/r")).toBe("/home/r/.local/share/ainecto");
    // XDG 규칙: 절대 경로가 아니면 무시한다.
    expect(appHome("linux", { XDG_DATA_HOME: "relative/dir" }, "/home/r")).toBe("/home/r/.local/share/ainecto");
    expect(appHome("freebsd", {}, "/home/r")).toBe("/home/r/.local/share/ainecto");
  });
});

describe("웹 세션 폴더 — 경로 틀 한 곳(KAN-1238)", () => {
  const APP = "/Users/r/Library/Application Support/ainecto";
  const REQ = "1d2c3b4a-0000-4000-8000-000000000001";
  const PROJECT = "0b9a8c7d-1111-4222-8333-444455556666";

  it("꼬리표 없음 → <앱 홈>/sessions/<requestId> · 있음 → <앱 홈>/projects/<uuid>/sessions/<requestId>", () => {
    expect(webSessionFolder(APP, undefined, REQ)).toBe(`${APP}/sessions/${REQ}`);
    expect(webSessionFolder(APP, PROJECT, REQ)).toBe(`${APP}/projects/${PROJECT}/sessions/${REQ}`);
  });

  it("UUID 는 정확한 소문자 8-4-4-4-12 만 — 대문자·`..`·빈 값·구분자 거절(폴더를 만들지 않는다)", () => {
    expect(isUuid(PROJECT)).toBe(true);
    for (const bad of [PROJECT.toUpperCase(), "", "..", `../${PROJECT}`, `${PROJECT}/x`, PROJECT.slice(1), ` ${PROJECT}`]) {
      expect(isUuid(bad)).toBe(false);
      expect(() => webSessionFolder(APP, bad, REQ)).toThrow(expect.objectContaining({ code: "TERM_BAD_REQUEST" }));
      expect(() => webSessionFolder(APP, undefined, bad)).toThrow(expect.objectContaining({ code: "TERM_BAD_REQUEST" }));
    }
  });
});
