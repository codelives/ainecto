// windows-live — 실제 PC(Windows 러너 · 또는 macOS)에서 후보 CLI 를 dev 서버에 붙여 끝까지 돈다(설계 _workspace/design/windows-pc/ecobit/windows-live-ci.md).
// 가입 → CLI 로그인 → PC 연결 → 웹 터미널(2차 확인·짝짓기) → 세션 둘 입력·출력·전환 → 끊기·재연결 → 데몬 강제 종료·복원 → 정리.
// 단계마다 증적(화면·CLI 출력·로그)을 OUT 에 남기고, 실패하면 그 단계 이름으로 끝난다. 계정은 실패해도 탈퇴한다.
//
// 입력(env — 시험 틀 전용):
//   AINECTO_LIVE_TGZ         후보 tgz — 이 실행의 홈에 의존성으로 설치한다(관리 세션의 `npx --package @ainecto/mcp@<판>` 도 이것을 고른다) — 필수
//   AINECTO_LIVE_PLAYWRIGHT  `playwright` 또는 `@playwright/test` 를 찾을 폴더(그 node_modules 의 부모) — 필수
//   DEV_LIVE_SIGNUP_CODE     dev 가입·터미널 2차 확인 고정 코드 — 필수(CI 는 환경 secret)
//   AINECTO_LIVE_OUT         증적 폴더(기본: 임시 폴더)
//   AINECTO_LIVE_STEPS       쉼표로 이은 단계 이름 — 그 단계까지만(개발용 · 기본 전부)
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, cpSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS = process.platform === "win32";
const ORIGIN = "https://dev.ainecto.com";
const APP = `${ORIGIN}/app`;
const PASSWORD = "QaPass-1234";
const TGZ = need("AINECTO_LIVE_TGZ");
const CODE = need("DEV_LIVE_SIGNUP_CODE");
const require = createRequire(join(need("AINECTO_LIVE_PLAYWRIGHT"), "noop.js"));
const { chromium } = loadPlaywright();
const ptyRequire = createRequire(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json"));
const pty = ptyRequire("node-pty");
const OUT = process.env.AINECTO_LIVE_OUT || mkdtempSync(join(tmpdir(), "ainecto-live-out-"));
const ONLY = process.env.AINECTO_LIVE_STEPS ? new Set(process.env.AINECTO_LIVE_STEPS.split(",")) : undefined;
const RUN = randomBytes(4).toString("hex");
const EMAIL = `e2e-winlive-${RUN}@ainecto.test`;
const MARK = `WIN-LIVE-${RUN}`;

function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadPlaywright() {
  for (const name of ["playwright", "@playwright/test"]) {
    try {
      return require(name);
    } catch {
      // 다음 이름
    }
  }
  throw new Error("playwright not found under AINECTO_LIVE_PLAYWRIGHT");
}

mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "steps.log");
function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  appendFileSync(LOG, `${text}\n`);
}

// ── 이 실행만의 PC — 홈을 따로 둔다(사용자 ~/.ainecto·로그인을 건드리지 않는다) ──
const HOME = mkdtempSync(join(tmpdir(), "ainecto-live-home-"));
const BIN = join(HOME, "bin");
mkdirSync(BIN);
const URL_FILE = join(HOME, "opened-urls.txt");
// 새 홈이라 zsh 가 «처음 쓰는 사람 설정» 메뉴를 띄우지 않게 빈 rc 를 둔다(사람 PC 에는 있다).
for (const rc of [".zshrc", ".bashrc", ".bash_profile"]) writeFileSync(join(HOME, rc), "");
if (!WINDOWS) {
  // macOS·Linux: CLI 가 부르는 «브라우저 열기»를 주소 기록으로 바꾼다 — 사람 브라우저가 뜨지 않게. Windows 러너는 rundll32 그대로(화면 없음).
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(BIN, name), `#!/bin/sh\necho "$1" >> "${URL_FILE}"\n`);
    chmodSync(join(BIN, name), 0o755);
  }
}
const ENV = { ...process.env, HOME, USERPROFILE: HOME, PATH: `${BIN}${WINDOWS ? ";" : ":"}${process.env.PATH}` };
if (WINDOWS) ENV.LOCALAPPDATA = join(HOME, "AppData", "Local");
for (const key of Object.keys(ENV)) {
  if (key.startsWith("DEV_LIVE_") || key.startsWith("XDG_") || key === "AINECTO_TOKEN" || key === "AINECTO_TERM_SESSION") delete ENV[key];
}

// 후보 설치 — 홈 = npm 프로젝트(관리 세션의 작업 폴더는 홈 아래라 npx 가 여기 설치된 후보를 쓴다 · Windows CI W4 와 같은 방식).
function npm(args) {
  return new Promise((resolve, reject) => {
    execFile(WINDOWS ? "npm.cmd" : "npm", args, { cwd: HOME, env: ENV, windowsHide: true, shell: WINDOWS, timeout: 600_000 }, (error, stdout, stderr) => {
      appendFileSync(join(OUT, "npm.log"), `$ npm ${args.join(" ")}\n${stdout}${stderr}\n`);
      if (error) reject(new Error(`npm ${args.join(" ")} failed: ${stderr.slice(-400)}`));
      else resolve(stdout);
    });
  });
}
await npm(["init", "-y"]);
await npm(["install", "--no-audit", "--no-fund", TGZ]);
const CLI = join(HOME, "node_modules", "@ainecto", "mcp", "dist", "bin", "ainecto.js");

function cli(args, options = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, "--env", "dev", ...args], { env: ENV, cwd: HOME, windowsHide: true, timeout: options.timeoutMs ?? 120_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        appendFileSync(join(OUT, "cli.log"), `$ ainecto ${args.join(" ")}\n[exit ${code}]\n${stdout}${stderr}\n`);
        resolve({ code, stdout, stderr });
      });
  });
}

async function ok(args, options) {
  const run = await cli(args, options);
  if (run.code !== 0) throw new Error(`ainecto ${args.join(" ")} → ${run.code}: ${run.stderr.slice(0, 500)}`);
  return run.stdout;
}

/** 사람이 보는 터미널처럼 — PTY 안에서 CLI 를 띄우고 화면 글을 모은다. */
function interactive(args) {
  const term = pty.spawn(process.execPath, [CLI, "--env", "dev", ...args], { name: "xterm-256color", cols: 120, rows: 40, cwd: HOME, env: ENV });
  let screen = "";
  let exitCode;
  term.onData((data) => {
    screen += data;
    appendFileSync(join(OUT, `pty-${args[0] ?? "pc"}.log`), data);
  });
  const exited = new Promise((resolve) => term.onExit(({ exitCode: code }) => { exitCode = code; resolve(code); }));
  return {
    get screen() { return screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""); },
    get exitCode() { return exitCode; },
    exited,
    write: (text) => term.write(text),
    kill: () => { try { term.kill(); } catch { /* 이미 끝남 */ } },
  };
}

async function until(check, what, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((wake) => setTimeout(wake, 300));
  }
}

const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));

// ── 단계 ──
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: "ko-KR", viewport: { width: 1400, height: 900 } });
let page = await context.newPage();
const remoteBodies = [];
context.on("request", (request) => {
  if (request.url().includes("/api/v1/term/remote")) remoteBodies.push(request.postData() ?? "");
});
context.on("response", async (response) => {
  if (!response.url().includes("/api/v1/term/remote")) return;
  try { remoteBodies.push(await response.text()); } catch { /* 본문 없음 */ }
});

let step = "start";
let signedUp = false;
const results = [];

async function shot(name) {
  await page.screenshot({ path: join(OUT, `${String(results.length).padStart(2, "0")}-${name}.png`), fullPage: false }).catch(() => undefined);
}

async function run(name, body) {
  if (ONLY && !ONLY.has(name)) return;
  step = name;
  const started = Date.now();
  log(`▶ ${name}`);
  await body();
  results.push({ step: name, ok: true, ms: Date.now() - started });
  log(`✓ ${name} (${Date.now() - started} ms)`);
  await shot(name);
}

/** 앱 쿠키로 API — 브라우저 컨텍스트의 요청(쿠키 공유). 페이지가 어디 있든(로그인 콜백 주소 등) 된다. */
async function api(method, path, body) {
  const response = await context.request.fetch(`${ORIGIN}${path}`, { method, ...(body ? { data: body } : {}), failOnStatusCode: false });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
  return { status: response.status(), json };
}

let exitCode = 0;
try {
  await run("signup", async () => {
    await page.goto(`${APP}/login`);
    const request = await api("POST", "/api/v1/auth/signup/request-code", { email: EMAIL });
    const verify = await api("POST", "/api/v1/auth/signup/verify", { email: EMAIL, code: CODE, password: PASSWORD, name: `Win Live ${RUN}` });
    const me = await api("GET", "/api/v1/auth/me");
    if (me.status !== 200) throw new Error(`signup request-code ${request.status} verify ${verify.status} me ${me.status}`);
    signedUp = true;
    log(`  account ${EMAIL}`);
  });

  await run("cli-login", async () => {
    const login = spawn(process.execPath, [CLI, "--env", "dev", "auth", "login", "--json"], { env: ENV, cwd: HOME, windowsHide: true });
    let stderr = "";
    let stdout = "";
    login.stderr.on("data", (chunk) => { stderr += chunk; });
    login.stdout.on("data", (chunk) => { stdout += chunk; });
    const done = new Promise((resolve) => login.on("exit", resolve));
    const url = await until(() => /"event":"login_url","url":"([^"]+)"/.exec(stderr)?.[1], "login url", 30_000);
    await page.goto(url);
    const allow = page.getByRole("button", { name: /^(Allow|허용)$/ });
    if (await allow.isVisible({ timeout: 15_000 }).catch(() => false)) await allow.click();
    const code = await Promise.race([done, sleep(60_000).then(() => "timeout")]);
    appendFileSync(join(OUT, "cli.log"), `$ ainecto auth login --json\n[exit ${code}]\n${stdout}${stderr}\n`);
    if (code !== 0) throw new Error(`auth login → ${code}: ${stderr.slice(-400)}`);
    const status = JSON.parse(await ok(["auth", "status", "--json"]));
    log(`  auth status ${JSON.stringify(status.data ?? status).slice(0, 200)}`);
  });

  await run("pc-connect", async () => {
    const pc = interactive([]);
    await until(() => pc.screen.includes("Connect this PC?"), "Connect this PC? prompt", 120_000);
    pc.write("y\r");
    await until(() => pc.screen.includes("Also allow terminals from the web?"), "allow terminals prompt");
    pc.write("y\r");
    await until(() => pc.screen.includes("This PC is now connected") || pc.exitCode !== undefined, "connected line", 180_000);
    await pc.exited;
    if (!pc.screen.includes("This PC is now connected")) throw new Error(`not connected: ${pc.screen.slice(-600)}`);
    const status = await cli(["status", "--json"]);
    log(`  status ${status.stdout.replace(/\s+/g, " ").slice(0, 300)}`);
    const listed = JSON.parse(await ok(["term", "ls", "--json"]));
    log(`  term ls ${JSON.stringify(listed.data?.sessions?.map((x) => ({ name: x.name, command: x.command })) ?? listed).slice(0, 300)}`);
  });

  await run("web-terminal", async () => {
    // 가입 때 생기는 기본 워크스페이스·프로젝트(KAN-945)로 바로 간다 — 첫 안내 화면은 «지금은 건너뛰기».
    const items = (body) => (Array.isArray(body) ? body : body?.items ?? body?.content ?? body?.data ?? []);
    const workspace = items((await api("GET", "/api/v1/workspaces")).json)[0]?.uuid;
    const project = workspace ? items((await api("GET", `/api/v1/workspaces/${workspace}/projects`)).json)[0]?.uuid : undefined;
    if (!project) throw new Error("no default project for the fresh account");
    await page.goto(`${APP}/projects/${project}`);
    const skip = page.getByRole("button", { name: "지금은 건너뛰기" });
    if (await skip.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await skip.click();
      await page.goto(`${APP}/projects/${project}`);
    }
    const terminal = page.getByTestId("activity-bar-terminal");
    await terminal.click();
    // 2차 확인 — 이메일 코드(시험 도메인은 dev 고정 코드 · 메일 안 나감).
    await page.getByTestId("terminal-access-send").click();
    await page.getByTestId("terminal-access-code").fill(CODE);
    await page.getByTestId("terminal-access-verify").click();
    // 확인 직후 «다음부터 패스키로…» 제안 창(단추로만 닫힘)이 조금 늦게 뜬다 — 뜨면 «나중에».
    const offer = page.getByTestId("confirm-dialog");
    if (await offer.waitFor({ timeout: 20_000 }).then(() => true, () => false)) {
      await offer.getByRole("button", { name: "나중에" }).click();
      await offer.waitFor({ state: "hidden", timeout: 10_000 });
    }
    await page.getByTestId("terminal-pc").first().waitFor({ timeout: 60_000 });
    log(`  pc row ${(await page.getByTestId("terminal-pc").first().innerText()).replace(/\s+/g, " ").slice(0, 160)}`);
  });

  await run("pair", async () => {
    const pc = interactive(["pair"]);
    await until(() => pc.screen.includes("Waiting up to") || pc.exitCode !== undefined, "pair waiting line", 60_000);
    if (pc.exitCode !== undefined) throw new Error(`pair ended early: ${pc.screen.slice(-500)}`);
    await page.getByTestId("terminal-pair-start").click();
    const codeA = await until(() => /Type this code in the browser: (\d{6})/.exec(pc.screen)?.[1], "code A on the PC", 60_000);
    await page.getByTestId("terminal-pair-code").fill(codeA);
    await page.getByTestId("terminal-pair-check").click();
    const shown = await page.getByTestId("terminal-pair-code-b").textContent({ timeout: 30_000 });
    const codeB = /\d{6}/.exec(shown ?? "")?.[0];
    if (!codeB) throw new Error(`no code B: ${shown}`);
    await until(() => pc.screen.includes("Then type the code the browser shows"), "code B prompt");
    pc.write(`${codeB}\r`);
    await page.getByTestId("terminal-pair-done").waitFor({ timeout: 60_000 });
    const code = await Promise.race([pc.exited, sleep(30_000).then(() => "timeout")]);
    if (code !== 0) throw new Error(`pair exit ${code}: ${pc.screen.slice(-500)}`);
    log(`  paired · pair --list ${(await cli(["pair", "--list"])).stdout.replace(/\s+/g, " ").slice(0, 200)}`);
  });

  // 화면 = 줄(.term-row)마다 칸(.term-cell)을 이은 글.
  const screenText = async () => (await page.locator('[data-testid="terminal-screen"] .term-row').allTextContents().catch(() => []))
    .join("\n").replace(/\u00a0/g, " ");
  async function typeLine(text) {
    const input = page.getByTestId("terminal-input");
    await input.waitFor({ timeout: 60_000 });
    await until(async () => await input.isEnabled(), "terminal input enabled", 60_000);
    await input.fill(text);
    await input.press("Enter");
  }
  async function newSession(name) {
    await page.getByTestId("terminal-session-new").first().click();
    await page.getByTestId("terminal-session-name").fill(name);
    // 첫 명령 기본값은 Claude Code(claude) — 시험은 «셸만»(value "").
    await page.getByTestId("terminal-session-first-command").selectOption("");
    await page.getByTestId("terminal-session-create").click();
    await page.locator(`[data-testid="terminal-session"]`, { hasText: name }).first().waitFor({ timeout: 60_000 });
  }
  async function openSession(name) {
    await page.locator(`[data-testid="terminal-session"]`, { hasText: name }).first().locator("button").first().click();
  }
  async function expectOnScreen(text, what) {
    await until(async () => (await screenText()).includes(text), what, 60_000);
  }

  await run("sessions", async () => {
    await newSession("live-a");
    await openSession("live-a");
    await typeLine(`echo ${MARK}-A`);
    await expectOnScreen(`${MARK}-A`, "echo A on screen");
    await newSession("live-b");
    await openSession("live-b");
    await typeLine(`echo ${MARK}-B 한글`);
    await expectOnScreen(`${MARK}-B 한글`, "echo B on screen");
    await openSession("live-a");
    await expectOnScreen(`${MARK}-A`, "switch back to A");
    const names = JSON.parse(await ok(["term", "ls", "--json"])).data.sessions.map((x) => x.name);
    log(`  term ls on the PC: ${names.join(", ")}`);
    const leaked = remoteBodies.filter((body) => body.includes(MARK)).length;
    log(`  /api/v1/term/remote bodies captured ${remoteBodies.length} · with the marker ${leaked}`);
    if (leaked > 0) throw new Error("the marker appeared in a relay body (end-to-end encryption broken)");
  });

  await run("reconnect", async () => {
    log(`  remote off: ${(await cli(["remote", "off"])).stdout.replace(/\s+/g, " ").slice(0, 160)}`);
    await page.getByTestId("terminal-pc-off").first().waitFor({ timeout: 60_000 }).catch(() => log("  (web did not show the off row)"));
    await shot("remote-off");
    log(`  remote on: ${(await cli(["remote", "on"])).stdout.replace(/\s+/g, " ").slice(0, 160)}`);
    await openSession("live-a");
    await typeLine(`echo ${MARK}-RE`);
    await expectOnScreen(`${MARK}-RE`, "input after remote on");
    // 브라우저 탭을 닫았다 다시 연다 — 같은 세션 화면이 나온다.
    const url = page.url();
    await page.close();
    page = await context.newPage();
    await page.goto(url);
    const terminal = page.getByTestId("activity-bar-terminal");
    if ((await terminal.getAttribute("aria-pressed")) !== "true") await terminal.click();
    await page.locator(`[data-testid="terminal-session"]`, { hasText: "live-a" }).first().waitFor({ timeout: 60_000 });
    await openSession("live-a");
    await expectOnScreen(`${MARK}-RE`, "same screen after reopening the tab");
  });

  await run("daemon-restore", async () => {
    const info = JSON.parse(readFileSync(join(HOME, ".ainecto", "term", "daemon.json"), "utf8"));
    if (WINDOWS) await new Promise((resolve) => execFile("taskkill", ["/F", "/PID", String(info.pid)], { windowsHide: true }, resolve));
    else process.kill(info.pid, "SIGKILL");
    log(`  killed daemon pid ${info.pid}`);
    await sleep(3_000);
    const restored = JSON.parse(await ok(["term", "restore", "--json"]));
    log(`  restore ${JSON.stringify(restored.data ?? restored).slice(0, 300)}`);
    await page.locator(`[data-testid="terminal-session"]`, { hasText: "live-a" }).first().waitFor({ timeout: 120_000 });
    await openSession("live-a");
    // 복원된 세션은 새 셸이다 — 다리가 다시 붙고 새 암호 채널로 새 화면이 올 때까지 기다린 뒤 입력한다
    // (그 전에 보낸 입력은 웹이 «실행 미확정»으로 두고 저절로 다시 보내지 않는다 — 설계대로).
    await until(async () => { const text = await screenText(); return text.trim() !== "" && !text.includes(`${MARK}-RE`); }, "fresh shell screen after restore", 120_000);
    await sleep(2_000);
    await typeLine(`echo ${MARK}-AFTER`);
    await expectOnScreen(`${MARK}-AFTER`, "input after daemon restore");
  });

} catch (error) {
  exitCode = 1;
  log(`✗ ${step}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  await shot(`FAILED-${step}`);
} finally {
  // PC 연결·데몬을 먼저 끈다(계정을 지우기 전 · 남은 프로세스 0).
  await cli(["stop", "--forget"], { timeoutMs: 90_000 }).catch(() => undefined);
  await cli(["term", "kill-server"], { timeoutMs: 60_000 }).catch(() => undefined);
  if (signedUp) {
    const deleted = await api("DELETE", "/api/v1/auth/me").catch((error) => ({ status: String(error) }));
    log(`  cleanup DELETE /api/v1/auth/me → ${deleted.status} (${EMAIL})`);
  }
  for (const name of ["daemon.log", "daemon.log.1", "remote.log", "remote.log.1"]) {
    const from = join(HOME, ".ainecto", "term", name);
    if (existsSync(from)) cpSync(from, join(OUT, name));
  }
  for (const name of ["agent.log", "agent.log.1"]) {
    const from = join(HOME, ".ainecto", "agent", name);
    if (existsSync(from)) cpSync(from, join(OUT, name));
  }
  writeFileSync(join(OUT, "result.json"), `${JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, run: RUN, failedAt: exitCode ? step : null, results }, null, 2)}\n`);
  await browser.close();
  log(`out ${OUT}`);
  process.exit(exitCode);
}
