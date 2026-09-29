#!/usr/bin/env node
/**
 * @ai-erd/mcp 를 퍼블리시한다.
 *
 * ★옛 이름 @ainecto/mcp 는 0.3.0 을 끝으로 올리지 않는다(2026-09-29 deprecate —
 *   "moved to @ai-erd/mcp"). ⛔unpublish 는 하지 않는다 — 옛 설정의 설치가 즉시 깨진다.
 *
 * 사용:
 *   npm run release -- --otp=123456   # 실제 퍼블리시 (2FA 코드 필요)
 *   npm run release -- --dry-run      # 무엇이 나갈지만 확인
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { name, version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const dryRun = process.argv.includes("--dry-run");
/** 2FA 일회용 코드. npm 은 publish 마다 요구하고 코드는 금방 만료된다. */
const otpArg = process.argv.find((a) => a.startsWith("--otp="));

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

  const scope = name.startsWith("@") ? name.slice(1).split("/")[0] : null;
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

preflight();

// prepack 이 typecheck·test·build 를 돌린다
const args = ["publish", "--access", "public"];
if (dryRun) args.push("--dry-run");
if (otpArg) args.push(otpArg);
console.log(`\n▶ ${name}@${version}  (npm publish --access public${otpArg ? " --otp=******" : ""}${dryRun ? " --dry-run" : ""})`);
execFileSync("npm", args, { cwd: ROOT, stdio: "inherit" });

console.log(dryRun ? "\n(dry-run) 실제로 올리지 않았습니다." : `\n${name}@${version} 을 퍼블리시했습니다.`);
