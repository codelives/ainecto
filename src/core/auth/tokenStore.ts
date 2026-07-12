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
  load(endpoint: string): Promise<StoredTokenSet | undefined>;
  save(endpoint: string, token: StoredTokenSet): Promise<void>;
  delete(endpoint: string): Promise<void>;
}

type TokenFile = Record<string, StoredTokenSet>;

export class FileTokenStore implements TokenStore {
  readonly filePath: string;

  constructor(rootDir = join(homedir(), ".ainecto")) {
    this.filePath = join(rootDir, "tokens.json");
  }

  async load(endpoint: string): Promise<StoredTokenSet | undefined> {
    const file = await this.readFile();
    return file[tokenKey(endpoint)];
  }

  async save(endpoint: string, token: StoredTokenSet): Promise<void> {
    const file = await this.readFile();
    file[tokenKey(endpoint)] = { ...token, endpoint, updatedAt: new Date().toISOString() };
    await this.writeFile(file);
  }

  async delete(endpoint: string): Promise<void> {
    const file = await this.readFile();
    delete file[tokenKey(endpoint)];
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

export function tokenKey(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
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
