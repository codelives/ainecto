import { compute as current, type ComputeModule } from "../../src/core/term/compute";

/**
 * 시험용 «다음 판» 계산 모듈 — 지금 compute.ts 그대로에 키 이름 하나(`next-probe`)를 더한다. 묶여 온 모듈은 이 이름을 모른다(TERM_UNKNOWN_KEY)
 * — 열린 세션에서 이 키가 먹으면 holder 가 새 판 계산을 쓰고 있다는 뜻이다. 자기 시험·xterm 판·요구 칸은 지금 것 그대로(통과해야 한다).
 */
export const compute: ComputeModule = {
  ...current,
  key: (view, name) => (name === "next-probe" ? "NEXT\r" : current.key(view, name)),
};
