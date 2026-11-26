import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { isNodeError, PRIVATE_FILE_MODE } from "../fs/privateFiles";
import { isEndedRecord, type EndedRecord } from "./protocol";

/**
 * 끝 기록 책 `ended.json` — 세션이 끝난 사실을 서버 장부가 받을 때까지 남긴다(설계 term-ledger-cli-unit-prep 1절). 못 읽는 동안의 새 줄은 `ended.pending.json`(daemon.ts updateEnded).
 * ★쓰는 것은 잠금을 쥔 데몬 하나뿐이다(매니페스트와 같은 규칙). 다리가 서버 2xx 를 받은 뒤 ended-ack 로 지운다 —
 *   그 사이 브리지·데몬이 죽어도 책이 남아 다음 다리가 다시 싣는다(서버는 같은 기록 두 번을 한 번으로 본다).
 * 크기: 이름당 1건 — 같은 이름의 새 끝이 오면 옛 줄을 바꿔 끼운다({@link withEnded}).
 */
export async function readEndedBook(path: string): Promise<EndedRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { ended?: unknown }).ended)) {
    throw new Error(`${path} is not an ended-session book.`);
  }
  return (parsed as { ended: unknown[] }).ended.filter(isEndedRecord);
}

/** 통째로 바꿔 쓴다(임시 파일 → rename) — 중간에 죽어도 반쪽 파일이 남지 않는다. */
export async function writeEndedBook(path: string, ended: readonly EndedRecord[]): Promise<void> {
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify({ ended: [...ended] }, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
  await rename(tmpPath, path);
}

/** 책 파일을 지운다(없으면 그대로) — 합친 뒤의 병합 대기 파일. */
export async function removeEndedBook(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** 새 끝 기록을 넣는다 — 같은 이름의 옛 줄은 뺀다(순수 함수). 밀려난 옛 instance 는 서버에서 «확인 안 됨»으로 남는다. */
export function withEnded(book: readonly EndedRecord[], record: EndedRecord): EndedRecord[] {
  return [...book.filter((item) => item.name !== record.name), record];
}

/** 서버가 받은 instance 들을 뺀다(순수 함수). */
export function withoutAcked(book: readonly EndedRecord[], instances: readonly string[]): EndedRecord[] {
  const acked = new Set(instances);
  return book.filter((item) => !acked.has(item.instance));
}

/**
 * 시작 때 못 읽었던 책을 다시 읽었을 때 합친다(순수 함수) — 파일의 줄 위에 그동안 메모리에 생긴 줄을 얹고(같은 이름은 메모리 것),
 * 그동안 ack 한 instance 는 뺀다. 원본의 미전송 기록을 잃지 않는다(리뷰 0.16.6 P1-2).
 */
export function mergeEnded(stored: readonly EndedRecord[], memory: readonly EndedRecord[], acked: ReadonlySet<string>): EndedRecord[] {
  return memory.reduce((book, record) => withEnded(book, record), withoutAcked(stored, [...acked]));
}

/**
 * 목록을 읽은 뒤 수신처 표시(listed-to) 전에 끝난 세션(리뷰 r2 P1-1) — 끝 책으로 옮겨 갔어도 같은 uuid 다. 수신처가 빈 줄에만 찍는다
 * (이미 찍힌 수신처는 그대로 · 순수 함수). 안 찍으면 다음 번에 «아무도 못 본 끝»으로 올리지 않고 지워졌다.
 */
export function withListedTo(book: readonly EndedRecord[], instances: ReadonlySet<string>, to: string): EndedRecord[] {
  return book.map((record) => (record.to === undefined && instances.has(record.instance) ? { ...record, to } : record));
}
