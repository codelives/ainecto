import { describe, expect, it, vi } from "vitest";
import { registerPublicClient } from "../src/core/auth/clientRegistration";

describe("client registration", () => {
  it("registers a public loopback client", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        redirect_uris: ["http://127.0.0.1:1234/callback"],
        token_endpoint_auth_method: "none",
      });
      return new Response(JSON.stringify({ client_id: "registered-client" }));
    });

    await expect(registerPublicClient(
      "https://auth.example/register",
      "http://127.0.0.1:1234/callback",
      fetchImpl,
    )).resolves.toEqual({ clientId: "registered-client" });
  });
});
