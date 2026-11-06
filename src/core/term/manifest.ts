import { readFile, rename, writeFile } from "node:fs/promises";
import { isNodeError, PRIVATE_FILE_MODE } from "../fs/privateFiles";

/**
 * 복원 매니페스트 `sessions.json` — 데몬이 죽거나 재부팅된 뒤 `ainecto term restore` 가 다시 띄울 목록(설계 2-6).
 * ★쓰는 것은 잠금을 쥔 데몬 하나뿐이다. 환경변수 값은 싣지 않는다(비밀이 지나갈 수 있다) — 복원 때는
 *   `restore` 를 부른 셸의 환경으로 띄운다.
 */
export interface ManifestEntry {
  name: string;
  cwd: string;
  /** 없으면 로그인 셸. */
  command: string[] | null;
  createdAt: string;
}

interface ManifestFile {
  sessions: ManifestEntry[];
}

export async function readManifest(path: string): Promise<ManifestEntry[]> {
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
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Partial<ManifestFile>).sessions)) {
    throw new Error(`${path} is not a session manifest.`);
  }
  return (parsed as ManifestFile).sessions.filter(isEntry);
}

/** 통째로 바꿔 쓴다(임시 파일 → rename) — 중간에 죽어도 반쪽 파일이 남지 않는다. */
export async function writeManifest(path: string, sessions: readonly ManifestEntry[]): Promise<void> {
  const tmpPath = `${path}.${process.pid}.tmp`;
  const file: ManifestFile = { sessions: [...sessions] };
  await writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
  await rename(tmpPath, path);
}

function isEntry(value: unknown): value is ManifestEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.name === "string"
    && typeof entry.cwd === "string"
    && typeof entry.createdAt === "string"
    && (entry.command === null || (Array.isArray(entry.command) && entry.command.every((item) => typeof item === "string")));
}
