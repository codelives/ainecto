import { describe, expect, it } from "vitest";
import { isDefaultEndpoint, resolveEndpoint } from "../src/core/config/endpoints";

describe("endpoint resolution", () => {
  it("uses production by default", () => {
    expect(resolveEndpoint({ envVars: {} }).endpoint).toBe("https://ainecto.com/mcp");
  });

  it("uses dev endpoint for --env dev", () => {
    expect(resolveEndpoint({ env: "dev", envVars: {} }).endpoint).toBe("https://dev.ainecto.com/mcp");
  });

  it.each([
    "https://ainecto.com/mcp",
    "https://dev.ainecto.com/mcp",
  ])("%s 는 기본 엔드포인트로 인정한다", (endpoint) => {
    expect(isDefaultEndpoint(endpoint)).toBe(true);
  });

  it("관계없는 주소는 기본이 아니다", () => {
    expect(isDefaultEndpoint("https://example.com/mcp")).toBe(false);
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

  it("rejects non-loopback http endpoints", () => {
    expect(() => resolveEndpoint({
      endpoint: "http://example.com/mcp",
      envVars: {},
    })).toThrow("must use https");
  });

  it("allows localhost http endpoints for local development", () => {
    expect(resolveEndpoint({
      endpoint: "http://127.0.0.1:8081/mcp",
      envVars: {},
    })).toMatchObject({
      endpoint: "http://127.0.0.1:8081/mcp",
      source: "flag",
    });
  });

  it("applies the same policy to AINECTO_MCP_ENDPOINT", () => {
    expect(() => resolveEndpoint({
      envVars: { AINECTO_MCP_ENDPOINT: "http://malicious.example/mcp" },
    })).toThrow("must use https");
  });
});
