import { describe, expect, it } from "vitest";
import { renderError } from "../src/core/output/render";

describe("renderError", () => {
  it("redacts secret-like error details in JSON output", () => {
    const error = Object.assign(new Error("request failed"), {
      details: {
        authorization: "Bearer secret-token",
        nested: {
          access_token: "access-secret",
          refreshToken: "refresh-secret",
          body: "{\"client_secret\":\"client-secret\",\"token\":\"body-token\"}",
        },
      },
    });

    const output = renderError(error, { json: true });
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("access-secret");
    expect(output).not.toContain("refresh-secret");
    expect(output).not.toContain("client-secret");
    expect(output).not.toContain("body-token");
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      error: {
        details: {
          authorization: "[redacted]",
          nested: {
            access_token: "[redacted]",
            refreshToken: "[redacted]",
            body: "{\"client_secret\":\"[redacted]\",\"token\":\"[redacted]\"}",
          },
        },
      },
    });
  });
});
