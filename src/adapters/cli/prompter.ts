import { createInterface, type Interface } from "node:readline";

/**
 * 사람에게 묻는 창구. init 은 이 인터페이스만 알고, 시험은 답을 주입한다(설계 §7).
 *
 * <p>★번호로만 고른다. 화살표 메뉴(raw 모드)를 쓰지 않는 이유: raw 모드에서는 readline 이 Ctrl+C 를
 * 가로채 «멈추지 않는다». cooked 모드면 Ctrl+C 는 OS 가 보내는 SIGINT 로 그대로 끝난다(설계 §4-2).
 */
export interface Prompter {
  /** 번호로 하나를 고르게 한다. {@code defaultIndex} 가 없으면 빈 입력은 다시 묻는다. */
  choose<T>(question: string, choices: ReadonlyArray<Choice<T>>, defaultIndex?: number): Promise<T>;
  /** 글 한 줄. 빈 입력이면 기본값. */
  text(question: string, defaultValue: string): Promise<string>;
  close(): void;
}

export interface Choice<T> {
  label: string;
  value: T;
}

/** 질문 중에 입력이 끝났다(EOF, Ctrl+D). init 은 아무것도 쓰지 않고 130 으로 끝낸다. */
export class PromptCancelled extends Error {
  constructor() {
    super("Cancelled — nothing was written.");
    this.name = "PromptCancelled";
  }
}

/**
 * ★대화형 판정의 유일한 자리(설계 §5): stdin·stdout 이 둘 다 TTY 이고 {@code --json} 이 아닐 때만.
 * 에이전트·CI 의 셸 도구는 TTY 가 아니다 — 그때는 묻지 않고, 빠진 값을 말하고 멈춘다.
 */
export function isInteractive(
  io: { stdin?: { isTTY?: boolean }; stdout?: { isTTY?: boolean } },
  json: boolean,
): boolean {
  return io.stdin?.isTTY === true && io.stdout?.isTTY === true && !json;
}

/**
 * readline 으로 묻는다. ★init 한 번에 인터페이스 «하나», 줄 반복자 «하나»다 — 질문마다 새로 만들면
 * 파이프 입력에서 첫 인터페이스가 다음 줄들까지 버퍼로 먹고 닫혀 두 번째 질문이 답을 잃는다(설계 §7).
 * 질문은 stderr 에 쓴다 — stdout 은 결과 전용이다.
 */
export function createReadlinePrompter(io: { stdin: NodeJS.ReadableStream; stderr: NodeJS.WritableStream }): Prompter {
  let rl: Interface | undefined;
  let lines: AsyncIterator<string> | undefined;

  const readLine = async (prompt: string): Promise<string> => {
    io.stderr.write(prompt);
    if (!rl) {
      rl = createInterface({ input: io.stdin, terminal: false });
      lines = rl[Symbol.asyncIterator]();
    }
    const next = await lines!.next();
    if (next.done) {
      io.stderr.write("\n");
      throw new PromptCancelled();
    }
    return next.value;
  };

  return {
    choose: <T>(question: string, choices: ReadonlyArray<Choice<T>>, defaultIndex?: number) =>
      chooseWith(readLine, (text) => io.stderr.write(text), question, choices, defaultIndex),
    text: async (question, defaultValue) => {
      const answer = (await readLine(`${question} [${defaultValue}]: `)).trim();
      return answer || defaultValue;
    },
    close: () => {
      rl?.close();
    },
  };
}

/**
 * 번호 선택의 규칙 — 입력을 어떻게 읽든 같다. {@code defaultIndex} 는 0부터.
 * 빈 입력: 기본값이 있으면 그것, 없으면 다시 묻는다. 범위 밖·숫자 아님: 다시 묻는다.
 */
export async function chooseWith<T>(
  readLine: (prompt: string) => Promise<string>,
  write: (text: string) => void,
  question: string,
  choices: ReadonlyArray<Choice<T>>,
  defaultIndex?: number,
): Promise<T> {
  if (choices.length === 0) {
    throw new Error(`Nothing to choose for: ${question}`);
  }
  write(`${question}\n`);
  choices.forEach((choice, index) => write(`  [${index + 1}] ${choice.label}\n`));
  const hint = defaultIndex === undefined ? "" : ` [${defaultIndex + 1}]`;
  for (;;) {
    const answer = (await readLine(`Enter a number (1-${choices.length})${hint}: `)).trim();
    if (answer === "" && defaultIndex !== undefined) {
      return choices[defaultIndex]!.value;
    }
    const picked = /^\d+$/.test(answer) ? Number(answer) : NaN;
    if (picked >= 1 && picked <= choices.length) {
      return choices[picked - 1]!.value;
    }
    write(answer === ""
      ? "Please choose one — there is no default here.\n"
      : `"${answer}" is not one of the numbers above.\n`);
  }
}
