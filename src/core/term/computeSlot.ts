import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import headless from "@xterm/headless";
import { ensurePrivateDir } from "../fs/privateFiles";
import { compute as builtIn, type ComputeCheck, type ComputeModule, type ComputeView } from "./compute";
import { trackScreenFlags } from "./screen";
import { XTERM_VERSION } from "./xtermVersion";

/**
 * holder 의 계산 모듈 자리(세션 유지 구조 설계 3-2) — 처음엔 holder 에 묶여 온 compute.ts, 바깥이 «내 설치본의 이 파일»을 알리면
 * 그 파일을 복사해 불러와 ★스스로 확인한 뒤에만 바꾼다. 열린 세션은 계산할 때마다 이 자리의 지금 모듈을 쓴다(session.ts).
 *   복사 경로 = `<computeDir>/<내용 지문>/compute.mjs` — 같은 경로를 다시 import 하면 옛 모듈이 돌아오므로(r3 리뷰 실측) 내용마다 다른 경로.
 *   확인 = 적힌 xterm 판이 holder 의 것 · 요구 화면 칸이 {@link COMPUTE_VIEW} 안 · 자기 시험 전부 통과. 아니면 지금 모듈 그대로 + 이유.
 * 불러온 뒤에는 파일이 지워져도 상관없다(이미 메모리에 있다). 같은 프로세스라 멈춘 동기 계산은 끊지 못한다(설계가 받아들인 한계).
 */

/** holder 가 계산 함수에 넘길 수 있는 화면 칸(compute.ComputeView) — ★추가만(holder 말과 같은 규칙). */
export const COMPUTE_VIEW: readonly string[] = ["terminal", "flags.cursorVisible", "flags.sgrMouse"];

/** 바깥이 알린 모듈에 대한 답 — 바꿨는가 · 지금 쓰는 모듈의 판 · 안 바꾼 이유. */
export type ComputeOffer =
  | { switched: true; version: string; digest: string }
  | { switched: false; version: string; reason: string };

export class ComputeSlot {
  private active: { module: ComputeModule; digest?: string } = { module: builtIn };

  constructor(private readonly dir: string) {}

  /** 지금 쓰는 모듈 — 세션이 계산할 때마다 부른다. */
  get module(): ComputeModule {
    return this.active.module;
  }

  /** 기능 묻기(caps)에 싣는 것 — 지금 모듈의 판 · 불러온 파일의 지문(묶여 온 것이면 없음). */
  describe(): { version: string; digest?: string } {
    return { version: this.active.module.version, ...(this.active.digest !== undefined ? { digest: this.active.digest } : {}) };
  }

  /** holder 가 뜰 때 — 옛 holder 의 사본을 치운다(holder 는 PC 에 한 벌이고 잠금을 쥔 뒤에만 여기 온다 — 쓰는 다른 holder 가 없다). */
  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  async offer(file: string): Promise<ComputeOffer> {
    const bytes = await readFile(file);
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const kept = (reason: string): ComputeOffer => ({ switched: false, version: this.active.module.version, reason });
    if (digest === this.active.digest) return kept("already active");
    const folder = join(this.dir, digest);
    const copy = join(folder, "compute.mjs");
    await ensurePrivateDir(folder);
    await writeFile(copy, bytes, { mode: 0o600 });
    let candidate: unknown;
    try {
      candidate = (await import(pathToFileURL(copy).href) as { compute?: unknown }).compute;
    } catch (error) {
      return kept(`could not load ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const reason = await rejectReason(candidate);
    if (reason !== undefined) return kept(reason);
    const module = candidate as ComputeModule;
    this.active = { module, digest };
    return { switched: true, version: module.version, digest };
  }
}

/** 이 holder 가 받을 수 없는 이유 — 받을 수 있으면 undefined. */
export async function rejectReason(candidate: unknown, xterm: string = XTERM_VERSION, view: readonly string[] = COMPUTE_VIEW): Promise<string | undefined> {
  const shape = moduleShapeProblem(candidate);
  if (shape !== undefined) return shape;
  const module = candidate as ComputeModule;
  if (module.xterm !== xterm) return `the module was built for xterm ${module.xterm}, this holder runs xterm ${xterm}`;
  const missing = module.needs.filter((need) => !view.includes(need));
  if (missing.length > 0) return `the module needs screen fields this holder does not pass: ${missing.join(", ")}`;
  if (module.checks.length === 0) return "the module has no self-checks";
  for (const check of module.checks) {
    const failed = await runCheck(module, check);
    if (failed !== undefined) return `self-check "${check.name}" failed: ${failed}`;
  }
  return undefined;
}

/** 자기 시험 한 장 — 이 holder 의 xterm·파서 훅으로 화면을 그려 모듈의 답을 기댓값과 견준다. 어긋난 곳(없으면 undefined). */
export async function runCheck(module: ComputeModule, check: ComputeCheck): Promise<string | undefined> {
  const terminal = new headless.Terminal({ cols: check.cols, rows: check.rows, allowProposedApi: true });
  try {
    const flags = trackScreenFlags(terminal);
    await new Promise<void>((resolve) => terminal.write(check.output, resolve));
    const view: ComputeView = { terminal, flags };
    const differs = (what: string, actual: unknown, expected: unknown): string | undefined =>
      isDeepStrictEqual(actual, expected) ? undefined : `${what} gave ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
    const problems = [
      check.read && differs("read", module.read(view, check.read.range), check.read.lines),
      check.styled && differs("readStyled", module.readStyled(view, check.styled.range), check.styled.screen),
      check.modes && differs("modes", module.modes(view), check.modes),
      ...Object.entries(check.keys ?? {}).map(([name, bytes]) => differs(`key ${name}`, module.key(view, name) ?? null, bytes)),
      check.paste && differs("paste", module.paste(view, check.paste.text), check.paste.bytes),
      check.reset !== undefined ? differs("reset", module.reset(view), check.reset) : undefined,
    ];
    return problems.find((problem): problem is string => typeof problem === "string");
  } catch (error) {
    return `threw ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    terminal.dispose();
  }
}

function moduleShapeProblem(candidate: unknown): string | undefined {
  if (!candidate || typeof candidate !== "object") return "the file does not export a compute module";
  const value = candidate as Record<string, unknown>;
  for (const field of ["version", "xterm"]) {
    if (typeof value[field] !== "string") return `the module has no ${field}`;
  }
  if (!Array.isArray(value.needs) || !value.needs.every((need) => typeof need === "string")) return "the module has no needs list";
  if (!Array.isArray(value.checks)) return "the module has no checks";
  for (const fn of ["read", "readStyled", "modes", "key", "paste", "reset"]) {
    if (typeof value[fn] !== "function") return `the module has no ${fn}()`;
  }
  return undefined;
}
