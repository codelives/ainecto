/** 멈춤 신호 — Ctrl+C(SIGINT) · kill(SIGTERM) · term kill·데몬 끝·로그아웃(SIGHUP). */
export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * 멈춤 신호마다 {@code handler} — ★한 곳. {@code process.once} 가 아니라 {@code process.on}: npx 아래에서는 Ctrl+C 가 «두 번» 온다
 * (PTY 프로세스 그룹 + npx 가 넘겨줌). once 면 두 번째에 처리기가 없어 기본 동작으로 죽고, 서버 close 를 못 보낸 채 npx 가 그 신호로
 * 끝난다(next.9 실물 2026-11-17 — 세션 signal 2, 매니페스트에 남음). 처리기는 여러 번 불려도 되게(abort 처럼) 짠다.
 * 돌려준 함수로 뗀다.
 */
export function onStopSignals(handler: () => void): () => void {
  for (const signal of STOP_SIGNALS) {
    process.on(signal, handler);
  }
  return () => {
    for (const signal of STOP_SIGNALS) {
      process.off(signal, handler);
    }
  };
}
