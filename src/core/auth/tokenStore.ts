import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ROLE_SCOPE_PREFIX } from "../harness/role";

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

/**
 * 토큰 저장소 — ★서버(endpoint)마다 «한 칸»이다(설계 0.4.2 §2-4).
 *
 * <p>역할은 더는 토큰 칸이 정하지 않는다. 역할은 저장소(init 이 쓴 --role)에서 와서 요청 헤더로 실린다.
 * 0.4.1 이하가 쓴 역할별 칸은 읽지도 지우지도 않는다(사용자 결정 «마이그레이션은 고려하지 마»).
 */
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
    assertNoRoleScope(token);
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

/** 서버 하나의 칸. 0.4.1 이하의 «역할 없는» 칸과 같은 키다 — 그때 역할 없이 로그인해 둔 사람은 그대로 쓴다. */
export function tokenKey(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

/**
 * ★역할 scope 가 든 토큰은 이 칸에 두지 않는다(설계 0.4.2 §2-4, 리뷰 P0-1).
 *
 * <p>토큰에 역할이 박혀 있으면 서버는 헤더보다 토큰을 믿는다. 그런 토큰이 이 한 칸에 들어가면 «모든»
 * 저장소에서 그 역할이 헤더를 이겨 역할이 뒤바뀐다. 지금은 그런 토큰을 받을 경로가 없지만(로그인에 역할을
 * 싣지 않는다), 저장 경계에서 막아 두면 새 경로가 생겨도 조용히 새지 않는다.
 */
export function assertNoRoleScope(token: Pick<StoredTokenSet, "scope">): void {
  if (token.scope?.split(/\s+/).some((scope) => scope.startsWith(ROLE_SCOPE_PREFIX))) {
    throw new Error(
      "Refusing to store a role-scoped access token: sign-in is one per machine and the role comes "
      + "from the repository. Run `ai-erd auth login` again.",
    );
  }
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
