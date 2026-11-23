import { randomUUID } from "node:crypto";
import { renderSuccess } from "../../core/output/render";
import {
  loadPcKeys,
  pendingRemovalOf,
  updatePcKeys,
  withBrowser,
  withoutBrowser,
  withPendingTurnOff,
  withTurnOffConfirmed,
  type PairedBrowser,
  type PcGroup,
  type PendingRemoval,
} from "../../core/pc/pcKeys";
import type { MatchedBrowser } from "../../core/pc/pcPairing";
import { accountKey } from "../../core/pc/pcSettings";
import type { AccountSummary } from "../../core/setup/accountSummary";
import type { EcPrivateJwk } from "../../core/term/e2e";
import type { CliIO } from "./ainectoCli";
import { CliCommandError } from "./errors";

/**
 * `ainecto pair` — 이 PC 에 등록한 브라우저(설계 terminal-e2e r2 §11-4 · auto-register-0.15.2).
 *   ★사람에게 보이는 말은 «브라우저 등록»(register this browser) — «짝짓기»(pair)는 명령·옵션·코드 이름에만 남긴다(KAN-1348, Ryan).
 *   `pair`                  등록하지 않는다 — «이제 `npx -y ainecto@latest` 만» 한 줄({@link PAIR_RETIRED}). 코드 비교 등록은 없다
 *                           (0.15.3 · KAN-1348 반려: 웹의 수동 등록 탭이 자동 등록 시도를 가로챘다 · Ryan «pair 안치게»). 도움말에 없다.
 *   `pair --list`           등록한 브라우저 목록(도움말에 없음 — 웹에는 PC 가 믿는 브라우저 목록·철회가 없어 지원용으로만 남긴다).
 *   `pair --remove <id|이름>` 그 브라우저를 지우고(keyId 가 먼저), 떠 있는 PC 연결을 완전히 끈 것을 확인한 뒤에만 성공(§13-2) — 다시 띄우지 않는다.
 */
export interface PairDeps {
  io: CliIO;
  json: boolean;
  settingsPath: string;
  keysPath: string;
  hostName: string;
  endpoint: string;
  account: () => Promise<Pick<AccountSummary, "userId">>;
  /** 떠 있는 PC 연결과 그 프로세스 그룹(데몬을 못 쓰거나 그룹을 못 읽으면 던진다). 운영은 pcCommand.runningPcGroups. */
  findPcs: () => Promise<PcGroup[]>;
  /** 그 그룹들을 완전히 끄고 모두 끝난 것을 확인한다(못 하면 던진다). 운영은 pcCommand.turnOffPcs. */
  turnOffPcs: (groups: readonly PcGroup[]) => Promise<void>;
  now: () => Date;
}

const USAGE = "Usage: ainecto pair [--list | --remove <keyId|name>]";
/** 맨 `pair` 의 답 — 연결·브라우저 등록·브라우저 더 등록이 모두 `npx -y ainecto@latest` 하나에서 끝난다(0.15.3). */
export const PAIR_RETIRED = "Browser registration is automatic now — just run `npx -y ainecto@latest` in this PC's terminal.";

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
  // 맨 `pair` — 등록을 진행하지 않고 한 줄로 끝낸다(Ryan «pair 안치게 해달라고» — 두 번째 길을 만들지 않는다). 옛 안내를 보고 친 사람용.
  deps.io.stdout.write(`${PAIR_RETIRED}\n`);
  return 0;
}

/**
 * 확인(자동 등록의 macB)이 맞은 뒤의 핀 — 파일을 다시 읽어 넣는다. 자동 등록(pcCommand)이 쓴다.
 * ★짝짓는 동안 다른 실행이 이 계정의 PC 키를 바꿨으면 저장하지 않는다(브라우저가 받은 키와 어긋난다).
 * ★이 브라우저(같은 keyId)의 철회가 아직 끝나지 않았으면 저장하지 않는다 — 그 철회의 완료가 이 핀의 나중 철회까지 끝난 것으로
 *   치우지 않게(리뷰 impl-4 #2). 던지면 done 을 보내지 않으니 브라우저는 PC 핀을 저장하지 않는다.
 */
export async function pinBrowser(input: { keysPath: string; key: string; pcKey: EcPrivateJwk; browser: MatchedBrowser; now: Date }): Promise<void> {
  const { key, pcKey, browser } = input;
  await updatePcKeys(input.keysPath, (latest) => {
    const stored = latest.accounts[key]?.pcKey;
    if (stored && stored.d !== pcKey.d) {
      throw new CliCommandError("PAIR_CONFLICT", "This PC's key changed during browser registration (another registration?). Nothing was saved — run `npx -y ainecto@latest` again.");
    }
    if (latest.accounts[key]?.pendingTurnOff?.removals.some((item) => item.keyId === browser.keyId)) {
      throw new CliCommandError("PAIR_REMOVE_PENDING", `This browser's earlier removal has not finished. Nothing was saved — `
        + `run \`ainecto pair --remove ${browser.keyId}\` first, then \`npx -y ainecto@latest\` again.`);
    }
    return withBrowser(latest, key, pcKey, { ...browser, pairedAt: input.now.toISOString() });
  });
}

async function listBrowsers(deps: PairDeps): Promise<number> {
  const browsers = (await loadPcKeys(deps.keysPath)).accounts[(await account(deps)).key]?.browsers ?? [];
  const data = { browsers: browsers.map((item) => ({ keyId: item.keyId, name: item.name, pairedAt: item.pairedAt })) };
  const human = browsers.length === 0
    ? "No browsers are registered with this PC. Run `npx -y ainecto@latest` to register one."
    : ["Browsers registered with this PC:", ...browsers.map((item) => `  ${item.keyId}  ${item.name}  (registered ${item.pairedAt})`)].join("\n");
  deps.io.stdout.write(deps.json ? renderSuccess(data, { json: true }) : `${human}\n`);
  return 0;
}

/**
 * 핀을 지우고 → 떠 있는 PC 연결을 완전히 끈다(§13-2·§14-6 3). 다시 띄우지 않는다.
 *   ① 핀 삭제와 «끄기 미완료» 표지(pendingTurnOff)에 이 철회(지운 브라우저 · 새 removalId)를 더하기를 한 번에 쓴다 — 그 뒤 어디서 멈춰도 다시 실행할 단서가 남는다.
 *   ② 핀을 지운 «뒤에» 떠 있는 PC 연결과 그 프로세스 그룹을 읽는다(그 전에 뜬 다리 — 옛 핀을 읽었을 수 있다 — 는 모두 목록에 있다).
 *      못 읽으면(데몬 조회 불가·그룹 불명) 실패.
 *   ③ 끄기 «전에» 그 그룹들을 표지에 더한다 — 끈 뒤에는 데몬 목록에서 빠져 다시 찾을 수 없다.
 *   ④ 표지의 그룹을 모두 끄고 소멸까지 확인한 뒤에만 성공 — 잠금 아래 최신 표지에서 «이 실행이 끝난 것을 확인한 그룹»과 이 철회(removalId)만 뺀다.
 *      그사이 다른 철회가 더한 그룹·아직 조회하지 못한 다른 철회는 남아 그 철회(또는 재시도)가 확인한다(리뷰 impl-3 #1). 같은 keyId 를 다시 짝지어
 *      새로 철회한 항목도 removalId 가 달라 남는다 — 같은 철회의 늦은 재시도가 그것을 지우지 않는다(리뷰 impl-5).
 *      그룹도 철회도 남지 않을 때만 표지가 없어진다.
 * 다시 실행하면 핀이 없어도 그 철회가 표지에 남아 있으니 그 removalId 를 이어받아 ②부터 — 지난 실행의 그룹(목록에서 이미 빠졌어도)의 소멸까지 확인한다.
 * 핀도 표지의 철회도 없으면 아무것도 끄지 않고 PAIR_NOT_FOUND(오타가 연결을 끄지 않게).
 */
async function removeBrowser(deps: PairDeps, keyIdOrName: string): Promise<number> {
  const { key } = await account(deps);
  let removed: PairedBrowser | undefined;
  let target: PendingRemoval | undefined;
  await updatePcKeys(deps.keysPath, (keys) => {
    const result = withoutBrowser(keys, key, keyIdOrName);
    removed = result.removed;
    if (!removed) {
      target = pendingRemovalOf(keys.accounts[key], keyIdOrName);
      return undefined;
    }
    target = { removalId: randomUUID(), keyId: removed.keyId, name: removed.name };
    return withPendingTurnOff(result.keys, key, { at: deps.now(), groups: [], removal: target });
  });
  if (!target) {
    throw new CliCommandError("PAIR_NOT_FOUND", `No registered browser with key id or name "${keyIdOrName}" — \`ainecto pair --list\` shows them.`);
  }
  const { keyId: finished, removalId } = target;
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
      + `was not confirmed (${error instanceof Error ? error.message : String(error)}). Run \`ainecto pair --remove ${finished}\` again to finish.`);
  }
  await updatePcKeys(deps.keysPath, (keys) => {
    const next = withTurnOffConfirmed(keys, key, { groups, removalId });
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

/** 계정 — 저장 열쇠(`서버#userId` — pc.json 과 같은 값)와 그 userId. */
async function account(deps: PairDeps): Promise<{ key: string; userId: string }> {
  const userId = (await deps.account()).userId;
  if (!userId) throw accountUnknown();
  return { key: accountKey(deps.endpoint, userId), userId };
}

function accountUnknown(): CliCommandError {
  return new CliCommandError("PC_ACCOUNT_UNKNOWN", "Could not read your AiNecto account — run `ainecto doctor` to see why.");
}
