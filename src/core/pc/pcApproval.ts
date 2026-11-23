import { macEquals } from "../term/e2e";
import type { Approval, ApprovalRequest } from "./pcPairing";

/**
 * 다리당 하나의 «대기 중 허용»(설계 approve-new-device §3-2 5~9 · §3-3) — 등록 작업(runPairing approval)이 이미 믿는 브라우저의 결정을
 * 기다리고, 그 브라우저의 봉인 명령(device/approve)이 결정을 기록한다(사람을 기다리지 않고 바로 답한다).
 * ★결정은 T 전체에만 듣는다: 지금 대기 중인 T 와 같을 때 한 번만 소비한다. 만료된 시도의 늦은 결정·다른 후보의 결정은 stale.
 * 허용한 브라우저 키가 아직 핀에 있는지는 핀을 쓰는 갱신 안에서 다시 본다(runPairing pin).
 */

export interface PendingApproval {
  request: ApprovalRequest;
  /** 요청이 대기에 들어온 시각. */
  at: Date;
}

export type ApprovalDecision = "recorded" | "rejected" | "stale";

export class ApprovalSlot {
  private current: (PendingApproval & { settle: (approval: Approval) => void; fail: (error: Error) => void }) | undefined;

  /** 대기 중인 것이 있나. */
  get busy(): boolean {
    return this.current !== undefined;
  }

  /** 등록 작업이 결정을 기다린다. signal 이 끝나면 대기를 비우고 거절(reject)한다. 이미 대기 중이면 거절한다(다리당 하나). */
  wait(request: ApprovalRequest, at: Date, signal: AbortSignal): Promise<Approval> {
    if (this.current) return Promise.reject(new Error("Another device approval is already waiting."));
    return new Promise<Approval>((resolve, reject) => {
      const clear = (): void => {
        signal.removeEventListener("abort", onAbort);
        if (this.current?.request === request) this.current = undefined;
      };
      const onAbort = (): void => {
        clear();
        reject(new Error("The device approval ended before anyone answered."));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.current = {
        request,
        at,
        settle: (approval) => {
          clear();
          resolve(approval);
        },
        fail: (error) => {
          clear();
          reject(error);
        },
      };
    });
  }

  /** 이미 믿는 브라우저가 물어 가져갈 것 — 없으면 undefined. */
  pending(): PendingApproval | undefined {
    return this.current ? { request: this.current.request, at: this.current.at } : undefined;
  }

  /** 허용·거절 — T 가 지금 대기 중인 것과 같을 때만 한 번 소비한다. approverKeyId = 명령을 보낸 채널의 브라우저 키. */
  decide(transcript: Uint8Array, accept: boolean, approverKeyId: string): ApprovalDecision {
    const current = this.current;
    if (!current || !macEquals(current.request.transcript, transcript)) return "stale";
    current.settle(accept ? { accepted: true, approverKeyId } : { accepted: false });
    return accept ? "recorded" : "rejected";
  }

  /** 그 키를 지웠다 — 그 키가 후보인 대기면 끝낸다(허용한 쪽 키는 핀을 쓰는 갱신에서 다시 본다). 끝냈으면 true. */
  cancelInvolving(keyId: string): boolean {
    if (this.current?.request.keyId !== keyId) return false;
    this.current.fail(new Error("The device was removed while it was waiting for approval."));
    return true;
  }
}
