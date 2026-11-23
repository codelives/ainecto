import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerBrowserIfNone, type BrowserRegisterDeps, type PcDeps } from "../src/adapters/cli/pcCommand";
import { loadPcKeys, updatePcKeys, withBrowser } from "../src/core/pc/pcKeys";
import { PAIR_WAIT_MS, type PairTransport } from "../src/core/pc/pcPairing";
import { accountKey, normalizePcSettings, savePcSettings, withConsent } from "../src/core/pc/pcSettings";
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
  registerTag,
  verifyBytes,
} from "../src/core/term/e2e";

/**
 * 브라우저 자동 등록(auto-register-0.15.2 §1·§1-1·§4) — 조건 분기와 한 번의 성공. 중계는 가짜지만 브라우저는 «연 주소의 fragment» 에서 S 를 꺼내
 * 진짜 암호로 macB 를 달고 macP·done 을 검증한다. 파일은 임시 HOME 의 실제 pc.json·pc-keys.json.
 */
const ENDPOINT = "https://dev.ainecto.com/mcp";
const USER_ID = "5B1F2C9E-0A7D-4E63-8F41-9C2D7B6A3E10";
const KEY = accountKey(ENDPOINT, USER_ID);

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "autoreg-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const settingsPath = (): string => join(home, ".ainecto", "pc.json");
const keysPath = (): string => join(home, ".ainecto", "pc-keys.json");

async function approve(remoteTerminal = true): Promise<string> {
  const settings = withConsent(normalizePcSettings(undefined, "test-host"), KEY, remoteTerminal, new Date("2026-11-23T00:00:00Z"));
  await savePcSettings(settingsPath(), settings);
  return settings.pcId;
}

/** 연 주소를 받아 S 로 움직이는 브라우저 + 중계. */
function secretBrowser() {
  const state: { url?: string; done: boolean; macP: boolean } = { done: false, macP: false };
  let commit: Uint8Array | undefined;
  let pcPub: Uint8Array | undefined;
  let transcript: Uint8Array | undefined;
  let keys: Awaited<ReturnType<typeof registerKeys>> | undefined;
  let ownPub: Uint8Array | undefined;
  const nB = randomBytes(32);
  const transport: PairTransport = {
    async offer(sent) {
      commit = sent;
      const [version, , , s] = (state.url?.split("#")[1] ?? "").split(".");
      if (version !== "1" || !s) throw new Error("bad register url");
      keys = await registerKeys(new Uint8Array(Buffer.from(s, "base64url")));
      ownPub = publicRawFromJwk(publicJwkOf(await generateSigningJwk()));
      const keyId = await browserKeyIdOf(ownPub);
      const name = "Chrome · macOS";
      const macB = await registerOfferMac(keys.browser, { userId: USER_ID.toLowerCase(), pcId: (state.url?.split("#")[1] ?? "").split(".")[1] ?? "",
        attemptId: "attempt-1", commit: sent, browserPublicRaw: ownPub, keyId, nB, name });
      return { keyId, publicRaw: ownPub, nB, name, macB, attemptId: "attempt-1" };
    },
    async reveal(pub, nP, _signal, macP) {
      await assertCommitment(commit!, pub, nP);
      pcPub = pub;
      const pcId = (state.url?.split("#")[1] ?? "").split(".")[1] ?? "";
      transcript = await pairTranscript({ userId: USER_ID.toLowerCase(), pcId, pcPublicRaw: pub, browserPublicRaw: ownPub!, nP, nB });
      state.macP = macP !== undefined && macEquals(macP, await registerRevealMac(keys!.pc, { transcript, attemptId: "attempt-1" }));
    },
    async done(signature) {
      state.done = state.macP && await verifyBytes(publicJwkFromRaw(pcPub!), signature, pairDoneInput(transcript!));
    },
    async abort() {},
  };
  return { transport, state };
}

function deps(over: Partial<PcDeps> = {}, register: Partial<BrowserRegisterDeps> = {}) {
  let out = "";
  let err = "";
  const opened: string[] = [];
  const notified: string[] = [];
  const browser = secretBrowser();
  const value: Pick<PcDeps, "io" | "json" | "interactive" | "settingsPath" | "hostName" | "keysPath" | "endpoint" | "register"> = {
    io: {
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      stdout: { write: (text: string) => { out += text; return true; } } as unknown as NodeJS.WriteStream,
      stderr: { write: (text: string) => { err += text; return true; } } as unknown as NodeJS.WriteStream,
    },
    json: false,
    interactive: true,
    settingsPath: settingsPath(),
    hostName: "test-host",
    keysPath: keysPath(),
    endpoint: ENDPOINT,
    register: {
      insideTermSession: false,
      overSsh: false,
      openBrowser: async (url) => { opened.push(url); browser.state.url = url; },
      transport: () => browser.transport,
      notifyPaired: async (item) => { notified.push(item.name); },
      waitMs: PAIR_WAIT_MS,
      interrupt: () => ({ signal: new AbortController().signal, dispose: () => undefined }),
      now: () => new Date("2026-11-23T09:00:00Z"),
      ...register,
    },
    ...over,
  };
  return { deps: value, out: () => out, err: () => err, opened, notified, browser };
}

describe("브라우저 자동 등록 — registerBrowserIfNone(§1-1 조건 넷 · §4)", () => {
  it("조건이 다 맞으면 api 등록 페이지(#1.<pcId>.<tag>.<S>)를 열고 secret 방식으로 등록 → 핀 1 · 알림 · 출력에 S 없음", async () => {
    const pcId = await approve();
    const run = deps();
    await registerBrowserIfNone(run.deps, { key: KEY, userId: USER_ID });
    expect(run.opened).toHaveLength(1);
    const url = run.opened[0] ?? "";
    expect(url).toMatch(new RegExp(`^https://dev\\.ainecto\\.com/api/v1/public/term-register#1\\.${pcId}\\.[A-Za-z0-9_-]{11}\\.[A-Za-z0-9_-]{43}$`));
    const [, , tag, s] = (url.split("#")[1] ?? "").split(".");
    expect(tag).toBe(await registerTag((await registerKeys(new Uint8Array(Buffer.from(s ?? "", "base64url")))).account, USER_ID.toLowerCase()));
    expect(run.browser.state.done).toBe(true);
    expect((await loadPcKeys(keysPath())).accounts[KEY]?.browsers.map((item) => item.name)).toEqual(["Chrome · macOS"]);
    expect(run.notified).toEqual(["Chrome · macOS"]);
    expect(run.err()).toContain("Finish in the browser that just opened (up to 5 min · Ctrl+C to skip)");
    expect(run.out()).toContain('Registered "Chrome · macOS"');
    expect(run.out() + run.err()).not.toContain(s);
  });

  it("등록된 브라우저가 이미 있으면 · 비대화형(파이프·--json)이면 · 터미널 세션 안이면 · 원격이 꺼져 있으면 — 아무것도 하지 않는다", async () => {
    await approve();
    const pcKey = await generateSigningJwk();
    const nothing = async (run: ReturnType<typeof deps>) => {
      await registerBrowserIfNone(run.deps, { key: KEY, userId: USER_ID });
      expect(run.opened).toEqual([]);
      expect(run.out() + run.err()).toBe("");
    };
    await nothing(deps({ interactive: false }));
    await nothing(deps({ json: true }));
    await nothing(deps({}, { insideTermSession: true }));
    await nothing(deps({ register: undefined }));
    await updatePcKeys(keysPath(), (keys) => withBrowser(keys, KEY, pcKey,
      { keyId: "c0495cf983e314e307b0406063614409", publicJwk: publicJwkOf(pcKey), name: "Safari · macOS", pairedAt: "2026-11-22T00:00:00Z" }));
    await nothing(deps());
    await rm(keysPath());
    await approve(false);
    await nothing(deps());
  });

  it("ssh 이거나 브라우저를 못 열면 — «PC 화면의 터미널에서 npx 다시» 한 줄만(pair 아님 · 종료 없음 · 던지지 않음)", async () => {
    await approve();
    const ssh = deps({}, { overSsh: true });
    await registerBrowserIfNone(ssh.deps, { key: KEY, userId: USER_ID });
    expect(ssh.opened).toEqual([]);
    expect(ssh.err()).toContain("Run `npx -y ainecto@latest` in a terminal on this PC's own screen");
    expect(ssh.err()).not.toContain("pair");
    const fail = deps({}, { openBrowser: async () => { throw new Error("no xdg-open"); } });
    await registerBrowserIfNone(fail.deps, { key: KEY, userId: USER_ID });
    expect(fail.err()).toContain("Run `npx -y ainecto@latest` in a terminal on this PC's own screen");
    expect((await loadPcKeys(keysPath())).accounts[KEY]?.browsers ?? []).toEqual([]);
  });

  it("done 을 못 보내면 핀을 거둔다 — 다음 `ainecto` 에서 다시 자동 등록된다", async () => {
    await approve();
    const run = deps();
    run.browser.transport.done = async () => { throw new Error("relay closed"); };
    await registerBrowserIfNone(run.deps, { key: KEY, userId: USER_ID });
    expect(run.err()).toContain("did not get the confirmation (relay closed)");
    expect((await loadPcKeys(keysPath())).accounts[KEY]?.browsers ?? []).toEqual([]);
    expect(run.notified).toEqual([]);
  });
});
