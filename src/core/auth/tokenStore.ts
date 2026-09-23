import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredTokenSet {
  endpoint: string;
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number;
  scope?: string;
  clientId?: string;
  clientSecret?: string;
  authorizationServer?: string;
  updatedAt: string;
}

export interface TokenStore {
  load(endpoint: string, role?: string): Promise<StoredTokenSet | undefined>;
  save(endpoint: string, token: StoredTokenSet, role?: string): Promise<void>;
  delete(endpoint: string, role?: string): Promise<void>;
}

type TokenFile = Record<string, StoredTokenSet>;

export class FileTokenStore implements TokenStore {
  readonly filePath: string;

  constructor(rootDir = join(homedir(), ".ainecto")) {
    this.filePath = join(rootDir, "tokens.json");
  }

  async load(endpoint: string, role?: string): Promise<StoredTokenSet | undefined> {
    const file = await this.readFile();
    return file[tokenKey(endpoint, role)];
  }

  async save(endpoint: string, token: StoredTokenSet, role?: string): Promise<void> {
    const file = await this.readFile();
    file[tokenKey(endpoint, role)] = { ...token, endpoint, updatedAt: new Date().toISOString() };
    await this.writeFile(file);
  }

  async delete(endpoint: string, role?: string): Promise<void> {
    const file = await this.readFile();
    delete file[tokenKey(endpoint, role)];
    await this.writeFile(file);
  }

  private async readFile(): Promise<TokenFile> {
    try {
      await this.hardenExistingPermissions();
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Token file must contain an object.");
      }
      return parsed as TokenFile;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return {};
      }
      throw error;
    }
  }

  private async writeFile(file: TokenFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.filePath), 0o700);
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }

  private async hardenExistingPermissions(): Promise<void> {
    const dirPath = dirname(this.filePath);
    await chmodIfPermissive(dirPath, 0o700);
    await chmodIfPermissive(this.filePath, 0o600);
  }
}

/**
 * ★역할마다 토큰을 «따로» 둔다.
 *
 * <p>하나로 두면 design 세션으로 로그인하는 순간 development 세션의 토큰이 덮여, 돌고 있던
 * 세션의 역할이 몰래 바뀐다. 역할이 토큰에 박히는 설계에서 토큰 저장소가 한 칸이면 그 칸이
 * 곧 역할 전환 스위치가 된다.
 *
 * <p>역할이 없으면 종전 키 그대로다 — 이미 로그인해 둔 사람이 다시 로그인하지 않아도 된다.
 */
export function tokenKey(endpoint: string, role?: string): string {
  const material = role && role.trim() ? `${endpoint}#role=${role.trim().toLowerCase()}` : endpoint;
  return createHash("sha256").update(material).digest("hex");
}

export async function tokenStorePermissions(path: string): Promise<{ mode: number } | undefined> {
  try {
    const result = await stat(path);
    return { mode: result.mode & 0o777 };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function tokenStoreDirectoryPermissions(path: string): Promise<{ mode: number } | undefined> {
  return tokenStorePermissions(dirname(path));
}

export async function removeTokenStoreForTests(path: string): Promise<void> {
  await rm(dirname(path), { recursive: true, force: true });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function chmodIfPermissive(path: string, mode: number): Promise<void> {
  try {
    const result = await stat(path);
    if ((result.mode & 0o077) !== 0) {
      await chmod(path, mode);
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}
