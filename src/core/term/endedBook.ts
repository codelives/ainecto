import { readFile, rename, writeFile } from "node:fs/promises";
import { isNodeError, PRIVATE_FILE_MODE } from "../fs/privateFiles";
import { isEndedRecord, type EndedRecord } from "./protocol";

/**
 * 끝 기록 책 `ended.json` — 세션이 끝난 사실을 서버 장부가 받을 때까지 남긴다(설계 term-ledger-cli-unit-prep 1절).
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

/** 새 끝 기록을 넣는다 — 같은 이름의 옛 줄은 뺀다(순수 함수). 밀려난 옛 instance 는 서버에서 «확인 안 됨»으로 남는다. */
export function withEnded(book: readonly EndedRecord[], record: EndedRecord): EndedRecord[] {
  return [...book.filter((item) => item.name !== record.name), record];
}

/** 서버가 받은 instance 들을 뺀다(순수 함수). */
export function withoutAcked(book: readonly EndedRecord[], instances: readonly string[]): EndedRecord[] {
  const acked = new Set(instances);
  return book.filter((item) => !acked.has(item.instance));
}
