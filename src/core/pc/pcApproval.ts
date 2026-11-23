import { macEquals } from "../term/e2e";
import type { ApprovalRequest } from "./pcPairing";

/**
 * 다리당 하나의 «대기 중 허용»(설계 approve-new-device §3-2 5~8 · §3-3) — 등록 작업(runPairing approval)이 허용을 기다리고,
 * 이미 믿는 브라우저의 봉인 명령(device/approve)이 그 대기를 푼다.
 * ★허용은 T 전체에만 듣는다: 지금 대기 중인 T 와 같을 때 한 번만 소비한다. 만료된 시도의 늦은 허용·다른 후보의 허용은 stale.
 * 허용을 보낸 브라우저 키가 아직 핀에 있는지는 부르는 쪽(다리)이 decide 직전에 본다.
 */

export interface PendingApproval {
  request: ApprovalRequest;
  /** 요청이 대기에 들어온 시각. */
  at: Date;
}

export type ApprovalDecision = "accepted" | "rejected" | "stale";

export class ApprovalSlot {
  private current: (PendingApproval & { settle: (accept: boolean) => void }) | undefined;

  /** 대기 중인 것이 있나 — 있으면 새 요청을 받지 않는다(다리당 하나). */
  get busy(): boolean {
    return this.current !== undefined;
  }

  /** 등록 작업이 허용을 기다린다 — 허용 true · 거절 false. signal 이 끝나면 대기를 비우고 거절(reject)한다. */
  wait(request: ApprovalRequest, at: Date, signal: AbortSignal): Promise<boolean> {
    if (this.current) return Promise.reject(new Error("Another device approval is already waiting."));
    return new Promise<boolean>((resolve, reject) => {
      const onAbort = (): void => {
        if (this.current?.request === request) this.current = undefined;
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
        settle: (accept) => {
          signal.removeEventListener("abort", onAbort);
          resolve(accept);
        },
      };
    });
  }

  /** 이미 믿는 브라우저가 물어 가져갈 것 — 없으면 undefined. */
  pending(): PendingApproval | undefined {
    return this.current ? { request: this.current.request, at: this.current.at } : undefined;
  }

  /** 허용·거절 — T 가 지금 대기 중인 것과 같을 때만 한 번 소비한다. */
  decide(transcript: Uint8Array, accept: boolean): ApprovalDecision {
    const current = this.current;
    if (!current || !macEquals(current.request.transcript, transcript)) return "stale";
    this.current = undefined;
    current.settle(accept);
    return accept ? "accepted" : "rejected";
  }
}
