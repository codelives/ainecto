#!/usr/bin/env node
/**
 * 같은 코드를 «두 이름»으로 퍼블리시한다.
 *
 *   @ai-erd/mcp    새 이름 — 앞으로 안내하는 것
 *   @ainecto/mcp   옛 이름 — 이미 각자 PC 의 claude/codex 설정에 적어둔 사람들이 있다
 *
 * ★옛 이름을 끊지 않는 이유: 우리가 그 사용자들을 부를 방법이 없다. MCP 엔드포인트를
 *   ainecto.com 에 남겨둔 것과 같은 판단이다(전환 계획서 §4-2).
 *   충분히 지난 뒤에는 publish 를 멈추는 대신 `npm deprecate` 로 안내만 남긴다.
 *   ⛔unpublish 는 하지 않는다 — 설치가 즉시 깨진다.
 *
 * 사용:
 *   npm run publish:both              # 실제 퍼블리시 (npm 로그인 필요)
 *   npm run publish:both -- --dry-run # 무엇이 나갈지만 확인
 *
 * 전제: `@ai-erd` 스코프가 npm 에 존재해야 한다(조직 스코프는 계정에서 먼저 만든다).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "package.json");
const LEGACY_NAME = "@ainecto/mcp";

const dryRun = process.argv.includes("--dry-run");
const original = readFileSync(PKG, "utf8");
const parsed = JSON.parse(original);
const primaryName = parsed.name;

if (primaryName === LEGACY_NAME) {
  console.error(`package.json 의 name 이 아직 ${LEGACY_NAME} 입니다. 주 이름을 새 이름으로 두세요.`);
  process.exit(1);
}

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

function publish(label) {
  const args = ["publish", "--access", "public"];
  if (dryRun) args.push("--dry-run");
  console.log(`\n▶ ${label}  (npm ${args.join(" ")})`);
  execFileSync("npm", args, { cwd: ROOT, stdio: "inherit" });
}

preflight();

try {
  // 1) 새 이름 — prepack 이 typecheck·test·build 를 돌린다
  publish(primaryName);

  // 2) 옛 이름 — 이름만 바꿔 같은 산출물을 한 번 더 올린다
  //    ★prepack 을 다시 돌리지 않도록 --ignore-scripts 는 쓰지 않는다.
  //      같은 dist 를 그대로 싸는 것이 목적이므로 재빌드돼도 결과는 같다.
  writeFileSync(PKG, JSON.stringify({ ...parsed, name: LEGACY_NAME }, null, 2) + "\n");
  publish(`${LEGACY_NAME}  (옛 이름 — 호환용)`);
} finally {
  // 3) 무슨 일이 있어도 package.json 을 원상복구한다.
  //    이게 없으면 실패한 퍼블리시가 저장소에 옛 이름을 남긴다.
  writeFileSync(PKG, original);
  console.log(`\n✓ package.json 복구: name = ${primaryName}`);
}

console.log(
  dryRun
    ? "\n(dry-run) 실제로 올리지 않았습니다."
    : "\n두 이름 모두 퍼블리시했습니다. 옛 이름 안내를 남기려면:\n" +
      `  npm deprecate ${LEGACY_NAME} "moved to ${primaryName} — same code, new name"`,
);
