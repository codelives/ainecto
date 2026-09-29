#!/usr/bin/env node
/**
 * 같은 코드를 «세 이름»으로 퍼블리시한다.
 *
 *   @ai-erd/mcp   주 이름 — MCP Registry(server.json)가 가리키는 패키지. init 이 쓰는
 *                 `npx -y @ai-erd/mcp --role …` 도 이것이다(범위 뗀 이름 `mcp` = 브리지 bin).
 *   ai-erd        범위 없는 이름 — `npx -y ai-erd@latest init`. 이름과 같은 bin `ai-erd`(CLI)가 실행된다.
 *   @ai-erd/cli   에이전트가 짐작한 또 하나의 이름 — `npx -y @ai-erd/cli@latest init`.
 *                 ★이 이름만 bin 을 `{"ai-erd"}` «하나»로 줄인 매니페스트로 올린다. npx 는 범위 뗀 이름
 *                 (`cli`)과 같은 bin 을 찾고, 없으면 bin 이 하나뿐일 때 그것을 실행한다. `cli` 같은 흔한
 *                 이름의 bin 을 사용자 PATH 에 새로 깔지 않으려고 이 길을 쓴다.
 *
 * ★왜 여러 이름인가(2026-09-29 실측): 새 세션의 에이전트가 «CLI 로 설치해줘»에 npm 에서 `ai-erd`·
 *   `@ai-erd/cli` 부터 찾았고 404 를 받았다. 에이전트가 먼저 떠올리는 이름에 같은 코드가 있어야 한다.
 *
 * ★prepack(typecheck·test·build)은 «한 번만» 돈다. 예전엔 이름마다 npm publish 가 prepack 을 다시
 *   돌려, 이름이 셋이면 시험·빌드가 세 번 돌고 그 사이에 2FA 코드가 만료되기 쉬웠다. 지금은:
 *   ① 올리기 전에 prepack 을 직접 한 번 돌리고 ② dist 의 bin 파일이 «방금» 만들어졌는지(그 뒤 시각)
 *   확인한 다음 ③ 모든 이름을 `--ignore-scripts` 로 싼다. 이름을 건너뛰는 재실행에서도 ①이 돌므로
 *   «시험을 건너뛴 채 싸는 길»은 생기지 않는다. prepack 말고 다른 수명주기 스크립트는 없다.
 *
 * ★옛 이름 @ainecto/mcp 는 0.3.0 을 끝으로 올리지 않는다(2026-09-29 deprecate —
 *   "moved to @ai-erd/mcp"). ⛔unpublish 는 하지 않는다 — 옛 설정의 설치가 즉시 깨진다.
 *
 * 사용:
 *   npm run release -- --otp=123456   # 실제 퍼블리시 (2FA 코드 필요)
 *   npm run release -- --dry-run      # 무엇이 나갈지만 확인
 *
 * ★코드가 만료돼 중간에 끊기면 «새 코드로 그냥 다시» 돌리면 된다 — 이미 올라간 이름은 건너뛴다.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "package.json");
/** 주 이름. MCP Registry 와 init 이 쓰는 `npx -y @ai-erd/mcp` 가 이것이다. */
const PRIMARY_NAME = "@ai-erd/mcp";
/** 브리지 bin. 범위 뗀 주 이름(`mcp`)과 같아야 `npx -y @ai-erd/mcp` 가 브리지를 실행한다. */
const BRIDGE_BIN = "mcp";
/** 범위 없는 두 번째 이름. 코드는 같고 이름만 다르다. */
const UNSCOPED_NAME = "ai-erd";
/** 세 번째 이름. bin 을 CLI 하나로 줄인 매니페스트로 올린다. */
const CLI_NAME = "@ai-erd/cli";
/** CLI 실행 파일의 bin 이름. */
const CLI_BIN = "ai-erd";

const dryRun = process.argv.includes("--dry-run");
/** 2FA 일회용 코드. npm 은 publish 마다 요구하고 코드는 금방 만료된다. */
const otpArg = process.argv.find((a) => a.startsWith("--otp="));
const original = readFileSync(PKG, "utf8");
const parsed = JSON.parse(original);
const primaryName = parsed.name;

// ★주 이름과 브리지 bin 을 강제한다. init 이 쓰는 `.mcp.json`(`npx -y @ai-erd/mcp --role …`)과 MCP Registry 가
//   npx 의 «범위 뗀 패키지 이름 = bin» 규칙으로 `mcp` 를 실행한다 — 이 둘이 어긋나면 모든 역할 세션이 안 뜬다.
if (primaryName !== PRIMARY_NAME || !parsed.bin?.[BRIDGE_BIN]) {
  console.error(`package.json 은 name "${PRIMARY_NAME}" 와 bin "${BRIDGE_BIN}" 를 가져야 합니다 — \`npx -y ${PRIMARY_NAME}\` 이 브리지를 실행한다.`);
  process.exit(1);
}
// ★ai-erd 와 @ai-erd/cli 는 CLI bin 이 있어야 한다(npx 가 이름과 같은 bin, 또는 하나뿐인 bin 을 실행한다).
if (!parsed.bin[CLI_BIN]) {
  console.error(`package.json bin 에 "${CLI_BIN}" 가 없습니다 — \`npx ${UNSCOPED_NAME}\` · \`npx ${CLI_NAME}\` 이 CLI 를 실행하지 못합니다.`);
  process.exit(1);
}
/**
 * 이름별로 싣는 bin. ★퍼블리시할 때만 줄인다 — 저장소의 package.json 은 원본 그대로다.
 *   @ai-erd/mcp : 원본 전부 {mcp, ai-erd, ai-erd-mcp}
 *   ai-erd      : {ai-erd, ai-erd-mcp} — `mcp` 같은 흔한 이름을 이 패키지로 사용자 PATH 에 깔지 않는다.
 *                 npx 는 이름과 같은 bin(`ai-erd`)을 고르므로 동작은 같다.
 *   @ai-erd/cli : {ai-erd} 하나 — npx 는 범위 뗀 이름(`cli`)의 bin 이 없으면 하나뿐인 bin 을 실행한다.
 */
const unscopedBin = Object.fromEntries(Object.entries(parsed.bin).filter(([name]) => name !== BRIDGE_BIN));
const cliOnlyBin = { [CLI_BIN]: parsed.bin[CLI_BIN] };

/**
 * 올리기 «전에» 막힐 것을 먼저 막는다.
 *
 * ★scoped 패키지는 인증이 없거나 스코프 권한이 없으면 npm 이 404 로 답한다 —
 * 패키지 존재 여부를 숨기기 위해서다. 그래서 «로그인이 안 됐다»가 «그런 패키지 없다»로
 * 보인다(2026-09-22 실제로 그랬다). 빌드·테스트를 다 돌린 뒤 마지막에 그 404 를 보면
 * 원인을 찾는 데 시간이 든다. 여기서 먼저, 사람 말로 끊는다.
 */
function preflight() {
  let who;
  try {
    who = execFileSync("npm", ["whoami"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    console.error(
      "\n✗ npm 에 로그인돼 있지 않습니다.\n" +
        "   npm login\n" +
        "   ★scoped 패키지는 인증이 없으면 publish 가 «404» 로 실패합니다 — 스코프가 없는 것처럼 보입니다.",
    );
    process.exit(1);
  }
  console.log(`  npm 계정: ${who}`);

  const scope = primaryName.startsWith("@") ? primaryName.slice(1).split("/")[0] : null;
  if (scope && scope !== who) {
    try {
      execFileSync("npm", ["org", "ls", scope], { cwd: ROOT, stdio: "pipe" });
      console.log(`  스코프 @${scope}: 접근 가능`);
    } catch {
      console.error(
        `\n✗ 스코프 @${scope} 에 접근할 수 없습니다.\n` +
          `   npmjs.com 에서 조직 «${scope}» 을 먼저 만들고 이 계정을 멤버로 넣으세요.\n` +
          `   (개인 스코프로 쓰려면 스코프 이름이 계정명 «${who}» 과 같아야 합니다)`,
      );
      process.exit(1);
    }
  }
}

/**
 * 이미 올라간 버전이면 건너뛴다 — ★재시도를 안전하게 만드는 장치다.
 *
 * 2FA 코드는 금방 만료된다. 두 이름을 연달아 올리다 두 번째에서 코드가 만료되면,
 * 새 코드로 «다시 돌려야» 하는데 그때 첫 번째가 이미 올라가 있어 EPUBLISHCONFLICT 로
 * 막힌다. 그러면 사람이 "어디까지 됐지"를 손으로 따져야 한다. 여기서 대신 본다.
 */
function alreadyPublished(name, version) {
  try {
    // ★--prefer-online: 로컬 packument 캐시가 «아직 없음»을 답하면, 방금 올린 이름을 다시 올리려다
    //   EPUBLISHCONFLICT 로 멈춘다 — 이 함수가 막으려던 바로 그 상황이다(0.4.1 리뷰 P1).
    execFileSync("npm", ["view", `${name}@${version}`, "version", "--prefer-online"], { cwd: ROOT, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function publish(name, note = "") {
  const label = `${name}@${parsed.version}${note ? `  ${note}` : ""}`;
  if (!dryRun && alreadyPublished(name, parsed.version)) {
    console.log(`\n▶ ${label}  — 이미 올라가 있어 건너뜁니다`);
    return;
  }
  // ★--ignore-scripts: prepack 은 위에서 «한 번» 돌았고 dist 가 방금 만들어진 것임을 확인했다.
  const args = ["publish", "--access", "public", "--ignore-scripts"];
  if (dryRun) args.push("--dry-run");
  if (otpArg) args.push(otpArg);
  console.log(`\n▶ ${label}  (npm publish --access public --ignore-scripts${otpArg ? " --otp=******" : ""}${dryRun ? " --dry-run" : ""})`);
  execFileSync("npm", args, { cwd: ROOT, stdio: "inherit" });
}

/** 매니페스트를 이 이름(과 bin)으로 바꿔 쓴다. 복구는 finally 가 한다. */
function writeManifest(overrides) {
  writeFileSync(PKG, JSON.stringify({ ...parsed, ...overrides }, null, 2) + "\n");
}

/**
 * prepack(typecheck·test·build)을 한 번 돌리고, dist 의 bin 파일이 그 «뒤에» 만들어졌는지 본다.
 * 빌드가 조용히 아무것도 안 만들었는데 옛 dist 를 싸는 일을 막는다.
 */
function buildOnce() {
  const startedAt = Date.now();
  console.log("\n▶ prepack (typecheck · test · build) — 한 번만 돈다");
  execFileSync("npm", ["run", "prepack"], { cwd: ROOT, stdio: "inherit" });
  const binFiles = [...new Set(Object.values(parsed.bin))];
  for (const file of binFiles) {
    const builtAt = statSync(join(ROOT, file)).mtimeMs;
    if (builtAt < startedAt - 1000) {
      console.error(`\n✗ ${file} 가 방금 빌드되지 않았습니다(옛 파일). 퍼블리시하지 않습니다.`);
      process.exit(1);
    }
  }
  console.log(`  dist 확인: ${binFiles.join(", ")} — 방금 빌드됨`);
}

/**
 * ★Ctrl+C 에도 package.json 을 원복한다. 핸들러가 없으면 SIGINT 가 이 프로세스를 즉시 죽여 finally 가
 * 돌지 않는다 — 저장소에 다른 이름(ai-erd·@ai-erd/cli)의 매니페스트가 남는다(0.4.1 최종 리뷰 P1).
 * 핸들러를 두면: 같은 프로세스 그룹의 자식(npm)이 SIGINT 로 끝나고 → execFileSync 가 던지고 → finally 가
 * 원복한 뒤 → 130 으로 끝난다.
 */
// ⚠핸들러 «안에서» 표시만 해서는 모자란다: execFileSync 가 막고 있는 동안에는 이벤트 루프가 돌지 않아,
//   아래 판정 시점에 핸들러가 아직 안 불렸다(실측). 그래서 자식이 SIGINT 로 끝났는지(signal·130)도 본다.
let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
});
const endedBySigint = (error) => error?.signal === "SIGINT" || error?.status === 130;

let failure;
try {
  preflight();
  buildOnce();

  // 1) 주 이름 — 원본 매니페스트 그대로
  publish(primaryName);

  // 2) 범위 없는 이름 — 이름을 바꾸고 bin 에서 `mcp` 를 뺀다
  writeManifest({ name: UNSCOPED_NAME, bin: unscopedBin });
  publish(UNSCOPED_NAME, `(bin ${Object.keys(unscopedBin).join("·")} — 같은 코드)`);

  // 3) @ai-erd/cli — 이름을 바꾸고 bin 을 CLI 하나로 줄인다
  writeManifest({ name: CLI_NAME, bin: cliOnlyBin });
  publish(CLI_NAME, `(bin ${CLI_BIN} 하나 — 같은 코드)`);
} catch (error) {
  failure = error;
} finally {
  // 무슨 일이 있어도 package.json 을 원상복구한다.
  // 이게 없으면 실패·중단한 퍼블리시가 저장소에 다른 이름을 남긴다.
  writeFileSync(PKG, original);
  console.log(`\n✓ package.json 복구: name = ${primaryName}`);
}

if (interrupted || endedBySigint(failure)) {
  console.error("중단했습니다. 이미 올라간 이름은 다시 돌리면 건너뜁니다.");
  process.exit(130);
}
if (failure) {
  console.error(failure instanceof Error ? failure.message : String(failure));
  process.exit(1);
}

console.log(dryRun ? "\n(dry-run) 실제로 올리지 않았습니다." : `\n세 이름 모두 ${parsed.version} 을 퍼블리시했습니다.`);
