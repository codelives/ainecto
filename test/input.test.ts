import { describe, expect, it } from "vitest";
import { parsePayloadSource } from "../src/core/input/payloadSource";

describe("parsePayloadSource", () => {
  it("uses --file before stdin and inline payloads", async () => {
    const result = await parsePayloadSource({
      file: "-",
      stdinText: "{\"from\":\"stdin\"}",
      inline: "{\"from\":\"inline\"}",
    });

    expect(result).toMatchObject({
      value: { from: "stdin" },
      source: "stdin",
      warnings: ["Multiple payload sources were provided; --file takes precedence."],
    });
  });

  it("uses stdin before inline payloads", async () => {
    const result = await parsePayloadSource({
      stdinText: "{\"from\":\"stdin\"}",
      inline: "{\"from\":\"inline\"}",
    });

    expect(result).toMatchObject({
      value: { from: "stdin" },
      source: "stdin",
      warnings: ["Multiple payload sources were provided; stdin takes precedence."],
    });
  });

  it("falls back to inline JSON when stdin is a TTY", async () => {
    await expect(parsePayloadSource({
      stdinIsTTY: true,
      inline: "{\"ok\":true}",
    })).resolves.toMatchObject({
      value: { ok: true },
      source: "inline",
    });
  });
});
