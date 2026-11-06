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
});
