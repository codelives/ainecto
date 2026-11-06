/**
 * `ainecto term` 의 운영 상한 — ★한 곳(사용자 컨펌 2026-11-06 «추천대로 해», 설계 U6).
 * 시험은 값을 바꾸지 않는다. 로그 크기만 DaemonLog 생성 인자로 낮춰 시험한다(운영 경로는 이 값).
 * 세션 수·스크롤백(xterm 기본 1000줄)은 상한을 두지 않는다(같은 컨펌).
 */

/**
 * 요청 하나에 데몬이 답할 때까지 기다리는 시간. 넘으면 «데몬 응답 없음» 오류로 끝나고 아무것도 정리하지 않는다
 * (소켓을 지우거나 새 데몬을 띄우지 않는다 — 설계 2-1). attach 의 출력 흐름과 `wait` 의 전체 기다림에는 걸지 않는다 —
 * 그 안의 요청-응답 한 번마다만 건다.
 */
export const DAEMON_RESPONSE_TIMEOUT_MS = 10_000;

/** 데몬에 못 붙을 때 데몬을 띄워 보는 횟수. 잠금을 쥔 데몬이 bind 전에 멈춘 경우에도 이 횟수 뒤 오류로 끝난다. */
export const DAEMON_START_ATTEMPTS = 3;

/** daemon.log 가 이 크기를 넘으면 daemon.log.1 하나만 남기고 새로 쓴다. */
export const DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024;
