import { closeSync, openSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";
import { renderSuccess } from "../../core/output/render";
import { loadPcKeys, updatePcKeys, withBrowser, withoutBrowser, withPendingTurnOff, withTurnOffConfirmed, type PairedBrowser, type PcGroup } from "../../core/pc/pcKeys";
import { runPairing, type MatchedBrowser, type PairTransport } from "../../core/pc/pcPairing";
import { PairRelayError } from "../../core/pc/pcPairRelay";
import { PcCallError } from "../../core/http/pcHttp";
import { accountKey, loadPcSettings } from "../../core/pc/pcSettings";
import type { AccountSummary } from "../../core/setup/accountSummary";
import { generateSigningJwk, transcriptUserId, type EcPrivateJwk } from "../../core/term/e2e";
import type { CliIO } from "./ainectoCli";
import { promptLine, type ConfirmationIO } from "./destructiveConfirmation";
import { CliCommandError } from "./errors";

/**
 * `ainecto pair` — 웹 브라우저와 이 PC 를 PC 앞에서 코드로 짝짓는다(설계 terminal-e2e r2 §11-1·§11-4).
 *   `pair`                  대화형만 — 코드 A 를 보이고 코드 B 를 한 번 받는다. 맞으면 그 브라우저 공개키를 pc-keys.json 에 넣는다.
 *   `pair --list`           짝지은 브라우저 목록.
 *   `pair --remove <id|이름>` 그 브라우저를 지우고(keyId 가 먼저), 떠 있는 PC 연결을 완전히 끈 것을 확인한 뒤에만 성공(§13-2) — 다시 띄우지 않는다.
 * ★코드는 /dev/tty 에만 쓰고 /dev/tty 에서만 읽는다 — 파이프·리다이렉트로 흘러가지 않게. AiNecto 터미널 세션(웹 원격 화면에 실릴 수 있음)
 *   안에서는 거절한다. 이것은 «원격 화면 중계에 코드가 실리지 않는다»까지만 보장한다.
 * 순서 판단은 core/pc/pcPairing, 여기는 입출력·파일만.
 */
export interface PairDeps {
  io: CliIO;
  json: boolean;
  /** 사람이 보는 터미널인가(stdin·stdout 모두 TTY). */
  interactive: boolean;
  /** AiNecto 터미널 세션 안인가(AINECTO_TERM_SESSION). */
  insideTermSession: boolean;
  /** 코드를 주고받을 터미널 — 운영은 {@link openDevTty}. */
  openTty: () => TtyIO;
  settingsPath: string;
  keysPath: string;
  hostName: string;
  endpoint: string;
  account: () => Promise<Pick<AccountSummary, "userId">>;
  /** 서버 중계(이 PC 의 pcId 로) — 짝짓기를 시작할 때만 연다. 운영은 pcPairRelay.createPairRelay. */
  transport: (pcId: string) => PairTransport | Promise<PairTransport>;
  /** 짝짓기가 양쪽에서 끝났다(done 송신 뒤) — PC 알림(§11-7). 운영은 pcNotify.createPcNotifier. 던지지 않는다. */
  notifyPaired: (browser: { keyId: string; name: string }) => Promise<void>;
  /** 떠 있는 PC 연결과 그 프로세스 그룹(데몬을 못 쓰거나 그룹을 못 읽으면 던진다). 운영은 pcCommand.runningPcGroups. */
  findPcs: () => Promise<PcGroup[]>;
  /** 그 그룹들을 완전히 끄고 모두 끝난 것을 확인한다(못 하면 던진다). 운영은 pcCommand.turnOffPcs. */
  turnOffPcs: (groups: readonly PcGroup[]) => Promise<void>;
  /** 짝짓기 기한 — 운영은 PAIR_WAIT_MS. */
  waitMs: number;
  now: () => Date;
}

export interface TtyIO extends ConfirmationIO {
  close(): void;
}

const USAGE = "Usage: ainecto pair [--list | --remove <keyId|name>]";

/** 이 프로세스의 제어 터미널 — 없으면(데몬·CI) PAIR_NO_TTY. */
export function openDevTty(): TtyIO {
  let inFd: number | undefined;
  try {
    inFd = openSync("/dev/tty", "r");
    const outFd = openSync("/dev/tty", "w");
    const stdin = new ReadStream(inFd);
    const stderr = new WriteStream(outFd);
    return { stdin, stderr, close: () => { stdin.destroy(); stderr.destroy(); } };
  } catch (error) {
    if (inFd !== undefined) closeSync(inFd);
    throw new CliCommandError("PAIR_NO_TTY", `\`ainecto pair\` needs this PC's terminal (/dev/tty): ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function executePair(deps: PairDeps, argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (first === "--list" && rest.length === 0) {
    return await listBrowsers(deps);
  }
  if (first === "--remove" && rest.length === 1 && rest[0] !== undefined && rest[0] !== "") {
    return await removeBrowser(deps, rest[0]);
  }
  if (first !== undefined) {
    throw new CliCommandError("USAGE", USAGE);
  }
  return await pair(deps);
}

async function pair(deps: PairDeps): Promise<number> {
  if (deps.json || !deps.interactive) {
    throw new CliCommandError("PAIR_INTERACTIVE_ONLY",
      "`ainecto pair` shows a code and asks you to type the code the browser shows — run it yourself in a terminal (not with --json or a pipe).");
  }
  if (deps.insideTermSession) {
    throw new CliCommandError("PAIR_IN_TERM_SESSION",
      "`ainecto pair` does not run inside an AiNecto terminal session (its screen can be shown on the web). Run it in a regular terminal on this PC.");
  }
  const { key, userId } = await account(deps);
  const settings = await loadPcSettings(deps.settingsPath, deps.hostName);
  if (!settings.accounts[key]) {
    // pcId 는 동의할 때 pc.json 에 처음 쓰인다 — 그 전에 짝지으면 다음 실행의 pcId 와 다르다.
    throw new CliCommandError("PC_NOT_APPROVED", "This PC is not connected yet — run `ainecto` in a terminal once to approve, then `ainecto pair`.");
  }
  const pcKey = (await loadPcKeys(deps.keysPath)).accounts[key]?.pcKey ?? await generateSigningJwk();
  const transport = await deps.transport(settings.pcId);
  const tty = deps.openTty();
  let outcome: Awaited<ReturnType<typeof runPairing>>;
  try {
    outcome = await relayErrors(() => runPairing({
      userId: transcriptUserId(userId),
      pcId: settings.pcId,
      pcKey,
      transport,
      prompt: { show: (line) => { tty.stderr.write(`${line}\n`); }, ask: (question, signal) => promptLine(tty, question, signal) },
      pin: (browser) => pin(deps, key, pcKey, browser),
      waitMs: deps.waitMs,
    }));
  } finally {
    tty.close();
  }
  if (outcome.kind === "timeout") {
    throw new CliCommandError("PAIR_TIMEOUT", "No pairing finished in time. Nothing was saved — run `ainecto pair` again.");
  }
  if (outcome.kind === "cancelled") {
    throw new CliCommandError("PAIR_CANCELLED", "Pairing cancelled. Nothing was saved — run `ainecto pair` again.");
  }
  if (outcome.kind === "code-mismatch") {
    throw new CliCommandError("PAIR_CODE_MISMATCH",
      "That code does not match. Nothing was saved — start again with `ainecto pair` (if you typed it right, someone may be in the middle).");
  }
  const { browser, doneError } = outcome;
  if (doneError !== undefined) {
    throw new CliCommandError("PAIR_DONE_FAILED", `Saved "${browser.name}" on this PC, but the browser did not get the confirmation (${doneError}), `
      + `so it will not trust this PC yet. Remove it with \`ainecto pair --remove ${browser.keyId}\` and run \`ainecto pair\` again.`);
  }
  await deps.notifyPaired({ keyId: browser.keyId, name: browser.name });
  const lines = [`Paired "${browser.name}" with this PC. Remove it later with \`ainecto pair --remove ${browser.keyId}\`.`];
  if (settings.accounts[key]?.remoteTerminal !== true) {
    lines.push("Terminals from the web are blocked on this PC — `ainecto remote on` allows them.");
  }
  deps.io.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

/**
 * 코드 B 가 맞은 뒤의 핀 — 파일을 다시 읽어 넣는다.
 * ★짝짓는 동안 다른 실행이 이 계정의 PC 키를 바꿨으면 저장하지 않는다(브라우저가 받은 키와 어긋난다).
 */
async function pin(deps: PairDeps, key: string, pcKey: EcPrivateJwk, browser: MatchedBrowser): Promise<void> {
  await updatePcKeys(deps.keysPath, (latest) => {
    const stored = latest.accounts[key]?.pcKey;
    if (stored && stored.d !== pcKey.d) {
      throw new CliCommandError("PAIR_CONFLICT", "This PC's key changed while pairing (another `ainecto pair`?). Nothing was saved — run `ainecto pair` again.");
    }
    return withBrowser(latest, key, pcKey, { ...browser, pairedAt: deps.now().toISOString() });
  });
}

async function listBrowsers(deps: PairDeps): Promise<number> {
  const browsers = (await loadPcKeys(deps.keysPath)).accounts[(await account(deps)).key]?.browsers ?? [];
  const data = { browsers: browsers.map((item) => ({ keyId: item.keyId, name: item.name, pairedAt: item.pairedAt })) };
  const human = browsers.length === 0
    ? "No browsers are paired with this PC. Run `ainecto pair` to pair one."
    : ["Browsers paired with this PC:", ...browsers.map((item) => `  ${item.keyId}  ${item.name}  (paired ${item.pairedAt})`)].join("\n");
  deps.io.stdout.write(deps.json ? renderSuccess(data, { json: true }) : `${human}\n`);
  return 0;
}

/**
 * 핀을 지우고 → 떠 있는 PC 연결을 완전히 끈다(§13-2·§14-6 3). 다시 띄우지 않는다.
 *   ① 핀 삭제와 «끄기 미완료» 표지(pendingTurnOff)를 한 번에 쓴다 — 그 뒤 어디서 멈춰도 다시 실행할 단서가 남는다.
 *   ② 핀을 지운 «뒤에» 떠 있는 PC 연결과 그 프로세스 그룹을 읽는다(그 전에 뜬 다리 — 옛 핀을 읽었을 수 있다 — 는 모두 목록에 있다).
 *      못 읽으면(데몬 조회 불가·그룹 불명) 실패.
 *   ③ 끄기 «전에» 그 그룹들을 표지에 더한다 — 끈 뒤에는 데몬 목록에서 빠져 다시 찾을 수 없다.
 *   ④ 표지의 그룹을 모두 끄고 소멸까지 확인한 뒤에만 성공 — 잠금 아래 최신 표지에서 «이 실행이 끝난 것을 확인한 그룹»만 뺀다.
 *      그사이 다른 철회가 더한 그룹은 남아 그 철회(또는 재시도)가 확인한다. 남은 그룹이 없을 때만 표지가 없어진다.
 * 다시 실행하면 이름이 없어도 표지가 있으니 ②부터 — 지난 실행의 그룹(목록에서 이미 빠졌어도)의 소멸까지 확인한다.
 * 이름도 표지도 없으면 아무것도 끄지 않고 PAIR_NOT_FOUND(오타가 연결을 끄지 않게).
 */
async function removeBrowser(deps: PairDeps, keyIdOrName: string): Promise<number> {
  const { key } = await account(deps);
  let removed: PairedBrowser | undefined;
  let pending = false;
  await updatePcKeys(deps.keysPath, (keys) => {
    pending = keys.accounts[key]?.pendingTurnOff !== undefined;
    const result = withoutBrowser(keys, key, keyIdOrName);
    removed = result.removed;
    return removed ? withPendingTurnOff(result.keys, key, { at: deps.now(), groups: [] }) : undefined;
  });
  if (!removed && !pending) {
    throw new CliCommandError("PAIR_NOT_FOUND", `No paired browser with key id or name "${keyIdOrName}" — \`ainecto pair --list\` shows them.`);
  }
  let groups: PcGroup[];
  try {
    const found = await deps.findPcs();
    const saved = await updatePcKeys(deps.keysPath, (keys) => {
      const next = withPendingTurnOff(keys, key, { at: deps.now(), groups: found });
      return next === keys ? undefined : next;
    });
    groups = saved.accounts[key]?.pendingTurnOff?.groups ?? found;
    await deps.turnOffPcs(groups);
  } catch (error) {
    throw new CliCommandError("PAIR_REMOVE_STOP_FAILED", `${removed ? `Removed "${removed.name}" (${removed.keyId}), but t` : "T"}urning off the PC connection `
      + `was not confirmed (${error instanceof Error ? error.message : String(error)}). Run \`ainecto pair --remove ${keyIdOrName}\` again to finish.`);
  }
  await updatePcKeys(deps.keysPath, (keys) => {
    const next = withTurnOffConfirmed(keys, key, groups);
    return next === keys ? undefined : next;
  });
  const lines = [removed
    ? `Removed "${removed.name}" (${removed.keyId}). It can no longer open terminals on this PC.`
    : "Finished the earlier removal."];
  lines.push(groups.length > 0
    ? "Turned off the PC connection. Run `ainecto` to turn it back on."
    : "The PC connection is not running.");
  deps.io.stdout.write(deps.json
    ? renderSuccess({ removed: removed ? { keyId: removed.keyId, name: removed.name } : null, turnedOff: groups }, { json: true })
    : `${lines.join("\n")}\n`);
  return 0;
}

/** 중계 실패 → 사람이 읽는 오류(코드 그대로). 응답 줄은 공용 입구가 remote.log 에 남겼다. */
async function relayErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PairRelayError) {
      throw new CliCommandError(error.code, `${error.message} Nothing was saved — run \`ainecto pair\` again.`);
    }
    if (error instanceof PcCallError) {
      throw new CliCommandError("PAIR_RELAY_FAILED", `Could not reach AiNecto to pair (${error.op}: ${error.status ?? "-"} ${error.code ?? ""} `
        + `${error.message}`.replace(/\s+/g, " ").trim() + "). Nothing was saved — run `ainecto pair` again.");
    }
    throw error;
  }
}

/** 계정 — 저장 열쇠(`서버#userId` — pc.json 과 같은 값)와 그 userId(대화 기록에는 {@link transcriptUserId} 로 바꿔 넣는다). */
async function account(deps: PairDeps): Promise<{ key: string; userId: string }> {
  const userId = (await deps.account()).userId;
  if (!userId) {
    throw new CliCommandError("PC_ACCOUNT_UNKNOWN", "Could not read your AiNecto account — run `ainecto doctor` to see why.");
  }
  return { key: accountKey(deps.endpoint, userId), userId };
}
