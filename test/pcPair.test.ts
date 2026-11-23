import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePair, PAIR_RETIRED, pinBrowser, type PairDeps } from "../src/adapters/cli/pairCommand";
import { CliCommandError } from "../src/adapters/cli/errors";
import { loadPcKeys, updatePcKeys, withBrowser, type PcGroup } from "../src/core/pc/pcKeys";
import { PAIR_WAIT_MS, runPairing, type BrowserOffer, type PairTransport } from "../src/core/pc/pcPairing";
import { accountKey } from "../src/core/pc/pcSettings";
import {
  assertCommitment,
  browserKeyIdOf,
  generateSigningJwk,
  macEquals,
  pairDoneInput,
  pairTranscript,
  publicJwkFromRaw,
  publicJwkOf,
  publicRawFromJwk,
  randomBytes,
  registerKeys,
  registerOfferMac,
  registerRevealMac,
  verifyBytes,
  type EcPrivateJwk,
} from "../src/core/term/e2e";

/**
 * `ainecto pair` — 맨 `pair` 는 등록하지 않고 한 줄(0.15.3) · `--list` · `--remove`. 등록(핀)은 자동 등록의 runPairing(secret) + pinBrowser 로:
 * 서버 중계는 가짜(transport)지만 그 뒤의 브라우저는 진짜 암호(e2e.ts)로 행동한다 — macB · 약속값 대조 · macP · done 서명 검증.
 * 파일은 임시 HOME 의 실제 pc-keys.json.
 */
const ENDPOINT = "https://example.test/mcp";
const USER_ID = "5B1F2C9E-0A7D-4E63-8F41-9C2D7B6A3E10";
const KEY = accountKey(ENDPOINT, USER_ID);
const PC_ID = "6f2c1d3e-0000-4000-8000-000000000004";
const ATTEMPT_ID = "attempt-1";
const NOW = new Date("2026-11-21T09:00:00Z");

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pcpair-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const settingsPath = (): string => join(home, ".ainecto", "pc.json");
const keysPath = (): string => join(home, ".ainecto", "pc-keys.json");

/** 진짜 암호로 움직이는 자동 등록 브라우저(주소로 받은 S 로 macB 를 달고 macP·done 을 검증) + 그 사이의 중계. */
async function fakeBrowser(options: {
  /** 같은 브라우저가 다시 등록한다 — 브라우저 키를 재사용한다. */
  own?: EcPrivateJwk;
} = {}) {
  const own: EcPrivateJwk = options.own ?? await generateSigningJwk();
  const ownPub = publicRawFromJwk(own);
  const nB = randomBytes(32);
  const secret = randomBytes(32);
  const keys = await registerKeys(secret);
  const keyId = await browserKeyIdOf(ownPub);
  const name = "Chrome · macOS";
  const state: { commit?: Uint8Array; pcPub?: Uint8Array; transcript?: Uint8Array; pinnedPc: boolean; done: number; aborts: string[] } = {
    pinnedPc: false, done: 0, aborts: [],
  };
  const transport: PairTransport = {
    async offer(commit) {
      state.commit = commit;
      const macB = await registerOfferMac(keys.browser, { userId: USER_ID.toLowerCase(), pcId: PC_ID, attemptId: ATTEMPT_ID, commit,
        browserPublicRaw: ownPub, keyId, nB, name });
      const relayed: BrowserOffer = { keyId, publicRaw: ownPub, nB, name, macB, attemptId: ATTEMPT_ID };
      return relayed;
    },
    async reveal(pcPub, nP, _signal, macP) {
      if (!state.commit) throw new Error("reveal before offer");
      await assertCommitment(state.commit, pcPub, nP);
      const transcript = await pairTranscript({ userId: USER_ID.toLowerCase(), pcId: PC_ID, pcPublicRaw: pcPub, browserPublicRaw: ownPub, nP, nB });
      if (!macP || !macEquals(macP, await registerRevealMac(keys.pc, { transcript, attemptId: ATTEMPT_ID }))) throw new Error("bad macP");
      state.pcPub = pcPub;
      state.transcript = transcript;
    },
    async done(signature) {
      state.done += 1;
      if (!state.pcPub || !state.transcript) throw new Error("done before reveal");
      state.pinnedPc = await verifyBytes(publicJwkFromRaw(state.pcPub), signature, pairDoneInput(state.transcript));
    },
    async abort(reason) {
      state.aborts.push(reason);
    },
  };
  return { own, keyId, secret, transport, state };
}

/** 이 PC 키 — 저장된 것이 있으면 그것(이미 등록한 브라우저가 계속 믿는다), 없으면 새로. */
async function pcKeyOf(): Promise<EcPrivateJwk> {
  return (await loadPcKeys(keysPath())).accounts[KEY]?.pcKey ?? await generateSigningJwk();
}

/** 자동 등록 한 번 — runPairing(secret) 이 맞으면 pinBrowser 로 핀(pcCommand 의 자동 등록과 같은 조립). */
async function registerOnce(own?: EcPrivateJwk) {
  const browser = await fakeBrowser({ own });
  const pcKey = await pcKeyOf();
  const result = runPairing({
    userId: USER_ID.toLowerCase(), pcId: PC_ID, pcKey, transport: browser.transport, secret: browser.secret, waitMs: 10_000,
    pin: (matched) => pinBrowser({ keysPath: keysPath(), key: KEY, pcKey, browser: matched, now: NOW }),
  });
  return { browser, result, keyId: browser.keyId };
}

function deps(overrides: Partial<PairDeps>) {
  let out = "";
  const value: PairDeps = {
    io: {
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      stdout: { write: (text: string) => { out += text; return true; } } as unknown as NodeJS.WriteStream,
      stderr: { write: () => true } as unknown as NodeJS.WriteStream,
    },
    json: false,
    settingsPath: settingsPath(),
    keysPath: keysPath(),
    hostName: "test-host",
    endpoint: ENDPOINT,
    account: async () => ({ userId: USER_ID }),
    findPcs: async () => [],
    turnOffPcs: async () => undefined,
    now: () => NOW,
    ...overrides,
  };
  return { deps: value, out: () => out };
}

async function expectCli(promise: Promise<unknown>, code: string): Promise<CliCommandError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliCommandError);
  expect(error instanceof CliCommandError ? error.code : undefined).toBe(code);
  return error as CliCommandError;
}

describe("ainecto pair — 맨 `pair` 는 등록하지 않는다(0.15.3 · KAN-1348)", () => {
  it("기한 상수는 결재한 5분", () => {
    expect(PAIR_WAIT_MS).toBe(5 * 60_000);
  });

  it("맨 `pair` → PAIR_RETIRED 한 줄 · 0 · 계정·중계·파일을 건드리지 않는다 · 모르는 인자는 USAGE", async () => {
    const never = (): never => { throw new Error("must not be called"); };
    const run = deps({ account: never, findPcs: never, turnOffPcs: never });
    expect(await executePair(run.deps, [])).toBe(0);
    expect(run.out()).toBe(`${PAIR_RETIRED}\n`);
    await expect(stat(keysPath())).rejects.toThrow();
    await expect(stat(settingsPath())).rejects.toThrow();
    await expectCli(executePair(deps({}).deps, ["--bogus"]), "USAGE");
    await expectCli(executePair(deps({}).deps, ["--remove"]), "USAGE");
  });

  it("등록하는 동안 PC 키가 바뀌면 pinBrowser 는 PAIR_CONFLICT · 브라우저 핀을 넣지 않는다", async () => {
    const pcKey = await generateSigningJwk();
    const work = publicJwkOf(await generateSigningJwk());
    await updatePcKeys(keysPath(), (keys) => withBrowser(keys, KEY, pcKey, { keyId: "k1", publicJwk: work, name: "Work", pairedAt: "2026-11-21T00:00:00.000Z" }));
    const before = (await loadPcKeys(keysPath())).accounts[KEY];
    const error = await expectCli(pinBrowser({ keysPath: keysPath(), key: KEY, pcKey: await generateSigningJwk(), now: NOW,
      browser: { keyId: "k2", publicJwk: publicJwkOf(await generateSigningJwk()), name: "Home" } }), "PAIR_CONFLICT");
    expect(error.message).toContain("`npx -y ainecto@latest`");
    expect((await loadPcKeys(keysPath())).accounts[KEY]).toEqual(before);
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
    expect((await account())?.pendingTurnOff).toEqual({ removedAt: "2026-11-21T09:00:00.000Z", groups: [GROUP], removals: [{ removalId: expect.any(String), keyId: "k1", name: "Work" }] });

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
    expect((await account())?.pendingTurnOff).toEqual({ removedAt: "2026-11-21T09:00:00.000Z", groups: [OTHER], removals: [{ removalId: expect.any(String), keyId: "k2", name: "Home" }] });
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
    expect((await account())?.pendingTurnOff).toEqual({ removedAt: "2026-11-21T09:00:00.000Z", groups: [OTHER], removals: [{ removalId: expect.any(String), keyId: "k2", name: "Home" }] });

    const confirmed: Array<readonly PcGroup[]> = [];
    const retry = deps({ turnOffPcs: async (groups) => { confirmed.push(groups); } });
    expect(await executePair(retry.deps, ["--remove", "k2"])).toBe(0);
    expect(confirmed).toEqual([[OTHER]]);
    expect(retry.out()).toContain("Finished the earlier removal.");
    expect((await account())?.pendingTurnOff).toBeUndefined();
    await expectCli(executePair(deps({}).deps, ["--remove", "k2"]), "PAIR_NOT_FOUND");
  });
});

describe("ainecto pair — 끝나지 않은 철회가 있는 동안의 등록(리뷰 impl-4 #1·#2)", () => {
  const PAIRED = { kind: "paired", doneError: undefined };
  const account = async () => (await loadPcKeys(keysPath())).accounts[KEY];
  const failingTurnOff = () => deps({
    findPcs: async () => [{ session: "ainecto-pc", pid: 4242, pgid: 4242 }],
    turnOffPcs: async () => { throw new Error("a process in its group 4242 is still alive"); },
  });

  it("철회 실패 중 다른 브라우저가 같은 기본 이름으로 짝지어도 다른 이름을 받고 · 원래 이름으로 재시도해도 새 핀이 남는다 · 실패 안내는 keyId 로", async () => {
    const old = await registerOnce();
    expect(await old.result).toMatchObject(PAIRED);
    const error = await expectCli(executePair(failingTurnOff().deps, ["--remove", "Chrome · macOS"]), "PAIR_REMOVE_STOP_FAILED");
    expect(error.message).toContain(`Run \`ainecto pair --remove ${old.keyId}\` again to finish.`);

    const fresh = await registerOnce();
    expect(await fresh.result).toMatchObject(PAIRED);
    expect((await account())?.browsers.map((item) => [item.keyId, item.name])).toEqual([[fresh.keyId, "Chrome · macOS (2)"]]);

    const retry = deps({});
    expect(await executePair(retry.deps, ["--remove", "Chrome · macOS"])).toBe(0);
    expect(retry.out()).toContain("Finished the earlier removal.");
    expect(await account()).toMatchObject({ browsers: [{ keyId: fresh.keyId, name: "Chrome · macOS (2)" }] });
    expect((await account())?.pendingTurnOff).toBeUndefined();
  });

  it("같은 브라우저(같은 keyId)의 철회가 끝나지 않았으면 재짝짓기는 저장하지 않고 PAIR_REMOVE_PENDING · done 안 보냄 · 철회를 마친 뒤엔 짝지어진다", async () => {
    const first = await registerOnce();
    expect(await first.result).toMatchObject(PAIRED);
    await expectCli(executePair(failingTurnOff().deps, ["--remove", first.keyId]), "PAIR_REMOVE_STOP_FAILED");
    const pending = (await account())?.pendingTurnOff;

    const again = await registerOnce(first.browser.own);
    const error = await expectCli(again.result, "PAIR_REMOVE_PENDING");
    expect(error.message).toContain(`ainecto pair --remove ${first.keyId}`);
    expect(again.browser.state.done).toBe(0);
    expect(again.browser.state.aborts).toEqual(["error"]);
    expect(await account()).toMatchObject({ browsers: [], pendingTurnOff: pending });

    expect(await executePair(deps({}).deps, ["--remove", first.keyId])).toBe(0);
    expect((await account())?.pendingTurnOff).toBeUndefined();
    const later = await registerOnce(first.browser.own);
    expect(await later.result).toMatchObject(PAIRED);
    expect(later.browser.state.pinnedPc).toBe(true);
    expect((await account())?.browsers.map((item) => item.keyId)).toEqual([first.keyId]);
  });

  it("같은 철회를 두 호출(A·B)이 처리하다 B 가 먼저 끝나 재짝짓기 → 새 철회 C 의 조회 실패 → A 의 늦은 완료는 C 의 표지를 지우지 않는다 · 재짝짓기는 계속 PAIR_REMOVE_PENDING · 같은 명령이 조회·종료로 들어가 끝낸다(리뷰 impl-5)", async () => {
    const first = await registerOnce();
    expect(await first.result).toMatchObject(PAIRED);
    await expectCli(executePair(failingTurnOff().deps, ["--remove", first.keyId]), "PAIR_REMOVE_STOP_FAILED");

    // A — 같은 철회의 재시도. 끄기 확인 중에 멈춰 있다.
    let aIn!: () => void;
    const aInTurnOff = new Promise<void>((resolve) => { aIn = resolve; });
    let finishA!: () => void;
    const aGate = new Promise<void>((resolve) => { finishA = resolve; });
    const a = deps({ turnOffPcs: async () => { aIn(); await aGate; } });
    const late = executePair(a.deps, ["--remove", first.keyId]);
    await aInTurnOff;
    // B — 같은 철회의 다른 재시도가 먼저 끝나 표지를 치운다.
    expect(await executePair(deps({}).deps, ["--remove", first.keyId])).toBe(0);
    expect((await account())?.pendingTurnOff).toBeUndefined();

    // 같은 브라우저를 다시 짝짓고 → 새 핀을 철회(C)했는데 PC 연결 조회가 실패했다.
    const again = await registerOnce(first.browser.own);
    expect(await again.result).toMatchObject(PAIRED);
    const reset = deps({ findPcs: async () => { throw Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }); } });
    const error = await expectCli(executePair(reset.deps, ["--remove", first.keyId]), "PAIR_REMOVE_STOP_FAILED");
    expect(error.message).toContain(`Run \`ainecto pair --remove ${first.keyId}\` again to finish.`);
    const pendingC = (await account())?.pendingTurnOff;
    expect(pendingC?.removals.map((item) => item.keyId)).toEqual([first.keyId]);

    // A 의 늦은 완료 — 자기 철회만 뺀다. C 는 남는다.
    finishA();
    expect(await late).toBe(0);
    expect(a.out()).toContain("Finished the earlier removal.");
    expect((await account())?.pendingTurnOff).toEqual(pendingC);

    const blocked = await registerOnce(first.browser.own);
    await expectCli(blocked.result, "PAIR_REMOVE_PENDING");
    expect(blocked.browser.state.done).toBe(0);

    let finds = 0;
    const retry = deps({ findPcs: async () => { finds += 1; return []; } });
    expect(await executePair(retry.deps, ["--remove", first.keyId])).toBe(0);
    expect(finds).toBe(1);
    expect(retry.out()).toContain("Finished the earlier removal.");
    expect(await account()).toMatchObject({ browsers: [] });
    expect((await account())?.pendingTurnOff).toBeUndefined();
  });

  it("옛 표지 항목(철회 식별자 없음)도 같은 명령으로 끝낸다 — 그 철회의 식별자는 keyId 로 읽는다", async () => {
    const first = await registerOnce();
    expect(await first.result).toMatchObject(PAIRED);
    const stored = await account();
    if (!stored) throw new Error("pairing did not save the account");
    await writeFile(keysPath(), JSON.stringify({ accounts: { [KEY]: { pcKey: stored.pcKey, browsers: [],
      pendingTurnOff: { removedAt: "2026-11-21T09:00:00.000Z", groups: [], removals: [{ keyId: first.keyId, name: "Chrome · macOS" }] } } } }));
    expect((await account())?.pendingTurnOff?.removals).toEqual([{ removalId: first.keyId, keyId: first.keyId, name: "Chrome · macOS" }]);
    await expectCli((await registerOnce(first.browser.own)).result, "PAIR_REMOVE_PENDING");
    const retry = deps({});
    expect(await executePair(retry.deps, ["--remove", first.keyId])).toBe(0);
    expect(retry.out()).toContain("Finished the earlier removal.");
    expect((await account())?.pendingTurnOff).toBeUndefined();
  });
});

describe("ainecto pair --list · --remove", () => {
  it("목록(사람·JSON) · keyId 나 이름으로 지우기 · 없으면 PAIR_NOT_FOUND — 비대화형에서도 된다", async () => {
    const pcKey = await generateSigningJwk();
    const pub = publicJwkOf(await generateSigningJwk());
    let keys = withBrowser({ accounts: {} }, KEY, pcKey, { keyId: "k1", publicJwk: pub, name: "Work", pairedAt: "2026-11-21T00:00:00.000Z" });
    keys = withBrowser(keys, KEY, pcKey, { keyId: "k2", publicJwk: pub, name: "Home", pairedAt: "2026-11-21T01:00:00.000Z" });
    await updatePcKeys(keysPath(), () => keys);

    const human = deps({});
    expect(await executePair(human.deps, ["--list"])).toBe(0);
    expect(human.out()).toContain("  k1  Work  (registered 2026-11-21T00:00:00.000Z)");
    const json = deps({ json: true });
    expect(await executePair(json.deps, ["--list"])).toBe(0);
    expect(JSON.parse(json.out())).toMatchObject({ data: { browsers: [{ keyId: "k1", name: "Work" }, { keyId: "k2", name: "Home" }] } });

    expect(await executePair(deps({}).deps, ["--remove", "k1"])).toBe(0);
    const byName = deps({});
    expect(await executePair(byName.deps, ["--remove", "Home"])).toBe(0);
    expect(byName.out()).toContain('Removed "Home" (k2).');
    expect((await loadPcKeys(keysPath())).accounts[KEY]?.browsers).toEqual([]);
    await expectCli(executePair(deps({}).deps, ["--remove", "Work"]), "PAIR_NOT_FOUND");

    const empty = deps({});
    expect(await executePair(empty.deps, ["--list"])).toBe(0);
    expect(empty.out()).toContain("No browsers are registered with this PC.");
  });
});
