import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileTokenStore, tokenStoreDirectoryPermissions, tokenStorePermissions } from "../src/core/auth/tokenStore";

describe("FileTokenStore", () => {
  it("stores endpoint-scoped tokens with 0600 file permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "ainecto-token-store-"));
    const store = new FileTokenStore(root);
    await store.save("https://dev.ainecto.com/mcp", {
      endpoint: "https://dev.ainecto.com/mcp",
      accessToken: "redacted",
      updatedAt: new Date().toISOString(),
    });

    await expect(store.load("https://dev.ainecto.com/mcp")).resolves.toMatchObject({
      accessToken: "redacted",
    });
    await expect(tokenStorePermissions(store.filePath)).resolves.toEqual({ mode: 0o600 });
  });

  it("hardens permissive existing token store permissions on load", async () => {
    const root = await mkdtemp(join(tmpdir(), "ainecto-token-store-"));
    const store = new FileTokenStore(root);
    await store.save("https://dev.ainecto.com/mcp", {
      endpoint: "https://dev.ainecto.com/mcp",
      accessToken: "redacted",
      updatedAt: new Date().toISOString(),
    });
    await chmod(root, 0o755);
    await chmod(store.filePath, 0o644);

    await expect(store.load("https://dev.ainecto.com/mcp")).resolves.toMatchObject({
      accessToken: "redacted",
    });
    await expect(tokenStoreDirectoryPermissions(store.filePath)).resolves.toEqual({ mode: 0o700 });
    await expect(tokenStorePermissions(store.filePath)).resolves.toEqual({ mode: 0o600 });
  });
});
