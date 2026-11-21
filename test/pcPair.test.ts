import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePair, type PairDeps, type TtyIO } from "../src/adapters/cli/pairCommand";
import { CliCommandError } from "../src/adapters/cli/errors";
import { loadPcKeys, savePcKeys, withBrowser } from "../src/core/pc/pcKeys";
import { PAIR_WAIT_MS, type BrowserOffer, type PairTransport } from "../src/core/pc/pcPairing";
import { accountKey, normalizePcSettings, savePcSettings, withConsent } from "../src/core/pc/pcSettings";
import {
  assertCommitment,
  generateSigningJwk,
  pairCodes,
  pairDoneInput,
  pairTranscript,
  publicJwkFromRaw,
  publicJwkOf,
  publicRawFromJwk,
  randomBytes,
  verifyBytes,
  type EcPrivateJwk,
  type PairCodes,
} from "../src/core/term/e2e";

/**
 * `ainecto pair` 의 PC 쪽 순서 — 서버 중계는 가짜(transport)지만 그 뒤의 브라우저는 진짜 암호(e2e.ts)로 행동한다:
 * 약속값 대조 · 같은 T 로 코드 계산 · done 서명 검증. 파일은 임시 HOME 의 실제 pc.json·pc-keys.json.
 */
const ENDPOINT = "https://example.test/mcp";
const KEY = accountKey(ENDPOINT, "u1");

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
  /** 드러내기를 받은 뒤(코드를 치기 전) 다른 일이 끼어든다. */
  afterReveal?: () => Promise<void>;
}) {
  const own: EcPrivateJwk = await generateSigningJwk();
  const ownPub = publicRawFromJwk(own);
  const nB = randomBytes(32);
  const state: { commit?: Uint8Array; pcPub?: Uint8Array; transcript?: Uint8Array; codes?: PairCodes; pinnedPc: boolean; done: number } = {
    pinnedPc: false, done: 0,
  };
  const transport: PairTransport = {
    async offer(commit, signal) {
      if (options.never) {
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      state.commit = commit;
      const relayed: BrowserOffer = {
        keyId: options.keyId ?? "9d2b7e4a-61c3-4f0e-8a5d-3b1c7e9f2a64",
        publicRaw: options.relaySwapsKey ? publicRawFromJwk(await generateSigningJwk()) : ownPub,
        nB,
        name: options.name ?? "Chrome · macOS",
      };
      return relayed;
    },
    async reveal(pcPub, nP) {
      if (!state.commit) throw new Error("reveal before offer");
      await assertCommitment(state.commit, pcPub, nP);
      state.pcPub = pcPub;
      state.transcript = await pairTranscript({ accountKey: KEY, pcId: options.pcId, pcPublicRaw: pcPub, browserPublicRaw: ownPub, nP, nB });
      state.codes = await pairCodes(state.transcript);
      await options.afterReveal?.();
    },
    async done(signature) {
      state.done += 1;
      if (options.failDone) throw new Error("relay closed");
      if (!state.pcPub || !state.transcript) throw new Error("done before reveal");
      state.pinnedPc = await verifyBytes(publicJwkFromRaw(state.pcPub), signature, pairDoneInput(state.transcript));
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

function deps(overrides: Partial<PairDeps> & { transport?: () => PairTransport }) {
  let out = "";
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
    account: async () => ({ userId: "u1" }),
    transport: () => { throw new Error("no transport in this test"); },
    waitMs: 10_000,
    now: () => new Date("2026-11-21T09:00:00Z"),
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

describe("ainecto pair — PC 앞 짝짓기(설계 r2 §11-1)", () => {
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
      keyId: "9d2b7e4a-61c3-4f0e-8a5d-3b1c7e9f2a64", publicJwk: publicJwkOf(browser.own), name: "Chrome[2J · macOS", pairedAt: "2026-11-21T09:00:00.000Z",
    }]);
    expect((await stat(keysPath())).mode & 0o777).toBe(0o600);
    expect(run.out()).toContain('Paired "Chrome[2J · macOS" with this PC.');
    // ★코드는 /dev/tty 에만 — stdout(파이프로 갈 수 있는 곳)에는 없다.
    expect(run.out()).not.toContain(browser.state.codes?.a ?? "x");
    expect(run.out()).not.toContain(browser.state.codes?.b ?? "x");

    // 두 번째 짝짓기는 같은 PC 키를 쓴다(이미 짝지은 브라우저가 계속 믿는다).
    const pcKey = keys.accounts[KEY]?.pcKey;
    const second = await fakeBrowser({ pcId, keyId: "second-browser" });
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
  });

  it("done 을 못 보내면 PAIR_DONE_FAILED — PC 에는 핀했다고 사유와 지우는 명령을 알린다", async () => {
    const pcId = await approve();
    const browser = await fakeBrowser({ pcId, failDone: true });
    const tty = fakeTty(() => browser.state.codes?.b);
    const error = await expectCli(executePair(deps({ transport: () => browser.transport, openTty: () => tty.tty }).deps, []), "PAIR_DONE_FAILED");
    expect(error.message).toContain("relay closed");
    expect(error.message).toContain("ainecto pair --remove 9d2b7e4a-61c3-4f0e-8a5d-3b1c7e9f2a64");
    expect((await loadPcKeys(keysPath())).accounts[KEY]?.browsers.length).toBe(1);
  });

  it("짝짓는 동안 PC 키가 바뀌면 PAIR_CONFLICT · 브라우저 핀을 넣지 않는다", async () => {
    const pcId = await approve();
    const other = await generateSigningJwk();
    const browser = await fakeBrowser({ pcId, afterReveal: () => savePcKeys(keysPath(), { accounts: { [KEY]: { pcKey: other, browsers: [] } } }) });
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

describe("ainecto pair --list · --remove", () => {
  it("목록(사람·JSON) · keyId 나 이름으로 지우기 · 없으면 PAIR_NOT_FOUND — 비대화형에서도 된다", async () => {
    const pcKey = await generateSigningJwk();
    const pub = publicJwkOf(await generateSigningJwk());
    let keys = withBrowser({ accounts: {} }, KEY, pcKey, { keyId: "k1", publicJwk: pub, name: "Work", pairedAt: "2026-11-21T00:00:00.000Z" });
    keys = withBrowser(keys, KEY, pcKey, { keyId: "k2", publicJwk: pub, name: "Home", pairedAt: "2026-11-21T01:00:00.000Z" });
    await savePcKeys(keysPath(), keys);

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
