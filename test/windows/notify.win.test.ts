import { notifyTool, runQuiet } from "../../src/core/os/launch";
import { WINDOWS } from "./winRig";

/**
 * Windows PC 알림(PowerShell 5.1 WinRT) — 러너는 화면이 없어 «보였는가»는 사람 확인(Edwin 실기기). 여기서는 제품이 부르는 그대로 띄워
 * 스크립트가 PowerShell 에서 문법·형식 오류 없이 끝나는지(끝 코드 0)만 본다. 알림 플랫폼이 없는 러너면 그 오류를 기록하고 실패한다.
 */
describe.runIf(WINDOWS)("Windows PC 알림 — PowerShell 스크립트가 끝 코드 0 으로 끝난다", () => {
  it("제목·본문에 따옴표·한글·$ 가 있어도 스크립트가 깨지지 않는다", async () => {
    const tool = notifyTool();
    expect(tool?.file).toBe("powershell.exe");
    const started = Date.now();
    let failure: unknown;
    await runQuiet(tool?.file ?? "", tool?.args("AiNecto 알림 시험", "Chrome · Windows opened a terminal — '$(whoami)' \"x\"") ?? []).catch((error: unknown) => { failure = error; });
    console.log(`[notify-measure] ok=${failure === undefined} ms=${Date.now() - started} ${failure instanceof Error ? failure.message.slice(0, 300) : ""}`);
    expect(failure).toBeUndefined();
  }, 60_000);
});
