import { describe, expect, it } from "vitest";
import { resolveEndpoint } from "../src/core/config/endpoints";

describe("endpoint resolution", () => {
  it("uses production by default", () => {
    expect(resolveEndpoint({ envVars: {} }).endpoint).toBe("https://ainecto.com/mcp");
  });

  it("uses dev endpoint for --env dev", () => {
    expect(resolveEndpoint({ env: "dev", envVars: {} }).endpoint).toBe("https://dev.ainecto.com/mcp");
  });

  it("prefers explicit endpoint over env var", () => {
    expect(resolveEndpoint({
      endpoint: "https://override.example/mcp/",
      envVars: { AINECTO_MCP_ENDPOINT: "https://env.example/mcp" },
    })).toMatchObject({
      endpoint: "https://override.example/mcp",
      source: "flag",
    });
  });

  it("uses AINECTO_MCP_ENDPOINT before defaults", () => {
    expect(resolveEndpoint({
      env: "dev",
      envVars: { AINECTO_MCP_ENDPOINT: "https://env.example/mcp/" },
    })).toMatchObject({
      endpoint: "https://env.example/mcp",
      source: "env",
    });
  });
});
