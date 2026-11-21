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

  it("new 의 input — \"none\" 만 싣는다 · 없으면 칸 없음(입력 받음 — 옛 클라이언트 그대로)", () => {
    const base = { op: "new", id: "1", name: "s", cwd: "/tmp", command: null, env: {} };
    expect(parseClientMessage(JSON.stringify({ ...base, input: "none" }))).toMatchObject({ op: "new", input: "none" });
    expect(parseClientMessage(JSON.stringify(base))).not.toHaveProperty("input");
    for (const bad of ["terminal", "", true, 0]) {
      expect(() => parseClientMessage(JSON.stringify({ ...base, input: bad }))).toThrow(TermProtocolError);
    }
  });

  it("세션을 겨누는 op 의 instance(§14-6 4) — 있으면 빈 글이 아닌 문자열 · 없으면 칸 없음(로컬 term 그대로) · read·attach 는 받지 않는다", () => {
    for (const body of [
      { op: "send", id: "1", name: "s", text: "x", paste: false },
      { op: "key", id: "1", name: "s", key: "enter" },
      { op: "kill", id: "1", name: "s" },
      { op: "label", id: "1", name: "s", label: "L" },
      { op: "set-size", id: "1", name: "s", cols: 80, rows: 24 },
    ]) {
      expect(parseClientMessage(JSON.stringify({ ...body, instance: "i-1" }))).toMatchObject({ ...body, instance: "i-1" });
      expect(parseClientMessage(JSON.stringify(body))).not.toHaveProperty("instance");
      for (const bad of ["", 3, null]) {
        expect(() => parseClientMessage(JSON.stringify({ ...body, instance: bad }))).toThrow(TermProtocolError);
      }
    }
    expect(parseClientMessage(JSON.stringify({ op: "read", id: "1", name: "s", instance: "i-1" }))).not.toHaveProperty("instance");
  });
});
