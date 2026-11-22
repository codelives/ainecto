import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePair, type PairDeps, type TtyIO } from "../src/adapters/cli/pairCommand";
import { CliCommandError } from "../src/adapters/cli/errors";
import { loadPcKeys, updatePcKeys, withBrowser, type PcGroup } from "../src/core/pc/pcKeys";
import { PAIR_WAIT_MS, type BrowserOffer, type PairTransport } from "../src/core/pc/pcPairing";
import { accountKey, normalizePcSettings, savePcSettings, withConsent } from "../src/core/pc/pcSettings";
import {
  assertCommitment,
  browserKeyIdOf,
  generateSigningJwk,
  pairCodes,
  pairDoneInput,
  pairTranscript,
  publicJwkFromRaw,
  publicJwkOf,
  publicRawFromJwk,
  randomBytes,
  verifyBytes,
  E2eError,
  type EcPrivateJwk,
  type PairCodes,
} from "../src/core/term/e2e";

/**
 * `ainecto pair` 의 PC 쪽 순서 — 서버 중계는 가짜(transport)지만 그 뒤의 브라우저는 진짜 암호(e2e.ts)로 행동한다:
 * 약속값 대조 · 같은 T 로 코드 계산 · done 서명 검증. 파일은 임시 HOME 의 실제 pc.json·pc-keys.json.
 */
const ENDPOINT = "https://example.test/mcp";
const USER_ID = "5B1F2C9E-0A7D-4E63-8F41-9C2D7B6A3E10";
const KEY = accountKey(ENDPOINT, USER_ID);

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pcpair-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const settingsPath = (): string => join(home, ".ainecto", "pc.json");
const keysPath = (): string => join(home, ".ainecto", "pc-keys.json");

async function approve(remoteTerminal = true): Promise<string> {
  const settings = withConsent(normalizePcSettings(undefined, "test-host"), KEY, remoteTerminal, new Date("2026-11-21T00:00:00Z"));
  await savePcSettings(settingsPath(), settings);
  return settings.pcId;
}

/** 진짜 암호로 움직이는 브라우저 + 그 사이의 중계(relay 가 브라우저 키를 바꿔치기할 수 있다). */
async function fakeBrowser(options: {
  pcId: string; keyId?: string; relaySwapsKey?: boolean; never?: boolean; failDone?: boolean; name?: string;
  /** 같은 브라우저가 다시 짝짓는다 — 계정의 브라우저 키를 재사용한다. */
  own?: EcPrivateJwk;
  /** 드러내기를 받은 뒤(코드를 치기 전) 다른 일이 끼어든다. */
  afterReveal?: () => Promise<void>;
}) {
  const own: EcPrivateJwk = options.own ?? await generateSigningJwk();
  const ownPub = publicRawFromJwk(own);
  const nB = randomBytes(32);
  const state: { commit?: Uint8Array; pcPub?: Uint8Array; transcript?: Uint8Array; codes?: PairCodes; pinnedPc: boolean; done: number;
    aborts: string[] } = {
    pinnedPc: false, done: 0, aborts: [],
  };
  const transport: PairTransport = {
    async offer(commit, signal) {
      if (options.never) {
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      state.commit = commit;
      // 바꿔치기하는 중계는 키 id 도 제 키의 지문으로 맞춰 보낸다(지문 검사를 지나는 가장 센 경우).
      const publicRaw = options.relaySwapsKey ? publicRawFromJwk(await generateSigningJwk()) : ownPub;
      const relayed: BrowserOffer = {
        keyId: options.keyId ?? await browserKeyIdOf(publicRaw),
        publicRaw,
        nB,
        name: options.name ?? "Chrome · macOS",
      };
      return relayed;
    },
    async reveal(pcPub, nP) {
      if (!state.commit) throw new Error("reveal before offer");
      await assertCommitment(state.commit, pcPub, nP);
      state.pcPub = pcPub;
      state.transcript = await pairTranscript({ userId: USER_ID.toLowerCase(), pcId: options.pcId, pcPublicRaw: pcPub, browserPublicRaw: ownPub, nP, nB });
      state.codes = await pairCodes(state.transcript);
      await options.afterReveal?.();
    },
    async done(signature) {
      state.done += 1;
      if (options.failDone) throw new Error("relay closed");
      if (!state.pcPub || !state.transcript) throw new Error("done before reveal");
      state.pinnedPc = await verifyBytes(publicJwkFromRaw(state.pcPub), signature, pairDoneInput(state.transcript));
    },
    async abort(reason) {
      state.aborts.push(reason);
    },
  };
  return { own, transport, state };
}

/** /dev/tty 대역 — 물음이 나오면 answer() 가 준 줄을 친다. */
function fakeTty(answer: () => string | undefined) {
  const stdin = new PassThrough();
  let text = "";
  let closed = false;
  const tty: TtyIO = {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: {
      write: (chunk: string) => {
        text += chunk;
        if (chunk.startsWith("Then type the code")) {
          const line = answer();
          if (line !== undefined) setImmediate(() => stdin.write(`${line}\n`));
        }
        return true;
      },
    } as unknown as NodeJS.WriteStream,
    close: () => {
      closed = true;
    },
  };
  return { tty, text: () => text, closed: () => closed };
}

function deps(overrides: Partial<PairDeps>) {
  let out = "";
  const notified: Array<{ keyId: string; name: string }> = [];
  const value: PairDeps = {
    io: {
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      stdout: { write: (text: string) => { out += text; return true; } } as unknown as NodeJS.WriteStream,
      stderr: { write: () => true } as unknown as NodeJS.WriteStream,
    },
    json: false,
    interactive: true,
    insideTermSession: false,
    openTty: () => { throw new Error("no tty in this test"); },
    settingsPath: settingsPath(),
    keysPath: keysPath(),
    hostName: "test-host",
    endpoint: ENDPOINT,
    account: async () => ({ userId: USER_ID }),
    transport: () => { throw new Error("no transport in this test"); },
    notifyPaired: async (browser) => { notified.push(browser); },
    findPcs: async () => [],
    turnOffPcs: async () => undefined,
    waitMs: 10_000,
    now: () => new Date("2026-11-21T09:00:00Z"),
    ...overrides,
  };
  return { deps: value, out: () => out, notified };
}

async function expectCli(promise: Promise<unknown>, code: string): Promise<CliCommandError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliCommandError);
  expect(error instanceof CliCommandError ? error.code : undefined).toBe(code);
  return error as CliCommandError;
}

describe("ainecto pair — PC 앞 짝짓기(설계 §11-1·§13-3)", () => {
  it("기한 상수는 결재한 5분", () => {
    expect(PAIR_WAIT_MS).toBe(5 * 60_000);
  });

  it("맞는 코드: 약속값 대조 → 코드 A 는 브라우저와 같음 → 코드 B 입력 → 브라우저 키 핀(0600) → done 서명을 브라우저가 검증", async () => {
    const pcId = await approve();
    const browser = await fakeBrowser({ pcId, name: "Chrome\n\u001b[2J · macOS" });
    const tty = fakeTty(() => browser.state.codes?.b);
    const run = deps({ transport: () => browser.transport, openTty: () => tty.tty });
    expect(await executePair(run.deps, [])).toBe(0);
    expect(tty.text()).toContain(`Type this code in the browser: ${browser.state.codes?.a}`);
    expect(tty.text()).toContain("A browser asked to pair: Chrome[2J · macOS");
    expect(tty.closed()).toBe(true);
    expect(browser.state.pinnedPc).toBe(true);
    const keys = await loadPcKeys(keysPath());
    expect(keys.accounts[KEY]?.browsers).toEqual([{
      keyId: await browserKeyIdOf(publicRawFromJwk(browser.own)), publicJwk: publicJwkOf(browser.own), name: "Chrome[2J · macOS", pairedAt: "2026-11-21T09:00:00.000Z",
    }]);
    expect((await stat(keysPath())).mode & 0o777).toBe(0o600);
    expect(run.out()).toContain('Paired "Chrome[2J · macOS" with this PC.');
    // PC 알림 — done 을 보낸 뒤 한 번(§11-7).
    expect(run.notified).toEqual([{ keyId: await browserKeyIdOf(publicRawFromJwk(browser.own)), name: "Chrome[2J · macOS" }]);
    // ★코드는 /dev/tty 에만 — stdout(파이프로 갈 수 있는 곳)에는 없다.
    expect(run.out()).not.toContain(browser.state.codes?.a ?? "x");
    expect(run.out()).not.toContain(browser.state.codes?.b ?? "x");

    // 두 번째 짝짓기는 같은 PC 키를 쓴다(이미 짝지은 브라우저가 계속 믿는다).
    const pcKey = keys.accounts[KEY]?.pcKey;
    const second = await fakeBrowser({ pcId });
    const tty2 = fakeTty(() => second.state.codes?.b);
    expect(await executePair(deps({ transport: () => second.transport, openTty: () => tty2.tty }).deps, [])).toBe(0);
    const after = await loadPcKeys(keysPath());
    expect(after.accounts[KEY]?.pcKey).toEqual(pcKey);
    expect(after.accounts[KEY]?.browsers.length).toBe(2);
  });

  it("틀린 코드(한 번뿐) → PAIR_CODE_MISMATCH · 아무것도 저장 안 함 · done 안 보냄", async () => {
    const pcId = await approve();
    const browser = await fakeBrowser({ pcId });
    const tty = fakeTty(() => (browser.state.codes?.b === "000000" ? "000001" : "000000"));
    await expectCli(executePair(deps({ transport: () => browser.transport, openTty: () => tty.tty }).deps, []), "PAIR_CODE_MISMATCH");
    await expect(stat(keysPath())).rejects.toThrow();
    expect(browser.state.done).toBe(0);
    expect(tty.closed()).toBe(true);
    // 짝짓지 못하고 끝나면 브라우저에 abort 를 알린다.
    expect(browser.state.aborts).toEqual(["code-mismatch"]);
  });

  it("코드 입력 경계: 앞뒤 공백은 지우고 맞으면 핀 · 하이픈·가운데 공백이 든 맞는 숫자는 불일치(한 번 소모)", async () => {
    const pcId = await approve();
    const padded = await fakeBrowser({ pcId });
    expect(await executePair(deps({ transport: () => padded.transport, openTty: () => fakeTty(() => `  ${padded.state.codes?.b}\t`).tty }).deps, [])).toBe(0);
    for (const shape of [(b: string) => `${b.slice(0, 3)}-${b.slice(3)}`, (b: string) => `${b.slice(0, 3)} ${b.slice(3)}`]) {
      const browser = await fakeBrowser({ pcId });
      const tty = fakeTty(() => (browser.state.codes ? shape(browser.state.codes.b) : undefined));
      await expectCli(executePair(deps({ transport: () => browser.transport, openTty: () => tty.tty }).deps, []), "PAIR_CODE_MISMATCH");
      expect(browser.state.done).toBe(0);
    }
    expect((await loadPcKeys(keysPath())).accounts[KEY]?.browsers.length).toBe(1);
  });

  it("받은 키 id 가 공개키 지문과 다르면 거절 — 코드를 보이지 않고 저장 안 함", async () => {
    const pcId = await approve();
    const browser = await fakeBrowser({ pcId, keyId: "9d2b7e4a-61c3-4f0e-8a5d-3b1c7e9f2a64" });
    const tty = fakeTty(() => browser.state.codes?.b);
    const error = await executePair(deps({ transport: () => browser.transport, openTty: () => tty.tty }).deps, []).then(() => undefined, (caught: unknown) => caught);
    expect(error instanceof E2eError ? error.code : error).toBe("E2E_BAD_INPUT");
    expect(tty.text()).not.toContain("Type this code");
    await expect(stat(keysPath())).rejects.toThrow();
  });

  it("중계가 브라우저 키를 바꿔치기하면 — 사람이 진짜 브라우저의 코드 B 를 쳐도 맞지 않는다 · 저장 안 함", async () => {
    const pcId = await approve();
    const browser = await fakeBrowser({ pcId, relaySwapsKey: true });
    const tty = fakeTty(() => browser.state.codes?.b);
    await expectCli(executePair(deps({ transport: () => browser.transport, openTty: () => tty.tty }).deps, []), "PAIR_CODE_MISMATCH");
    await expect(stat(keysPath())).rejects.toThrow();
  });

  it("기한 안에 브라우저가 안 오면 PAIR_TIMEOUT · 저장 안 함", async () => {
    const pcId = await approve();
    const browser = await fakeBrowser({ pcId, never: true });
    const tty = fakeTty(() => undefined);
    await expectCli(executePair(deps({ transport: () => browser.transport, openTty: () => tty.tty, waitMs: 50 }).deps, []), "PAIR_TIMEOUT");
    await expect(stat(keysPath())).rejects.toThrow();
  });

  it("코드를 치는 동안 기한이 지나면 PAIR_TIMEOUT · 빈 줄이면 PAIR_CANCELLED — 둘 다 저장 안 함", async () => {
    const pcId = await approve();
    const slow = await fakeBrowser({ pcId });
    await expectCli(executePair(deps({ transport: () => slow.transport, openTty: () => fakeTty(() => undefined).tty, waitMs: 100 }).deps, []), "PAIR_TIMEOUT");
    const empty = await fakeBrowser({ pcId });
    await expectCli(executePair(deps({ transport: () => empty.transport, openTty: () => fakeTty(() => "").tty }).deps, []), "PAIR_CANCELLED");
    await expect(stat(keysPath())).rejects.toThrow();
    expect(slow.state.aborts).toEqual(["timeout"]);
    expect(empty.state.aborts).toEqual(["cancelled"]);
  });

  it("done 을 못 보내면 PAIR_DONE_FAILED — PC 에는 핀했다고 사유와 지우는 명령을 알린다", async () => {
    const pcId = await approve();
    const browser = await fakeBrowser({ pcId, failDone: true });
    const tty = fakeTty(() => browser.state.codes?.b);
    const run = deps({ transport: () => browser.transport, openTty: () => tty.tty });
    const error = await expectCli(executePair(run.deps, []), "PAIR_DONE_FAILED");
    expect(error.message).toContain("relay closed");
    // 양쪽 완료가 아니다 — 알리지 않는다.
    expect(run.notified).toEqual([]);
    expect(error.message).toContain(`ainecto pair --remove ${await browserKeyIdOf(publicRawFromJwk(browser.own))}`);
    expect((await loadPcKeys(keysPath())).accounts[KEY]?.browsers.length).toBe(1);
  });

  it("짝짓는 동안 PC 키가 바뀌면 PAIR_CONFLICT · 브라우저 핀을 넣지 않는다", async () => {
    const pcId = await approve();
    const other = await generateSigningJwk();
    const browser = await fakeBrowser({ pcId, afterReveal: async () => { await updatePcKeys(keysPath(), () => ({ accounts: { [KEY]: { pcKey: other, browsers: [] } } })); } });
    const tty = fakeTty(() => browser.state.codes?.b);
    await expectCli(executePair(deps({ transport: () => browser.transport, openTty: () => tty.tty }).deps, []), "PAIR_CONFLICT");
    expect((await loadPcKeys(keysPath())).accounts[KEY]).toEqual({ pcKey: other, browsers: [] });
    expect(browser.state.done).toBe(0);
  });

  it("대화형만 · 터미널 세션 안 거절 · 동의 전 거절 — 중계·터미널을 열기 전에", async () => {
    const never = (): never => { throw new Error("must not open"); };
    await expectCli(executePair(deps({ json: true, transport: never, openTty: never }).deps, []), "PAIR_INTERACTIVE_ONLY");
    await expectCli(executePair(deps({ interactive: false, transport: never, openTty: never }).deps, []), "PAIR_INTERACTIVE_ONLY");
    await expectCli(executePair(deps({ insideTermSession: true, transport: never, openTty: never }).deps, []), "PAIR_IN_TERM_SESSION");
    await expectCli(executePair(deps({ transport: never, openTty: never }).deps, []), "PC_NOT_APPROVED");
    await expectCli(executePair(deps({}).deps, ["--bogus"]), "USAGE");
    await expectCli(executePair(deps({}).deps, ["--remove"]), "USAGE");
  });
});

describe("ainecto pair --remove — 핀 삭제 → PC 연결을 완전히 끔(그룹 소멸 확인) · 다시 띄우지 않음(§13-2·§14-6 3)", () => {
  async function seed(): Promise<void> {
    const pub = publicJwkOf(await generateSigningJwk());
    const pcKey = await generateSigningJwk();
    await updatePcKeys(keysPath(), (keys) => withBrowser(keys, KEY, pcKey, { keyId: "k1", publicJwk: pub, name: "Work", pairedAt: "2026-11-21T00:00:00.000Z" }));
  }
  /** seed() 뒤에 둘째 브라우저 k2(Home). */
  async function seedHome(): Promise<void> {
    await updatePcKeys(keysPath(), async (keys) => {
      const stored = keys.accounts[KEY];
      if (!stored) throw new Error("seed() did not save the account");
      return withBrowser(keys, KEY, stored.pcKey,
        { keyId: "k2", publicJwk: publicJwkOf(await generateSigningJwk()), name: "Home", pairedAt: "2026-11-21T00:00:00.000Z" });
    });
  }
  const GROUP: PcGroup = { session: "ainecto-pc", pid: 4242, pgid: 4242 };
  const account = async () => (await loadPcKeys(keysPath())).accounts[KEY];

  it("핀 삭제와 표지를 한 번에 쓴 «뒤에» 그룹을 읽고 → 끄기 «전에» 그룹을 표지에 → 소멸 확인 뒤 표지를 지우고 성공 · 떠 있는 것이 없으면 파일만", async () => {
    await seed();
    const seen: unknown[] = [];
    const running = deps({
      findPcs: async () => {
        seen.push(await account());
        return [GROUP];
      },
      turnOffPcs: async (groups) => {
        seen.push(groups, (await account())?.pendingTurnOff?.groups);
      },
    });
    expect(await executePair(running.deps, ["--remove", "k1"])).toBe(0);
    expect(seen[0]).toMatchObject({ browsers: [], pendingTurnOff: { removedAt: "2026-11-21T09:00:00.000Z", groups: [] } });
    expect(seen.slice(1)).toEqual([[GROUP], [GROUP]]);
    expect(running.out()).toContain("Turned off the PC connection. Run `ainecto` to turn it back on.");
    expect((await account())?.pendingTurnOff).toBeUndefined();

    await seed();
    const idle = deps({ json: true });
    expect(await executePair(idle.deps, ["--remove", "Work"])).toBe(0);
    expect(JSON.parse(idle.out())).toMatchObject({ data: { removed: { keyId: "k1", name: "Work" }, turnedOff: [] } });
    expect((await account())?.pendingTurnOff).toBeUndefined();
  });

  it("데몬 조회 불가·그룹 불명(findPcs 가 던짐)은 «실행 중 아님»이 아니라 실패 — 핀은 지워지고 표지가 남으며 아무것도 끄지 않는다", async () => {
    await seed();
    let turnOffCalls = 0;
    const blind = deps({
      findPcs: async () => { throw new CliCommandError("PC_STOP_UNCONFIRMED", "Could not check the PC connection (ainecto term: no pty)."); },
      turnOffPcs: async () => { turnOffCalls += 1; },
    });
    const error = await expectCli(executePair(blind.deps, ["--remove", "k1"]), "PAIR_REMOVE_STOP_FAILED");
    expect(error.message).toContain("Could not check the PC connection");
    expect(turnOffCalls).toBe(0);
    expect(await account()).toMatchObject({ browsers: [], pendingTurnOff: { removedAt: "2026-11-21T09:00:00.000Z", groups: [] } });
  });

  it("끄기 확인 실패 → 표지에 그 그룹 · 다시 실행하면 데몬 목록에서 빠졌어도 원래 그룹의 소멸부터 확인 · 표지·이름 둘 다 없으면 끄지 않고 PAIR_NOT_FOUND", async () => {
    await seed();
    const failing = deps({
      findPcs: async () => [GROUP],
      turnOffPcs: async () => { throw new Error("Could not confirm that the PC connection ended"); },
    });
    const error = await expectCli(executePair(failing.deps, ["--remove", "k1"]), "PAIR_REMOVE_STOP_FAILED");
    expect(error.message).toContain("Could not confirm");
    expect(error.message).toContain("ainecto pair --remove k1");
    expect(await account()).toMatchObject({ browsers: [], pendingTurnOff: { removedAt: "2026-11-21T09:00:00.000Z", groups: [GROUP] } });

    // 세션은 데몬 목록에서 빠졌지만 그룹(손자)이 아직 산다 — 재시도도 실패하고 표지는 그대로.
    const stillAlive = deps({
      findPcs: async () => [],
      turnOffPcs: async (groups) => { if (groups.length > 0) throw new Error("a process in its group 4242 is still alive"); },
      now: () => new Date("2026-11-21T10:00:00Z"),
    });
    await expectCli(executePair(stillAlive.deps, ["--remove", "k1"]), "PAIR_REMOVE_STOP_FAILED");
    expect((await account())?.pendingTurnOff).toEqual({ removedAt: "2026-11-21T09:00:00.000Z", groups: [GROUP], removals: [{ keyId: "k1", name: "Work" }] });

    const confirmed: Array<readonly PcGroup[]> = [];
    let finds = 0;
    const retry = deps({
      findPcs: async () => { finds += 1; return []; },
      turnOffPcs: async (groups) => { confirmed.push(groups); },
    });
    expect(await executePair(retry.deps, ["--remove", "k1"])).toBe(0);
    expect(confirmed).toEqual([[GROUP]]);
    expect(retry.out()).toContain("Finished the earlier removal.");
    expect(retry.out()).toContain("Turned off the PC connection.");
    expect((await account())?.pendingTurnOff).toBeUndefined();

    // 오타: 표지도 이름도 없으면 끄지 않는다.
    await expectCli(executePair(retry.deps, ["--remove", "Wrok"]), "PAIR_NOT_FOUND");
    expect(finds).toBe(1);
  });

  it("겹친 두 철회 — 먼저 끝난 쪽은 자기가 끝난 것을 확인한 그룹만 표지에서 뺀다 · 상대가 더한 그룹은 남아 그 철회의 재시도가 확인한다", async () => {
    await seed();
    await seedHome();
    const OTHER: PcGroup = { session: "ainecto-pc", pid: 5353, pgid: 5353 };
    let firstIn!: () => void;
    const firstInTurnOff = new Promise<void>((resolve) => { firstIn = resolve; });
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const first = executePair(deps({
      findPcs: async () => [GROUP],
      turnOffPcs: async () => { firstIn(); await firstGate; },
    }).deps, ["--remove", "k1"]);
    await firstInTurnOff;
    // 그 사이 다시 뜬 PC 연결(OTHER) — 둘째 철회가 표지에 더하고 끄는 중이다.
    let secondIn!: () => void;
    const secondInTurnOff = new Promise<void>((resolve) => { secondIn = resolve; });
    let failSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { failSecond = resolve; });
    const second = executePair(deps({
      findPcs: async () => [OTHER],
      turnOffPcs: async () => { secondIn(); await secondGate; throw new Error("a process in its group 5353 is still alive"); },
    }).deps, ["--remove", "k2"]);
    await secondInTurnOff;
    expect((await account())?.pendingTurnOff?.groups).toEqual([GROUP, OTHER]);

    finishFirst();
    expect(await first).toBe(0);
    expect((await account())?.pendingTurnOff).toEqual({ removedAt: "2026-11-21T09:00:00.000Z", groups: [OTHER], removals: [{ keyId: "k2", name: "Home" }] });
    failSecond();
    await expectCli(second, "PAIR_REMOVE_STOP_FAILED");
    expect((await account())?.pendingTurnOff?.groups).toEqual([OTHER]);

    const confirmed: Array<readonly PcGroup[]> = [];
    expect(await executePair(deps({ turnOffPcs: async (groups) => { confirmed.push(groups); } }).deps, ["--remove", "k2"])).toBe(0);
    expect(confirmed).toEqual([[OTHER]]);
    expect((await account())?.pendingTurnOff).toBeUndefined();
  });

  it("나중 철회가 핀만 지우고 그룹 조회 전에 멈춤(죽음) → 먼저 철회가 끝나도 그 철회는 표지에 남아 같은 명령이 조회·종료로 다시 들어간다 · 끝난 뒤에만 PAIR_NOT_FOUND", async () => {
    await seed();
    await seedHome();
    let firstIn!: () => void;
    const firstInTurnOff = new Promise<void>((resolve) => { firstIn = resolve; });
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const first = executePair(deps({
      findPcs: async () => [GROUP],
      turnOffPcs: async () => { firstIn(); await firstGate; },
    }).deps, ["--remove", "k1"]);
    await firstInTurnOff;
    // 둘째는 핀을 지운 뒤 조회에서 영영 돌아오지 않는다 — 디스크에 남는 것은 그 자리에서 죽은 프로세스와 같다.
    let secondAtLookup!: () => void;
    const secondLooking = new Promise<void>((resolve) => { secondAtLookup = resolve; });
    void executePair(deps({ findPcs: () => { secondAtLookup(); return new Promise<never>(() => undefined); } }).deps, ["--remove", "k2"]);
    await secondLooking;

    finishFirst();
    expect(await first).toBe(0);
    // 그 사이 뜬 PC 연결(OTHER)이 아직 산다 — 다시 실행하면 조회·끄기로 들어가고 계속 실패한다(이름으로도 찾는다).
    const OTHER: PcGroup = { session: "ainecto-pc", pid: 5353, pgid: 5353 };
    let finds = 0;
    await expectCli(executePair(deps({
      findPcs: async () => { finds += 1; return [OTHER]; },
      turnOffPcs: async () => { throw new Error("a process in its group 5353 is still alive"); },
    }).deps, ["--remove", "Home"]), "PAIR_REMOVE_STOP_FAILED");
    expect(finds).toBe(1);
    expect((await account())?.pendingTurnOff).toEqual({ removedAt: "2026-11-21T09:00:00.000Z", groups: [OTHER], removals: [{ keyId: "k2", name: "Home" }] });

    const confirmed: Array<readonly PcGroup[]> = [];
    const retry = deps({ turnOffPcs: async (groups) => { confirmed.push(groups); } });
    expect(await executePair(retry.deps, ["--remove", "k2"])).toBe(0);
    expect(confirmed).toEqual([[OTHER]]);
    expect(retry.out()).toContain("Finished the earlier removal.");
    expect((await account())?.pendingTurnOff).toBeUndefined();
    await expectCli(executePair(deps({}).deps, ["--remove", "k2"]), "PAIR_NOT_FOUND");
  });
});

describe("ainecto pair — 끝나지 않은 철회가 있는 동안의 짝짓기(리뷰 impl-4 #1·#2)", () => {
  const account = async () => (await loadPcKeys(keysPath())).accounts[KEY];
  const failingTurnOff = () => deps({
    findPcs: async () => [{ session: "ainecto-pc", pid: 4242, pgid: 4242 }],
    turnOffPcs: async () => { throw new Error("a process in its group 4242 is still alive"); },
  });
  async function pairOnce(pcId: string, own?: EcPrivateJwk) {
    const browser = await fakeBrowser({ pcId, own });
    const tty = fakeTty(() => browser.state.codes?.b);
    const result = executePair(deps({ transport: () => browser.transport, openTty: () => tty.tty }).deps, []);
    return { browser, result, keyId: await browserKeyIdOf(publicRawFromJwk(browser.own)) };
  }

  it("철회 실패 중 다른 브라우저가 같은 기본 이름으로 짝지어도 다른 이름을 받고 · 원래 이름으로 재시도해도 새 핀이 남는다 · 실패 안내는 keyId 로", async () => {
    const pcId = await approve();
    const old = await pairOnce(pcId);
    expect(await old.result).toBe(0);
    const error = await expectCli(executePair(failingTurnOff().deps, ["--remove", "Chrome · macOS"]), "PAIR_REMOVE_STOP_FAILED");
    expect(error.message).toContain(`Run \`ainecto pair --remove ${old.keyId}\` again to finish.`);

    const fresh = await pairOnce(pcId);
    expect(await fresh.result).toBe(0);
    expect((await account())?.browsers.map((item) => [item.keyId, item.name])).toEqual([[fresh.keyId, "Chrome · macOS (2)"]]);

    const retry = deps({});
    expect(await executePair(retry.deps, ["--remove", "Chrome · macOS"])).toBe(0);
    expect(retry.out()).toContain("Finished the earlier removal.");
    expect(await account()).toMatchObject({ browsers: [{ keyId: fresh.keyId, name: "Chrome · macOS (2)" }] });
    expect((await account())?.pendingTurnOff).toBeUndefined();
  });

  it("같은 브라우저(같은 keyId)의 철회가 끝나지 않았으면 재짝짓기는 저장하지 않고 PAIR_REMOVE_PENDING · done 안 보냄 · 철회를 마친 뒤엔 짝지어진다", async () => {
    const pcId = await approve();
    const first = await pairOnce(pcId);
    expect(await first.result).toBe(0);
    await expectCli(executePair(failingTurnOff().deps, ["--remove", first.keyId]), "PAIR_REMOVE_STOP_FAILED");
    const pending = (await account())?.pendingTurnOff;

    const again = await pairOnce(pcId, first.browser.own);
    const error = await expectCli(again.result, "PAIR_REMOVE_PENDING");
    expect(error.message).toContain(`ainecto pair --remove ${first.keyId}`);
    expect(again.browser.state.done).toBe(0);
    expect(again.browser.state.aborts).toEqual(["error"]);
    expect(await account()).toMatchObject({ browsers: [], pendingTurnOff: pending });

    expect(await executePair(deps({}).deps, ["--remove", first.keyId])).toBe(0);
    expect((await account())?.pendingTurnOff).toBeUndefined();
    const later = await pairOnce(pcId, first.browser.own);
    expect(await later.result).toBe(0);
    expect(later.browser.state.pinnedPc).toBe(true);
    expect((await account())?.browsers.map((item) => item.keyId)).toEqual([first.keyId]);
  });
});

describe("ainecto pair --list · --remove", () => {
  it("목록(사람·JSON) · keyId 나 이름으로 지우기 · 없으면 PAIR_NOT_FOUND — 비대화형에서도 된다", async () => {
    const pcKey = await generateSigningJwk();
    const pub = publicJwkOf(await generateSigningJwk());
    let keys = withBrowser({ accounts: {} }, KEY, pcKey, { keyId: "k1", publicJwk: pub, name: "Work", pairedAt: "2026-11-21T00:00:00.000Z" });
    keys = withBrowser(keys, KEY, pcKey, { keyId: "k2", publicJwk: pub, name: "Home", pairedAt: "2026-11-21T01:00:00.000Z" });
    await updatePcKeys(keysPath(), () => keys);

    const human = deps({ interactive: false });
    expect(await executePair(human.deps, ["--list"])).toBe(0);
    expect(human.out()).toContain("  k1  Work  (paired 2026-11-21T00:00:00.000Z)");
    const json = deps({ json: true });
    expect(await executePair(json.deps, ["--list"])).toBe(0);
    expect(JSON.parse(json.out())).toMatchObject({ data: { browsers: [{ keyId: "k1", name: "Work" }, { keyId: "k2", name: "Home" }] } });

    expect(await executePair(deps({ interactive: false }).deps, ["--remove", "k1"])).toBe(0);
    const byName = deps({ interactive: false });
    expect(await executePair(byName.deps, ["--remove", "Home"])).toBe(0);
    expect(byName.out()).toContain('Removed "Home" (k2).');
    expect((await loadPcKeys(keysPath())).accounts[KEY]?.browsers).toEqual([]);
    await expectCli(executePair(deps({}).deps, ["--remove", "Work"]), "PAIR_NOT_FOUND");

    const empty = deps({});
    expect(await executePair(empty.deps, ["--list"])).toBe(0);
    expect(empty.out()).toContain("No browsers are paired with this PC.");
  });
});
