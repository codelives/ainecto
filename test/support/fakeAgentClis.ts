import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 가짜 `claude`·`codex` — PATH 앞에 두는 기록 스크립트(설계 §7-3 cli 표적).
 * ★실 사용자 설정(~/.claude, ~/.codex)을 건드리지 않는다: 상태는 임시 HOME 아래 파일 하나다.
 *
 * <p>모양은 실측한 출력을 따른다(claude 2.1.303·2.1.306 · codex 0.163.0):
 * <ul>
 *   <li>{@code claude mcp get ainecto} — 있으면 «Scope: / Type: / Command: / Args:»(원격은 «Type: http / URL:») 줄, 없으면
 *       `No MCP server named "ainecto".` + 종료 1. add 는 같은 범위에 있으면 거절(종료 1).</li>
 *   <li>{@code codex mcp get ainecto --json} — 있으면 JSON({transport:{command,args}}), 없으면
 *       `Error: No MCP server named 'ainecto' found.` + 종료 1. add 는 덮어쓴다({@code --url} 이면 원격).
 *       ★진짜 codex 는 원격 add 때 OAuth 로그인을 시작한다 — 가짜는 그 출력(로그인 링크)만 흉내 낸다.
 *       {@code codex.fail} 이 있으면 항목을 쓴 «뒤» 실패한다(로그인 한도 초과와 같은 모양).</li>
 * </ul>
 * 상태 파일 한 줄: `command|arg1 arg2…` 또는 `url|https://…`. 실행마다 `<name>.log` 에 인자를 한 줄씩 남긴다.
 */
const CLAUDE = `#!/bin/sh
STATE="$FAKE_AGENT_HOME/claude.state"
echo "$*" >> "$FAKE_AGENT_HOME/claude.log"
[ -f "$FAKE_AGENT_HOME/claude.fail" ] && case "$*" in *"mcp add"*) echo "boom: add failed" >&2; exit 1;; esac
case "$1 $2" in
  "mcp get")
    if [ -f "$STATE" ]; then
      KIND=$(cut -d'|' -f1 "$STATE"); VALUE=$(cut -d'|' -f2- "$STATE")
      echo "ainecto:"
      echo "  Scope: User config (available in all your projects)"
      if [ "$KIND" = "url" ]; then echo "  Type: http"; echo "  URL: $VALUE";
      else CMD=$(echo "$VALUE" | cut -d' ' -f1); ARGS=$(echo "$VALUE" | cut -s -d' ' -f2-); echo "  Type: stdio"; echo "  Command: $CMD"; echo "  Args: $ARGS"; fi
      exit 0
    fi
    echo 'No MCP server named "ainecto". Run \`claude mcp add\` to add one.'; exit 1;;
  "mcp add")
    if [ -f "$STATE" ]; then echo "MCP server ainecto already exists in user config" >&2; exit 1; fi
    case "$*" in *"--transport http"*) for a in "$@"; do URL="$a"; done; echo "url|$URL" > "$STATE"; echo "Added HTTP MCP server ainecto with URL: $URL to user config"; exit 0;; esac
    while [ "$1" != "--" ]; do shift; done; shift
    echo "cmd|$*" > "$STATE"; echo "Added stdio MCP server ainecto"; exit 0;;
  "mcp remove")
    if [ -f "$STATE" ]; then rm "$STATE"; echo "Removed MCP server ainecto from user config"; exit 0; fi
    echo 'No MCP server named "ainecto" in user scope' >&2; exit 1;;
esac
exit 2
`;

const CODEX = `#!/bin/sh
STATE="$FAKE_AGENT_HOME/codex.state"
echo "$*" >> "$FAKE_AGENT_HOME/codex.log"
case "$1 $2" in
  "mcp get")
    if [ -f "$STATE" ]; then
      KIND=$(cut -d'|' -f1 "$STATE"); VALUE=$(cut -d'|' -f2- "$STATE")
      if [ "$KIND" = "url" ]; then echo "{\\"name\\":\\"ainecto\\",\\"transport\\":{\\"type\\":\\"streamable_http\\",\\"url\\":\\"$VALUE\\"}}"; exit 0; fi
      CMD=$(echo "$VALUE" | cut -d' ' -f1); ARGS=$(echo "$VALUE" | cut -s -d' ' -f2-)
      JSON_ARGS=""; for a in $ARGS; do JSON_ARGS="$JSON_ARGS\${JSON_ARGS:+,}\\"$a\\""; done
      echo "{\\"name\\":\\"ainecto\\",\\"transport\\":{\\"type\\":\\"stdio\\",\\"command\\":\\"$CMD\\",\\"args\\":[$JSON_ARGS]}}"; exit 0
    fi
    echo "Error: No MCP server named 'ainecto' found." >&2; exit 1;;
  "mcp add")
    case "$*" in *"--url "*) while [ "$1" != "--url" ]; do shift; done; echo "url|$2" > "$STATE"; echo "Added global MCP server 'ainecto'."
      echo "Detected OAuth support. Starting OAuth flow…"; echo "Authorize \\\`ainecto\\\` by opening this URL in your browser:"; echo "https://auth.example/authorize?fake=1"
      [ -f "$FAKE_AGENT_HOME/codex.fail" ] && { echo "codex timed out after 90s" >&2; exit 1; }
      echo "Successfully logged in."; exit 0;; esac
    while [ "$1" != "--" ]; do shift; done; shift
    echo "cmd|$*" > "$STATE"; echo "Added global MCP server 'ainecto'."; exit 0;;
  "mcp remove")
    rm -f "$STATE"; echo "Removed global MCP server 'ainecto'."; exit 0;;
esac
exit 2
`;

export interface FakeAgents {
  bin: string;
  env: NodeJS.ProcessEnv;
  /** 상태를 미리 둔다 — `cmd|npx -y @ainecto/mcp --role design` 또는 `url|https://…`. */
  seed(name: "claude" | "codex", state: string): Promise<void>;
  state(name: "claude" | "codex"): Promise<string | undefined>;
  log(name: "claude" | "codex"): Promise<string[]>;
  failAdds(name: "claude" | "codex"): Promise<void>;
}

export async function installFakeAgents(home: string, which: Array<"claude" | "codex"> = ["claude", "codex"]): Promise<FakeAgents> {
  const bin = join(home, "fake-bin");
  await mkdir(bin, { recursive: true });
  for (const [name, body] of [["claude", CLAUDE], ["codex", CODEX]] as const) {
    if (which.includes(name)) {
      await writeFile(join(bin, name), body, "utf8");
      await chmod(join(bin, name), 0o755);
    }
  }
  // ★PATH 는 가짜 bin + 시스템 기본만 — 이 기계의 진짜 claude·codex 가 잡히지 않게.
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: home, FAKE_AGENT_HOME: home };
  const read = async (path: string) => readFile(path, "utf8").catch(() => undefined);
  return {
    bin,
    env,
    seed: (name, state) => writeFile(join(home, `${name}.state`), `${state}\n`, "utf8"),
    state: async (name) => (await read(join(home, `${name}.state`)))?.trim(),
    log: async (name) => ((await read(join(home, `${name}.log`))) ?? "").split("\n").filter(Boolean),
    failAdds: (name) => writeFile(join(home, `${name}.fail`), "", "utf8"),
  };
}
