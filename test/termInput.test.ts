import { DetachKeyScanner } from "../src/core/term/detachKey";
import { assertSessionName } from "../src/core/term/sessionName";

describe("term detach key", () => {
  it("detaches on Ctrl-\\ d, even when the two bytes arrive in different chunks", () => {
    const scanner = new DetachKeyScanner();
    expect(scanner.scan(Buffer.from("ls\x1c"))).toEqual({ forward: Buffer.from("ls"), detach: false });
    expect(scanner.scan(Buffer.from("d"))).toEqual({ forward: Buffer.from(""), detach: true });
  });

  it("passes Ctrl-\\ Ctrl-\\ as one Ctrl-\\ and Ctrl-\\ x as both bytes", () => {
    const scanner = new DetachKeyScanner();
    expect(scanner.scan(Buffer.from("\x1c\x1c\x1cx"))).toEqual({ forward: Buffer.from("\x1c\x1cx"), detach: false });
  });
});

describe("term session names", () => {
  it("refuses names that look like flags or contain spaces", () => {
    expect(() => assertSessionName("ainecto-root")).not.toThrow();
    expect(() => assertSessionName("-x")).toThrow(/session name/);
    expect(() => assertSessionName("a b")).toThrow(/session name/);
    expect(() => assertSessionName("")).toThrow(/session name/);
  });
});
