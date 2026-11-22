import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "../../src/core/auth/oauth";
import { until, WINDOWS } from "./winRig";

/**
 * 로그인 브라우저 열기(Ryan 실기기 11-22 — explorer.exe 로는 안 떴다) — ★실제 launchBrowser 가 띄우는 명령이 긴 주소(쿼리 `&` 포함)를
 * 한 인자로 등록된 핸들러에 넘기는지. https 기본 브라우저는 Windows 가 사용자 선택을 해시로 지켜 바꿀 수 없으므로, 이 시험만의 URL 방식
 * (HKCU\Software\Classes\<방식>, 끝나면 지움)에 «받은 인자를 파일에 쓰는» 기록 스크립트를 걸고, launchBrowser 가 띄우는 argv 에서 https 주소만
 * 그 방식으로 바꿔 띄운다(명령·옵션은 제품 그대로). 비교로 예전 explorer.exe 를 같은 주소로 잰다(측정 — 단언 아님).
 */
const SCHEME = "ainecto-test-open";
const KEY = `HKCU\\Software\\Classes\\${SCHEME}`;
// 운영 로그인 주소와 같은 모양·길이(약 330자 — explorer 경로 한도 260 을 넘는다).
const QUERY = "response_type=code&client_id=" + "c".repeat(36)
  + "&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback&code_challenge=" + "p".repeat(43)
  + "&code_challenge_method=S256&resource=https%3A%2F%2Fainecto.com%2Fmcp&state=" + "s".repeat(43);
const HTTPS_URL = `https://ainecto.com/oauth2/authorize?${QUERY}`;
const TEST_URL = `${SCHEME}://ainecto.com/oauth2/authorize?${QUERY}`;

let work: string;
let received: string;

function reg(...args: string[]): void {
  execFileSync("reg", args, { windowsHide: true, stdio: "ignore" });
}

beforeAll(async () => {
  if (!WINDOWS) return;
  work = await realpath(await mkdtemp(join(tmpdir(), "awin-browser-")));
  received = join(work, "received.txt");
  const recorder = join(work, "record.js");
  await writeFile(recorder, `require("node:fs").writeFileSync(${JSON.stringify(received)}, process.argv[2] ?? "");`);
  reg("add", KEY, "/ve", "/d", `URL:${SCHEME}`, "/f");
  reg("add", KEY, "/v", "URL Protocol", "/d", "", "/f");
  reg("add", `${KEY}\\shell\\open\\command`, "/ve", "/d", `"${process.execPath}" "${recorder}" "%1"`, "/f");
});
afterAll(async () => {
  if (!WINDOWS) return;
  reg("delete", KEY, "/f");
  await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

async function arrived(): Promise<string | undefined> {
  return await until(async () => (await readFile(received, "utf8").then(() => true, () => false)), "handler ran", 15_000)
    .then(() => readFile(received, "utf8"), () => undefined);
}

describe.runIf(WINDOWS)("로그인 브라우저 열기 — 등록된 핸들러에 주소 전체가 한 인자로", () => {
  it("launchBrowser(제품 명령·옵션) → 핸들러가 받은 인자 = 보낸 주소 전체(쿼리 & 포함, 260자 넘음)", async () => {
    expect(TEST_URL.length).toBeGreaterThan(260);
    await rm(received, { force: true });
    await launchBrowser(HTTPS_URL, {
      platform: "win32",
      spawnImpl: (command, args, options) => spawn(command, args.map((arg) => (arg === HTTPS_URL ? TEST_URL : arg)), options),
    });
    const got = await arrived();
    console.log(JSON.stringify({ measure: "browser-open-rundll32", sent: TEST_URL.length, received: got?.length ?? null, same: got === TEST_URL }));
    expect(got).toBe(TEST_URL);
  }, 30_000);

  it("비교 측정 — 예전 explorer.exe 에 같은 주소(단언 없음)", async () => {
    await rm(received, { force: true });
    spawn("explorer.exe", [TEST_URL], { stdio: "ignore", detached: true }).unref();
    const got = await arrived();
    console.log(JSON.stringify({ measure: "browser-open-explorer", sent: TEST_URL.length, received: got?.length ?? null, same: got === TEST_URL }));
  }, 30_000);
});
