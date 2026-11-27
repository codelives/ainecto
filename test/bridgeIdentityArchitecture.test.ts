import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * 아키텍처 시험 — 세션 종류(브리지인가)는 인자·이름으로 짐작하지 않는다(설계 term-daemon-upgrade-keep-sessions G1 · 원칙 1).
 *   B1 명령 인자로 `pc` `run` 을 맞춰 보는 판정은 bridgeKind.ts 한 곳뿐 — 칸 없는 옛 데몬 목록의 대체 판정(prep 메모 2절 1).
 *   B2 holder·바깥 프로세스는 그 대체 판정을 들이지 않는다 — holder 는 만들 때 종류를 붙이므로(비면 user) 짐작할 일이 없다.
 */
const SRC = resolve(__dirname, "..", "src");
const BRIDGE_KIND = "core/pc/bridgeKind.ts";

function sources(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

function rel(path: string): string {
  return relative(SRC, path).split(sep).join("/");
}

const FILES = new Map(sources().map((path) => [rel(path), readFileSync(path, "utf8")]));

/**
 * 세션의 명령(`command`)을 "pc"·"run" 과 견주는 줄이 있는가 — 만드는 줄(`["pc", "run"]`)과 이 CLI 자기 인자의 명령 고르기
 * (`domain === "pc" && action === "run"`)는 아니다.
 */
export function comparesPcRunWord(text: string): boolean {
  return text.split("\n").some((line) => /\bcommand\b/.test(line)
    && /(?:===?|!==?)\s*["'](?:pc|run)["']|["'](?:pc|run)["']\s*(?:===?|!==?)/.test(line));
}

/** 상대 경로 import 를 따라간 닫힘(이 파일 포함 · `import type` 도 센다 — 종류 판정 함수를 들이는 길을 다 막는다). */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file) || !FILES.has(file)) return;
    seen.add(file);
    for (const match of (FILES.get(file) ?? "").matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = rel(resolve(SRC, dirname(file), match[1] ?? ""));
      visit(target.endsWith(".ts") ? target : `${target}.ts`);
    }
  };
  visit(entry);
  return seen;
}

describe("세션 종류는 인자·이름으로 짐작하지 않는다(G1)", () => {
  it("B1 — 명령 인자의 pc·run 을 견주는 곳은 bridgeKind.ts 하나", () => {
    expect(comparesPcRunWord('word === "pc" && command[index + 1] === "run"')).toBe(true);
    expect(comparesPcRunWord('const args = ["pc", "run"];')).toBe(false);
    expect(comparesPcRunWord('return domain === "pc" && action === "run";')).toBe(false);
    const found = [...FILES].filter(([, text]) => comparesPcRunWord(text)).map(([file]) => file);
    expect(found).toEqual([BRIDGE_KIND]);
  });

  it("B2 — holder·바깥(term holder · term daemon)의 import 닫힘에 bridgeKind 가 없다", () => {
    for (const entry of ["core/term/holder.ts", "core/term/daemon.ts"]) {
      const closure = importClosure(entry);
      expect(closure.size, entry).toBeGreaterThan(3);
      expect([...closure].filter((file) => file === BRIDGE_KIND), entry).toEqual([]);
    }
  });
});
