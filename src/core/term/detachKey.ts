/**
 * attach 의 분리 키 — ★`Ctrl-\` 다음 `d`(설계 2-5 추천값, 결재 대상 상수는 이 한 곳).
 * tmux 의 `Ctrl-b d` 와 겹치지 않아 세션 안에서 tmux 를 써도 부딪치지 않는다.
 * `Ctrl-\` 를 앱에 보내려면 두 번 누른다.
 */
export const DETACH_PREFIX = 0x1c;
export const DETACH_KEY = "d".charCodeAt(0);
export const DETACH_HINT = "Ctrl-\\ then d";

export interface DetachScan {
  /** 세션에 보낼 바이트. */
  forward: Buffer;
  /** 분리 키를 눌렀다. */
  detach: boolean;
}

/** 입력 덩어리 사이에 걸친 `Ctrl-\` 를 기억하는 작은 상태 기계(순수 — 입출력 없음). */
export class DetachKeyScanner {
  private pendingPrefix = false;

  scan(chunk: Buffer): DetachScan {
    const out: number[] = [];
    for (const byte of chunk) {
      if (this.pendingPrefix) {
        this.pendingPrefix = false;
        if (byte === DETACH_KEY) {
          return { forward: Buffer.from(out), detach: true };
        }
        if (byte === DETACH_PREFIX) {
          out.push(DETACH_PREFIX);
          continue;
        }
        out.push(DETACH_PREFIX, byte);
        continue;
      }
      if (byte === DETACH_PREFIX) {
        this.pendingPrefix = true;
        continue;
      }
      out.push(byte);
    }
    return { forward: Buffer.from(out), detach: false };
  }
}
