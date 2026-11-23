import { NOTIFY_BATCH_MS } from "./pcNotify";
import { ApprovalSlot } from "./pcApproval";
import { loadPcKeys, updatePcKeys, withBrowser, type PcKeys } from "./pcKeys";
import { PAIR_WAIT_MS, runPairing, type MatchedBrowser, type PairOutcome, type PairTransport } from "./pcPairing";
import { transcriptUserId, type EcPrivateJwk } from "../term/e2e";
import type { ChannelBrowser, DeviceAction } from "../term/remoteChannel";
import type { RemoteLogRecord } from "../term/remote";

/**
 * 다리 안의 기기 관리(설계 approve-new-device §3-1 · §3-6) — 새 기기 허용 요청 하나를 백그라운드로 돌리고(다리 루프를 막지 않는다),
 * 이미 믿는 브라우저의 봉인 명령(device/pending·approve·list·remove)에 답한다.
 *
 * <pre>
 * 요청      poll 의 pair-request → 원격 켜짐 · 믿는 브라우저 ≥1 · 진행 중 없음 · 거절·취소 뒤 1분(NOTIFY_BATCH_MS) 지남 → 등록 작업 하나
 * 등록      runPairing(approval) — 양쪽 동의 뒤 핀은 핀 파일 갱신 하나 안에서 «허용한 키가 아직 있음»을 다시 보고 쓴다
 * 지우기    keyId 로만 · 먼저 «지움» 표시(그 뒤 시작된 등록만 그 키를 쓸 수 있다)·그 키가 후보인 대기 끝내기 → 핀 삭제 → 그 키의 채널 닫기 → 답
 *          ★핀을 쓰는 등록은 같은 핀 파일 잠금 안에서 «지움» 표시를 본다 — 지우는 사이 승인이 그 키를 되살리지 못한다
 * </pre>
 * 다리는 PC 에 하나다(로컬 잠금 — pcRemote) — 그래서 여기서 지운 것이 이 키 파일의 마지막 말이다.
 */

export interface DeviceManagerDeps {
  keysPath: string;
  /** pc-keys.json 의 계정 열쇠(pcSettings.accountKey). */
  accountKey: string;
  /** 계정 userId(대화 기록에는 소문자로). */
  userId: string;
  pcId: string;
  /** 그 요청의 등록 중계(pcPairRelay — requestId 로 연다). */
  relay(requestId: string): PairTransport;
  /** PC OS 알림 — 새 기기가 허용을 기다린다(이름 · PC 당 묶음). */
  notifyRequest(name: string): void;
  log(record: RemoteLogRecord): void;
  /** 그 브라우저 키의 채널을 모두 닫는다(연결 중·활성 · 대기 명령·화면 구독까지). */
  closeKey(keyId: string): Promise<void>;
  /** 원격이 지금 켜져 있나(PC 설정 + 서버 poll). */
  remoteOn(): boolean;
  now?: () => Date;
  waitMs?: number;
}

export class DeviceManager {
  private readonly slot = new ApprovalSlot();
  private running: { requestId: string; stop: AbortController } | undefined;
  private quietUntil = 0;
  /** keyId → 지운 시각(ms). 그보다 먼저 시작한 등록은 그 키를 쓰지 못한다(다시 요청하면 새 등록이라 쓸 수 있다). */
  private readonly removedAt = new Map<string, number>();
  private readonly now: () => Date;

  constructor(private readonly deps: DeviceManagerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** poll 의 pair-request — 받을 수 있으면 등록 작업을 백그라운드로 시작한다(기다리지 않는다). */
  async onPairRequest(requestId: string): Promise<void> {
    const refuse = (reason: string): void => this.deps.log({ event: "pc_device", step: "request", requestId, result: "ignored", reason });
    if (!this.deps.remoteOn()) return refuse("remote-off");
    if (this.running) return refuse("busy");
    if (this.now().getTime() < this.quietUntil) return refuse("quiet");
    const account = await this.account();
    if (!account || account.browsers.length === 0) return refuse("no-trusted-browser");
    const stop = new AbortController();
    this.running = { requestId, stop };
    this.deps.log({ event: "pc_device", step: "request", requestId, result: "started" });
    void this.pair(requestId, account.pcKey, stop).finally(() => {
      // ★자기 작업만 지운다 — 늦게 끝난 앞 작업이 다음 요청을 지우지 않는다.
      if (this.running?.requestId === requestId) this.running = undefined;
    });
  }

  /** 다리 끝·원격 꺼짐·링크 다시 열기 — 진행 중 등록을 끝낸다(abort 를 보낸다). */
  stop(): void {
    this.running?.stop.abort();
  }

  /** 이미 믿는 브라우저의 봉인 명령 하나 — 봉인 답의 result. browser = 명령을 보낸 채널의 브라우저. */
  async command(action: DeviceAction, browser: ChannelBrowser): Promise<Record<string, unknown>> {
    switch (action.action) {
      case "pending": {
        const pending = this.slot.pending();
        return {
          request: pending
            ? { T: b64u(pending.request.transcript), code: pending.request.code, name: pending.request.name, at: pending.at.toISOString() }
            : null,
        };
      }
      case "approve": {
        const result = this.slot.decide(action.transcript, action.accept, browser.keyId);
        this.deps.log({ event: "pc_device", step: "approve", keyId: browser.keyId, result });
        return { result };
      }
      case "list": {
        const account = await this.account();
        return {
          devices: (account?.browsers ?? []).map((item) => ({ keyId: item.keyId, name: item.name, pairedAt: item.pairedAt,
            current: item.keyId === browser.keyId })),
        };
      }
      case "remove": {
        // ★표시·대기 끝내기를 먼저 — 그 뒤의 핀 갱신(같은 잠금)이 진행 중 등록보다 늦게 와도 그 등록은 이 키를 쓰지 못한다.
        this.removedAt.set(action.keyId, this.now().getTime());
        this.slot.cancelInvolving(action.keyId);
        let removed = false;
        await updatePcKeys(this.deps.keysPath, (keys) => {
          const account = keys.accounts[this.deps.accountKey];
          if (!account?.browsers.some((item) => item.keyId === action.keyId)) return undefined;
          removed = true;
          // ★keyId 로만 — 이름으로 다시 찾지 않는다.
          return { accounts: { ...keys.accounts, [this.deps.accountKey]: { ...account,
            browsers: account.browsers.filter((item) => item.keyId !== action.keyId) } } };
        });
        await this.deps.closeKey(action.keyId);
        this.deps.log({ event: "pc_device", step: "remove", keyId: action.keyId, result: removed ? "removed" : "absent" });
        return { removed };
      }
    }
  }

  private async pair(requestId: string, pcKey: EcPrivateJwk, stop: AbortController): Promise<void> {
    let outcome: PairOutcome | undefined;
    let reason: string | undefined;
    const startedAt = this.now().getTime();
    try {
      outcome = await runPairing({
        userId: transcriptUserId(this.deps.userId),
        pcId: this.deps.pcId,
        pcKey,
        transport: this.deps.relay(requestId),
        confirm: {
          kind: "approval",
          approve: (request, signal) => {
            this.deps.notifyRequest(request.name);
            this.deps.log({ event: "pc_device", step: "waiting", requestId, keyId: request.keyId });
            return this.slot.wait(request, this.now(), signal);
          },
        },
        pin: async (browser, approverKeyId) =>
          await this.pinApproved(browser, approverKeyId, pcKey, this.now().toISOString(), startedAt, stop.signal),
        waitMs: this.deps.waitMs ?? PAIR_WAIT_MS,
        cancel: stop.signal,
      });
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    // ★done 을 못 보냈다는 것은 PC 쪽 응답만 잃었을 수도 있다(새 기기는 받았을 수 있다) — 양쪽이 동의한 핀은 되돌리지 않는다.
    // 새 기기가 정말 못 받았으면 그 기기는 PC 를 아직 믿지 않으니 다시 요청한다(같은 키 덮어쓰기).
    if (outcome?.kind === "paired" && outcome.doneError !== undefined) reason = outcome.doneError;
    const result = outcome === undefined ? "error" : outcome.kind === "paired" && outcome.doneError !== undefined ? "done-failed" : outcome.kind;
    if (result !== "paired" && result !== "timeout") this.quietUntil = this.now().getTime() + NOTIFY_BATCH_MS;
    this.deps.log({ event: "pc_device", step: "finished", requestId, result, ...(outcome?.kind === "paired" ? { keyId: outcome.browser.keyId } : {}),
      ...(reason ? { reason } : {}) });
  }

  /** 양쪽 동의 뒤 — 같은 갱신 안에서 «허용한 키가 아직 있음 · PC 키 그대로»를 다시 보고 쓴다. 아니면 false(핀 0). */
  private async pinApproved(browser: MatchedBrowser, approverKeyId: string | undefined, pcKey: EcPrivateJwk, pairedAt: string,
    startedAt: number, stopped: AbortSignal): Promise<boolean> {
    let pinned = false;
    const deadline = startedAt + (this.deps.waitMs ?? PAIR_WAIT_MS);
    await updatePcKeys(this.deps.keysPath, (keys) => {
      // 잠금을 기다리는 사이 끝났다(기한·다리 끝·원격 꺼짐·새 링크) — 쓰지 않는다.
      if (stopped.aborted || this.now().getTime() >= deadline) return undefined;
      // 이 등록이 시작한 뒤 후보·허용한 키를 지웠으면 쓰지 않는다.
      if ((this.removedAt.get(browser.keyId) ?? -1) >= startedAt) return undefined;
      if (approverKeyId !== undefined && (this.removedAt.get(approverKeyId) ?? -1) >= startedAt) return undefined;
      const account = keys.accounts[this.deps.accountKey];
      if (!account || account.pcKey.d !== pcKey.d || !account.browsers.some((item) => item.keyId === approverKeyId)) return undefined;
      if (account.pendingTurnOff?.removals.some((item) => item.keyId === browser.keyId)) return undefined;
      pinned = true;
      return withBrowser(keys, this.deps.accountKey, pcKey, { ...browser, pairedAt });
    });
    return pinned;
  }

  private async account(): Promise<PcKeys["accounts"][string] | undefined> {
    try {
      return (await loadPcKeys(this.deps.keysPath)).accounts[this.deps.accountKey];
    } catch {
      return undefined;
    }
  }
}

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
