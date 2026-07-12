import { assertLoopbackRedirectUrl, assertTrustedEndpointUrl } from "../config/endpoints";

export interface ClientRegistrationResult {
  clientId: string;
  clientSecret?: string;
}

export async function registerPublicClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ClientRegistrationResult> {
  assertTrustedEndpointUrl(registrationEndpoint, "OAuth client registration endpoint");
  assertLoopbackRedirectUrl(redirectUri);
  const response = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Ainecto CLI",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!response.ok) {
    throw new Error(`OAuth client registration failed with HTTP ${response.status}.`);
  }
  const body = await response.json() as unknown;
  if (!isRecord(body) || typeof body.client_id !== "string") {
    throw new Error("OAuth client registration response did not include client_id.");
  }
  return {
    clientId: body.client_id,
    clientSecret: typeof body.client_secret === "string" ? body.client_secret : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
