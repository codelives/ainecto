import { describe, expect, it } from "vitest";
import { isDefaultEndpoint, resolveEndpoint } from "../src/core/config/endpoints";

describe("endpoint resolution", () => {
  it("uses production by default", () => {
    expect(resolveEndpoint({ envVars: {} }).endpoint).toBe("https://ai-erd.com/mcp");
  });

  it("uses dev endpoint for --env dev", () => {
    expect(resolveEndpoint({ env: "dev", envVars: {} }).endpoint).toBe("https://dev.ai-erd.com/mcp");
  });

  /**
   * ★옛 기본값도 «기본»으로 인정해야 한다.
   *
   * 2026-09-21 에 기본 엔드포인트를 ainecto.com → ai-erd.com 으로 옮겼는데, 이미 설정 파일에
   * 옛 주소를 적어둔 사용자가 있다. isDefaultEndpoint 가 그걸 «사용자 지정»으로 보면
   * 호출처가 불필요한 경고나 분기를 태우게 된다. 옛 주소는 계속 동작하므로 여기서도 기본이다.
   */
  it.each([
    "https://ai-erd.com/mcp",
    "https://dev.ai-erd.com/mcp",
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
