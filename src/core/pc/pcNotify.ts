import { notifyTool, runQuiet } from "../os/launch";
import type { DaemonLog } from "../term/daemonLog";
import type { RemoteLogRecord } from "../term/remote";

/**
 * PC 알림 — 서버가 침해됐을 때의 사후 경보(설계 terminal-e2e §4-6 · §11-7 · Ryan 11-21 «PC 알림 주는 정도로만 하자»). 새 의존성 0.
 *   macOS   osascript — 고정 스크립트(`on run argv`)에 제목·본문을 «데이터 인자»로만 넘긴다(셸 문자열 조립 없음)
 *   Linux   notify-send — 인자 배열(`--` 뒤)
 *   그 밖    알림 없음 — 로그 한 줄(Windows 는 이번에 로그만)
 * ★알리는 것은 PC 가 로컬에서 확인한 사건뿐(§11-7): 짝짓기 완료(done 송신 뒤) · 새 채널 키 소유 확인(confirm 복호 뒤) ·
 *   데몬이 실제로 셸을 만든 뒤 · 첫 명령이 시작된 뒤. hello 수신만으로는 알리지 않는다. 서버 메시지를 믿지 않는다.
 * ★문구에 명령 원문·폴더·화면·코드·키를 넣지 않는다. 실패(도구 없음·권한·헤드리스)는 이유 코드 한 줄만 남기고 동작을 막지 않는다(stderr 원문 없음).
 * 묶음(C-E3 60초): 같은 브라우저 키·같은 종류의 «첫 사건»은 바로 알리고, 그 뒤 60초 안의 것은 모았다가 60초가 차면 마지막 것 하나에 «외 n건».
 */

/** C-E3(Ryan 11-21 승인) — 같은 브라우저·같은 종류의 알림을 묶는 간격. */
export const NOTIFY_BATCH_MS = 60_000;

export type NotifyKind = "paired" | "session" | "shell" | "command";

export interface NotifyEvent {
  kind: NotifyKind;
  /** 브라우저 키 id(지문) — 묶음 열쇠. 알림 글에는 넣지 않는다. */
  keyId: string;
  /** 짝짓기 때 PC 가 저장한 이름(pc-keys.json — 40자·제어 문자 없음). */
  browserName: string;
  at: Date;
}

const WHAT: Record<NotifyKind, string> = {
  paired: "was paired with this PC",
  session: "opened a terminal connection to this PC",
  shell: "started a new shell on this PC",
  command: "started a command in a new terminal on this PC",
};

/** 알림 글(순수) — 명령·폴더 없음. more = 묶여서 따로 알리지 않은 같은 종류의 수. */
export function notificationText(event: NotifyEvent, more: number): { title: string; body: string } {
  const time = `${String(event.at.getHours()).padStart(2, "0")}:${String(event.at.getMinutes()).padStart(2, "0")}`;
  return {
    title: "AiNecto",
    body: `${event.browserName} ${WHAT[event.kind]} — ${time}${more > 0 ? ` (+${more} more)` : ""}. Not you? Run \`ainecto remote off\`.`,
  };
}

/** 시계·타이머 — 시험만 바꾼다. */
export interface NotifyClock {
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

const systemClock: NotifyClock = {
  now: () => Date.now(),
  setTimer: (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

/**
 * 묶음(순수 상태 기계 + 주입한 시계) — show 를 부르는 때만 정한다. 첫 사건은 바로 · 창(C-E3) 안의 후속은 창이 끝날 때 마지막 것 하나로(+n).
 * flush = 모아 둔 것을 지금 알린다(다리가 끝날 때 — 모은 경보를 버리지 않는다).
 */
export class NotifyBatcher {
  private readonly slots = new Map<string, { endsAt: number; pending: { event: NotifyEvent; count: number } | undefined; timer: unknown }>();

  constructor(
    private readonly show: (event: NotifyEvent, more: number) => void,
    private readonly clock: NotifyClock = systemClock,
  ) {}

  add(event: NotifyEvent): void {
    const key = `${event.keyId}\u0000${event.kind}`;
    const now = this.clock.now();
    const slot = this.slots.get(key);
    if (!slot || now >= slot.endsAt) {
      this.show(event, 0);
      this.slots.set(key, { endsAt: now + NOTIFY_BATCH_MS, pending: undefined, timer: undefined });
      return;
    }
    slot.pending = { event, count: (slot.pending?.count ?? 0) + 1 };
    slot.timer ??= this.clock.setTimer(() => this.close(key), slot.endsAt - now);
  }

  flush(): void {
    for (const [key, slot] of this.slots) {
      if (slot.timer !== undefined) this.clock.clearTimer(slot.timer);
      if (slot.pending) this.show(slot.pending.event, slot.pending.count - 1);
      this.slots.delete(key);
    }
  }

  private close(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.timer = undefined;
    if (!slot.pending) return;
    const { event, count } = slot.pending;
    slot.pending = undefined;
    slot.endsAt = this.clock.now() + NOTIFY_BATCH_MS;
    this.show(event, count - 1);
  }
}

export interface PcNotifier {
  /** 사건 하나 — 바로 알렸으면 그 도구가 끝날 때 풀린다(묶였으면 바로). 던지지 않는다. */
  notify(event: Omit<NotifyEvent, "at">): Promise<void>;
  /** 모아 둔 알림을 지금 — 다리가 끝날 때. */
  flush(): Promise<void>;
}

/** OS 도구 실행 — 끝난 상태만(출력·stderr 원문은 받지 않는다). 실패하면 이유 코드로 던진다. */
export type NotifyRun = (file: string, args: string[]) => Promise<void>;


/** 실행 실패 → 이유 코드(순수) — 원문 메시지·stderr 는 남기지 않는다. */
export function notifyFailureReason(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; signal?: unknown };
    if (value.code === "ENOENT") return "not-found";
    if (value.code === "EACCES") return "no-permission";
    if (typeof value.signal === "string" && value.signal !== "") return "signal";
    if (typeof value.code === "number") return `exit-${value.code}`;
  }
  return "failed";
}

/** 운영 알림 — 로그는 remote.log(알림 1줄 + 결과 1줄). */
export function createPcNotifier(input: { log: DaemonLog<RemoteLogRecord>; platform?: NodeJS.Platform; run?: NotifyRun; clock?: NotifyClock }): PcNotifier {
  const tool = notifyTool(input.platform);
  const run = input.run ?? runQuiet;
  const clock = input.clock ?? systemClock;
  let last: Promise<void> = Promise.resolve();
  const show = (event: NotifyEvent, more: number): void => {
    input.log.write({ event: "pc_notify", kind: event.kind, browserKeyId: event.keyId, more, tool: tool?.name ?? "none" });
    if (!tool) {
      input.log.write({ event: "pc_notify_result", kind: event.kind, ok: false, tool: "none", reason: "no-tool-on-this-os" });
      last = Promise.resolve();
      return;
    }
    const { title, body } = notificationText(event, more);
    last = run(tool.file, tool.args(title, body)).then(
      () => input.log.write({ event: "pc_notify_result", kind: event.kind, ok: true, tool: tool.name }),
      (error: unknown) => input.log.write({ event: "pc_notify_result", kind: event.kind, ok: false, tool: tool.name, reason: notifyFailureReason(error) }),
    );
  };
  const batcher = new NotifyBatcher(show, clock);
  return {
    async notify(event) {
      const before = last;
      batcher.add({ ...event, at: new Date(clock.now()) });
      if (last !== before) await last;
    },
    async flush() {
      const before = last;
      batcher.flush();
      if (last !== before) await last;
    },
  };
}
