import { LineDecoder, parseClientMessage, TermProtocolError } from "../src/core/term/protocol";

describe("term line protocol", () => {
  it("splits lines across chunks without breaking a multi-byte character", () => {
    const decoder = new LineDecoder();
    const bytes = Buffer.from('{"op":"ls","id":"한"}\n{"op":"ls"', "utf8");
    const cut = bytes.indexOf(Buffer.from("한")) + 1;
    expect(decoder.push(bytes.subarray(0, cut))).toEqual([]);
    expect(decoder.push(bytes.subarray(cut))).toEqual(['{"op":"ls","id":"한"}']);
    expect(decoder.push(Buffer.from(',"id":"2"}\n'))).toEqual(['{"op":"ls","id":"2"}']);
  });

  it("rejects requests without an id and unknown ops", () => {
    expect(() => parseClientMessage('{"op":"ls"}')).toThrow(TermProtocolError);
    expect(() => parseClientMessage('{"op":"rename","id":"1"}')).toThrow(/Unknown op/);
    expect(parseClientMessage('{"op":"in","d":"aGk="}')).toEqual({ op: "in", d: "aGk=" });
  });

  it("new 의 project — 있으면 소문자 UUID 만 · 없으면 칸 없음(옛 클라이언트 그대로)", () => {
    const base = { op: "new", id: "1", name: "s", cwd: "/tmp", command: null, env: {} };
    const project = "0b9a8c7d-1111-4222-8333-444455556666";
    expect(parseClientMessage(JSON.stringify({ ...base, project }))).toMatchObject({ op: "new", project });
    expect(parseClientMessage(JSON.stringify(base))).not.toHaveProperty("project");
    for (const bad of [project.toUpperCase(), "", "../x", 3]) {
      expect(() => parseClientMessage(JSON.stringify({ ...base, project: bad }))).toThrow(TermProtocolError);
    }
  });
});
