import { compute as current, type ComputeModule } from "../../src/core/term/compute";

/** 시험용 «자기 시험을 못 넘기는» 계산 모듈 — 읽기가 화면과 다른 글을 낸다. holder 는 받지 않고 지금 모듈을 쓴다. */
export const compute: ComputeModule = {
  ...current,
  key: (view, name) => (name === "next-probe" ? "BROKEN\r" : current.key(view, name)),
  read: () => ["broken"],
};
