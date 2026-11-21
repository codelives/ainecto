import { spawnDetached } from "../../core/os/launch";
import type { AgentLogRecord } from "../../core/agent/log";
import { pcIdle, upgradeTarget, type CliTags } from "../../core/pc/pcUpgrade";
import type { LaunchFlags } from "../../core/pc/pcSession";
import type { DaemonLog } from "../../core/term/daemonLog";

/**
 * pc run 의 자동 업그레이드 감시(KAN-738 next.10) — 원격 다리의 서버 응답(open·poll)마다 목표를 다시 본다(비교는 싸다).
 * 목표가 있고 한가하면(Agent 할 일 없음 + 웹이 보는 세션 0) 도우미를 한 번 띄운다. ★같은 목표는 이 프로세스에서 한 번만 —
 * 실패·거절한 목표는 꼬리표가 다른 판으로 바뀔 때까지 다시 안 한다(되돌려 띄운 pc 는 {@code skip} 으로 그 목표를 받는다).
 */
export function upgradeWatch(input: {
  current: string;
  release: boolean;
  skip: string | undefined;
  agentBusy: () => boolean;
  launch: (target: string) => void;
}): (answer: { tags: CliTags | undefined; watching: number }) => void {
  const tried = new Set<string>(input.skip ? [input.skip] : []);
  return ({ tags, watching }) => {
    const target = upgradeTarget({ current: input.current, release: input.release, tags, tried });
    if (!target || !pcIdle({ agentBusy: input.agentBusy(), watching })) return;
    tried.add(target);
    input.launch(target);
  };
}

/**
 * 도우미 `ainecto pc swap` 을 «지금 판 코드»(지금 프로세스의 node + 지금 스크립트)로, 세션 밖 독립 프로세스로 띄운다(detached·unref) —
 * pc run 은 term 세션 안이라 자기를 끄면 그 자식도 죽는다. 같은 전역 플래그(--env·--endpoint)를 넘겨 새 pc 가 같은 서버로 붙는다.
 */
export function launchSwapHelper(input: { from: string; to: string; flags: LaunchFlags; log: DaemonLog<AgentLogRecord> }): void {
  const script = process.argv[1];
  if (!script) {
    input.log.write({ event: "upgrade_launch", from: input.from, to: input.to, error: "cannot find this CLI's script path" });
    return;
  }
  const args = [
    ...process.execArgv, script, "pc", "swap", "--from", input.from, "--to", input.to,
    ...(input.flags.env ? ["--env", input.flags.env] : []),
    ...(input.flags.endpoint ? ["--endpoint", input.flags.endpoint] : []),
  ];
  try {
    const child = spawnDetached(process.execPath, args, { cwd: process.cwd(), env: process.env, stdio: "ignore" });
    child.on("error", (error) => input.log.write({ event: "upgrade_launch", from: input.from, to: input.to, error: error.message }));
    child.unref();
    input.log.write({ event: "upgrade_launch", from: input.from, to: input.to, ...(child.pid !== undefined ? { pid: child.pid } : {}) });
  } catch (error) {
    input.log.write({ event: "upgrade_launch", from: input.from, to: input.to, error: error instanceof Error ? error.message : String(error) });
  }
}

/** `pc swap` 의 인자 — --from·--to 둘 다 있어야 한다(순수 함수). */
export function swapArgsOf(argv: readonly string[]): { from: string; to: string } | undefined {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    const next = index >= 0 ? argv[index + 1] : undefined;
    return next !== undefined && !next.startsWith("--") ? next : undefined;
  };
  const from = value("--from");
  const to = value("--to");
  return from && to ? { from, to } : undefined;
}
