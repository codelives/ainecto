import { appHome, webSessionsDir } from "../src/core/term/paths";

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
    expect(webSessionsDir("/Users/r/Library/Application Support/ainecto")).toBe("/Users/r/Library/Application Support/ainecto/sessions");
  });
});
