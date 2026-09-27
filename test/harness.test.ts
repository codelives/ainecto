import { describe, expect, it } from "vitest";
import { assertRole, resolveRole, ROLE_ENV_VAR } from "../src/core/harness/role";
import {
  buildServerEntry,
  codexAddCommand,
  codexProfileSetup,
  mergeServerEntry,
  readRoleFromEntry,
  removeServerEntry,
  SERVER_NAME,
} from "../src/core/harness/agentTargets";
import {
  documentContractProblem,
  MARKER_BEGIN,
  MARKER_END,
  removeMarkerBlock,
  renderAgentNote,
  renderHarnessDoc,
  upsertMarkerBlock,
} from "../src/core/harness/harnessDoc";
import { detectRoles, planInit, planUndo, readRecordBody } from "../src/core/harness/initPlan";
import { extractProjects, unwrapToolJson } from "../src/adapters/cli/initCommand";

const BASE = {
  role: "development",
  env: "prod",
  projectName: "Billing",
  projectUuid: "p-1",
  endpoint: "https://ai-erd.com/mcp",
  cliVersion: "@ai-erd/mcp test",
} as const;

function snapshot(entries: Record<string, string | undefined>) {
  return new Map<string, string | undefined>(Object.entries(entries));
}

function writtenAt(plan: ReturnType<typeof planInit>, path: string): string | undefined {
  return plan.writes.find((write) => write.path === path)?.content;
}

describe("role resolution", () => {
  it("takes the flag first, then the environment", () => {
    expect(resolveRole({ role: "design" })).toEqual({ role: "design", source: "flag" });
    expect(resolveRole({ envVars: { [ROLE_ENV_VAR]: "test" } })).toEqual({ role: "test", source: "env" });
    expect(resolveRole({ envVars: {} })).toEqual({ source: "none" });
  });

  it("stops on a typo instead of silently running unscoped", () => {
    // 조용히 «역할 없음»으로 도는 것이 이 도구에서 가장 나쁜 실패다.
    expect(() => assertRole("developement")).toThrow(/Invalid role/);
  });
});

describe("mcp config merge", () => {
  it("writes exactly one server entry — that is what makes one session one role", () => {
    const entry = buildServerEntry({ role: "development" });
    const merged = mergeServerEntry(undefined, entry);
    const parsed = JSON.parse(merged.content);

    expect(Object.keys(parsed.mcpServers)).toEqual([SERVER_NAME]);
    expect(parsed.mcpServers[SERVER_NAME].args).toEqual(["-y", "@ai-erd/mcp", "--role", "development"]);
    expect(readRoleFromEntry(parsed.mcpServers[SERVER_NAME])).toBe("development");
  });

  it("adds --env only when it is not the default", () => {
    expect(buildServerEntry({ role: "design", env: "prod" }).args).not.toContain("--env");
    expect(buildServerEntry({ role: "design", env: "dev" }).args).toEqual(
      ["-y", "@ai-erd/mcp", "--role", "design", "--env", "dev"],
    );
  });

  it("keeps other people's servers and other top-level keys", () => {
    const existing = JSON.stringify({
      mcpServers: { sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" } },
      somethingElse: { keep: true },
    });

    const merged = mergeServerEntry(existing, buildServerEntry({ role: "test" }));
    const parsed = JSON.parse(merged.content);

    expect(parsed.mcpServers.sentry).toEqual({ type: "http", url: "https://mcp.sentry.dev/mcp" });
    expect(parsed.somethingElse).toEqual({ keep: true });
  });

  it("★mcpServers 모양이 틀려도 원문을 조용히 버리지 않는다", () => {
    // 배열이 들어 있는 설정을 {} 로 갈아 끼우면 사용자의 내용이 사라진다(독립 리뷰 I8).
    const weird = JSON.stringify({ mcpServers: [{ command: "user-command" }] });
    expect(() => mergeServerEntry(weird, buildServerEntry({ role: "test" })))
      .toThrow(/not an object/);
  });

  it("★기본이 아닌 endpoint 만 인자로 싣는다", () => {
    expect(buildServerEntry({ role: "design", endpoint: "https://ai-erd.com/mcp" }).args)
      .not.toContain("--endpoint");
    expect(buildServerEntry({ role: "design", endpoint: "https://custom.example/mcp" }).args)
      .toEqual(["-y", "@ai-erd/mcp", "--role", "design", "--endpoint", "https://custom.example/mcp"]);
  });

  it("refuses to overwrite a config it cannot parse", () => {
    // 읽을 수 없는 파일을 덮으면 사용자의 설정이 사라진다.
    expect(() => mergeServerEntry("{ not json", buildServerEntry({ role: "test" })))
      .toThrow(/not valid JSON/);
  });

  it("removes only its own entry", () => {
    const existing = JSON.stringify({
      mcpServers: {
        sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" },
        [SERVER_NAME]: buildServerEntry({ role: "design" }),
      },
    });

    const result = removeServerEntry(existing);
    const parsed = JSON.parse(result.content!);

    expect(result.removed).toBe(true);
    expect(result.emptied).toBe(false);
    expect(Object.keys(parsed.mcpServers)).toEqual(["sentry"]);
  });

  it("reports an emptied file so the caller can delete what it created", () => {
    const existing = JSON.stringify({ mcpServers: { [SERVER_NAME]: buildServerEntry({ role: "design" }) } });
    expect(removeServerEntry(existing).emptied).toBe(true);
  });
});

describe("marker block", () => {
  it("appends without touching what was already there", () => {
    const result = upsertMarkerBlock("# My rules\n\nDo the thing.\n", renderAgentNote());

    expect(result).toContain("# My rules");
    expect(result).toContain("Do the thing.");
    expect(result).toContain("AI-ERD Harness");
  });

  it("replaces its own block instead of stacking copies", () => {
    const once = upsertMarkerBlock("# My rules\n", renderAgentNote());
    const twice = upsertMarkerBlock(once, renderAgentNote());

    expect(twice).toBe(once);
    expect(twice.match(/ai-erd:begin/g)).toHaveLength(1);
  });

  it("removes its block and leaves the rest", () => {
    const withBlock = upsertMarkerBlock("# My rules\n\nDo the thing.\n", renderAgentNote());
    const result = removeMarkerBlock(withBlock);

    expect(result.removed).toBe(true);
    expect(result.content).toContain("Do the thing.");
    expect(result.content).not.toContain("ai-erd:begin");
  });

  it("refuses to touch a file whose markers do not pair up", () => {
    // 여는 표식만 남았다 = 사람이 손으로 잘랐거나 예제로 적어 뒀다.
    // ★예전엔 «못 본 척»하고 뒤에 새 블록을 붙였는데, 그러면 begin 둘 · end 하나가 되어
    //   다음 실행에서 둘이 이어지며 사이의 사용자 글이 사라졌다(독립 리뷰 I3).
    const damaged = "<!-- ai-erd:begin -->\nUSER TEXT MUST SURVIVE\n";

    expect(() => upsertMarkerBlock(damaged, renderAgentNote())).toThrow(/unbalanced/);
    expect(() => removeMarkerBlock(damaged)).toThrow(/unbalanced/);
  });

  it("does not reflow paragraphs it never wrote", () => {
    // 파일 «전체»에 빈 줄 정규화를 돌리던 것이 I2 였다.
    const original = "# Rules\n\n\n\nA paragraph kept far apart.\n";
    const withBlock = upsertMarkerBlock(original, renderAgentNote());

    expect(removeMarkerBlock(withBlock).content).toBe(original);
  });

  it("★예제로 적어 둔 표식은 «우리 것이 아니다» — 건드리지 않는다", () => {
    // 2026-09-22 I3 → 2026-09-23 3차 I9 → 4차 I6. 「예제인지 알아내서 피한다」는 계속 샜다:
    // tilde, 들여쓴 펜스, 더 긴 펜스 안의 짧은 줄, 인용문, 네 칸 들여쓴 코드…
    // ⇒ 판정을 뒤집었다. «우리가 쓰는 정확한 형태»만 우리 것으로 본다.
    const examples: Array<[string, string]> = [
      ["tilde", `~~~markdown\n${MARKER_BEGIN}\nEXAMPLE\n${MARKER_END}\n~~~`],
      ["indented fence", `  \`\`\`\n${MARKER_BEGIN}\nEXAMPLE\n${MARKER_END}\n  \`\`\``],
      ["longer fence", `\`\`\`\`\n\`\`\`\n${MARKER_BEGIN}\nEXAMPLE\n${MARKER_END}\n\`\`\`\n\`\`\`\``],
      ["blockquote", `> \`\`\`\n> ${MARKER_BEGIN}\n> EXAMPLE\n> ${MARKER_END}\n> \`\`\``],
      ["indented code", `    ${MARKER_BEGIN}\n    EXAMPLE\n    ${MARKER_END}`],
    ];

    for (const [label, example] of examples) {
      const file = `# Rules\n\n${example}\n`;
      const after = upsertMarkerBlock(file, renderAgentNote());

      // 예제 본문은 그대로다 — 이것이 예전에 갈아 끼워지던 것이다.
      expect(after, label).toContain("EXAMPLE");
      // 우리 블록은 «따로» 붙는다.
      expect(after, label).toContain("AI-ERD Harness");
      // 그리고 그 뒤의 되돌리기는 우리 것만 걷어낸다.
      expect(removeMarkerBlock(after).content, label).toContain("EXAMPLE");
      expect(removeMarkerBlock(after).content, label).not.toContain("AI-ERD Harness");
    }
  });

  it("잘린 우리 블록은 여전히 거절한다", () => {
    // 우리가 쓰는 형태로 여는 표식만 남은 것 = 사람이 손으로 잘랐다. 범위를 추측하지 않는다.
    const damaged = `${MARKER_BEGIN}\nUSER TEXT MUST SURVIVE\n`;

    expect(() => upsertMarkerBlock(damaged, renderAgentNote())).toThrow(/unbalanced/);
    expect(() => removeMarkerBlock(damaged)).toThrow(/unbalanced/);
  });

  it("펜스 밖의 진짜 블록은 그대로 다룬다", () => {
    // 위 판정이 «전부 거절»로 흐르지 않는지 — 안전한 쪽으로 기울되 못 쓰게 만들지 않는다.
    const file = `# Rules\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\n${MARKER_BEGIN}\nours\n${MARKER_END}\n`;

    expect(upsertMarkerBlock(file, renderAgentNote())).toContain("AI-ERD Harness");
    expect(removeMarkerBlock(file).removed).toBe(true);
  });

  it("★채워 넣은 값 안의 자리표시자 모양은 다시 치환하지 않는다", () => {
    // 4차 독립 리뷰 S4 — 넣은 값은 «내용»이지 템플릿이 아니다.
    const rendered = renderHarnessDoc({
      projectName: "The {{endpoint}} project",
      projectUuid: "p-1",
      endpoint: "https://ai-erd.com/mcp",
    });

    expect(rendered).toContain("The {{endpoint}} project");
  });

  it("★쓰고 나서 «다시 찾을 수 있는» 모양만 수락한다", () => {
    // 5차 독립 리뷰 I4 — 한 줄 블록·앞 공백·안 닫힌 펜스를 수락했더니, 소유 판정이 방금 쓴
    // 블록을 못 찾아 재실행마다 블록이 하나씩 늘었다.
    const key = "HARNESS.AGENT_NOTE"
    const good = `${MARKER_BEGIN}\nrules\n${MARKER_END}`

    expect(documentContractProblem(key, good.replace("rules", "{{harnessDocPath}} {{serverName}}")))
      .toBeUndefined()
    // 한 줄짜리
    expect(documentContractProblem(key, `${MARKER_BEGIN}{{harnessDocPath}} {{serverName}}${MARKER_END}`))
      .toContain("alone on its own line")
    // 안 닫힌 펜스
    expect(documentContractProblem(key,
      `${MARKER_BEGIN}\n\`\`\`\n{{harnessDocPath}} {{serverName}}\n${MARKER_END}`))
      .toContain("unclosed code fence")
  })

  it("★같은 블록을 세 번 얹어도 파일이 자라지 않는다", () => {
    // 5차 독립 리뷰 S2 — 끝 개행의 소유가 정해져 있지 않아 매번 1바이트씩 늘었다.
    const note = `${renderAgentNote()}\n`   // 서버 리소스처럼 끝 개행이 붙어 온 경우
    const once = upsertMarkerBlock("# Rules\n\nMine.\n", note)
    const twice = upsertMarkerBlock(once, note)
    const thrice = upsertMarkerBlock(twice, note)

    expect(twice).toBe(once)
    expect(thrice).toBe(once)
    // 그리고 그 블록은 다시 찾을 수 있다.
    expect(removeMarkerBlock(thrice).removed).toBe(true)
  })

  it("never writes the role into prose — the config is the only source of truth", () => {
    const note = renderAgentNote();
    const doc = renderHarnessDoc({ projectName: "Billing", projectUuid: "p-1", endpoint: "https://ai-erd.com/mcp" });

    for (const role of ["design", "development", "test", "validation"]) {
      expect(note.toLowerCase()).not.toContain(`role: ${role}`);
      expect(doc.toLowerCase()).not.toContain(`current role: ${role}`);
    }
  });
});

describe("init plan", () => {
  it("wires both agent configs and binds the project", () => {
    const plan = planInit({ ...BASE, files: snapshot({}) });
    const paths = plan.writes.map((write) => write.path);

    expect(paths).toContain(".mcp.json");
    expect(paths).toContain(".cursor/mcp.json");
    expect(paths).toContain(".ai-erd/HARNESS.md");
    expect(paths).toContain(".ai-erd/config.json");
    expect(JSON.parse(writtenAt(plan, ".ai-erd/config.json")!).project)
      .toEqual({ uuid: "p-1", name: "Billing" });
  });

  it("creates AGENTS.md but does not invent a CLAUDE.md", () => {
    const plan = planInit({ ...BASE, files: snapshot({}) });
    const paths = plan.writes.map((write) => write.path);

    expect(paths).toContain("AGENTS.md");
    expect(paths).not.toContain("CLAUDE.md");
    expect(plan.notes.join(" ")).toContain("CLAUDE.md not found");
  });

  it("updates CLAUDE.md when the repository already has one", () => {
    const plan = planInit({ ...BASE, files: snapshot({ "CLAUDE.md": "# House rules\n" }) });
    expect(writtenAt(plan, "CLAUDE.md")).toContain("# House rules");
    expect(writtenAt(plan, "CLAUDE.md")).toContain("AI-ERD Harness");
  });

  it("gives Codex a per-session route through profiles, still one server entry", () => {
    // 실측(2026-09-22, codex 0.153.4): codex -p <name> 이 $CODEX_HOME/<name>.config.toml 을 얹고
    // 같은 서버 이름이면 «덮어쓴다». 합쳐지지 않으므로 세션이 보는 항목은 여전히 하나다.
    const lines = codexProfileSetup({ role: "design" }).join("\n");

    expect(lines).toContain("$CODEX_HOME/design.config.toml");
    expect(lines).toContain("[mcp_servers.ai-erd]");
    expect(lines).toContain('"--role","design"'.replace(/"/g, '"'));
    expect(lines).toContain("codex -p design");
    expect(lines).toContain("replaces the global one");
  });

  it("does not modify the codex global config, it hands over the command", () => {
    const plan = planInit({ ...BASE, files: snapshot({}) });

    expect(plan.writes.map((write) => write.path).join(" ")).not.toContain("codex");
    expect(plan.codexCommand).toBe(codexAddCommand({ role: "development", env: "prod" }));
    expect(plan.codexCommand).toContain("--role development");
  });

  it("re-running with a new role rewrites the one entry and says what changed", () => {
    const first = planInit({ ...BASE, files: snapshot({}) });
    const after = snapshot({ ".mcp.json": writtenAt(first, ".mcp.json") });

    const second = planInit({ ...BASE, role: "design", files: after });

    expect(readRoleFromEntry(JSON.parse(writtenAt(second, ".mcp.json")!).mcpServers[SERVER_NAME]))
      .toBe("design");
    expect(second.notes.join(" ")).toContain("role development → design");
  });

  it("writes nothing twice when nothing changed", () => {
    const first = planInit({ ...BASE, files: snapshot({}) });
    const settled = snapshot(Object.fromEntries(first.writes.map((write) => [write.path, write.content])));

    const second = planInit({ ...BASE, files: settled });

    // ★기록은 자기 파일에 있다. config 는 내용이 같으면 «안» 쓴다 — 남의 파일이므로.
    expect(second.writes.map((write) => write.path))
      .toEqual([".ai-erd/HARNESS.md", ".ai-erd/init-record.json"]);
  });

  it("detects a role already wired into the repository", () => {
    const first = planInit({ ...BASE, files: snapshot({}) });
    const roles = detectRoles(snapshot({ ".mcp.json": writtenAt(first, ".mcp.json") }));

    expect([...roles.values()]).toEqual(["development"]);
  });
});

describe("undo", () => {
  it("gives the repository back exactly as it was", () => {
    const before = {
      ".mcp.json": `${JSON.stringify({ mcpServers: { sentry: { type: "http", url: "https://x" } } }, null, 2)}\n`,
      "AGENTS.md": "# House rules\n\nBe careful.\n",
    };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const after = snapshot({
      ...Object.fromEntries(init.writes.map((write) => [write.path, write.content])),
    });

    const undo = planUndo({ files: after, managed: init.managed });
    const undone = Object.fromEntries(undo.writes.map((write) => [write.path, write.content]));

    expect(undone[".mcp.json"]).toBe(before[".mcp.json"]);
    expect(undone["AGENTS.md"]).toBe(before["AGENTS.md"]);
    expect(undo.deletes).toContain(".ai-erd/HARNESS.md");
    expect(undo.deletes).toContain(".ai-erd/config.json");
  });

  it("deletes files it created outright, and keeps ones it only edited", () => {
    const init = planInit({ ...BASE, files: snapshot({}) });
    const after = snapshot(Object.fromEntries(init.writes.map((write) => [write.path, write.content])));

    const undo = planUndo({ files: after, managed: init.managed });

    expect(undo.deletes).toContain(".mcp.json");
    expect(undo.deletes).toContain(".cursor/mcp.json");
    expect(undo.deletes).toContain("AGENTS.md");
  });

  it("keeps files that existed before init, even when the name is ours", () => {
    // ★이름이 같다는 이유로 남의 파일을 지우던 것이 I2 였다.
    const before = { ".ai-erd/HARNESS.md": "mine\n", ".ai-erd/config.json": "{}\n" };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const after = snapshot(Object.fromEntries(init.writes.map((w) => [w.path, w.content])));

    const undo = planUndo({ files: after, managed: init.managed });

    expect(undo.deletes).not.toContain(".ai-erd/HARNESS.md");
    expect(undo.notes.join(" ")).toContain("existed before init");
  });

  it("puts back a user's own ai-erd entry instead of deleting it", () => {
    const mine = { command: "old", args: ["x"], env: { MY_SETTING: "preserve" } };
    const before = { ".mcp.json": `${JSON.stringify({ mcpServers: { "ai-erd": mine } }, null, 2)}\n` };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const after = snapshot(Object.fromEntries(init.writes.map((w) => [w.path, w.content])));

    const undo = planUndo({ files: after, managed: init.managed });
    const restored = JSON.parse(undo.writes.find((w) => w.path === ".mcp.json")!.content);

    expect(restored.mcpServers["ai-erd"]).toEqual(mine);
    expect(undo.deletes).not.toContain(".mcp.json");
  });

  it("★기록이 없으면 아무것도 지우지 않는다", () => {
    // init 을 한 적 없는 저장소의 사용자 항목까지 지우던 것이 I2 의 첫 행이다.
    const mine = { command: "mine", args: ["x"] };
    const files = snapshot({ ".mcp.json": `${JSON.stringify({ mcpServers: { "ai-erd": mine } }, null, 2)}\n` });

    const undo = planUndo({ files });

    expect(undo.writes).toHaveLength(0);
    expect(undo.deletes).toHaveLength(0);
    expect(undo.notes.join(" ")).toContain("No record of a previous init");
  });

  it("★사용자 항목이 우연히 역할 인자를 갖고 있어도 남의 것이다", () => {
    // 예전엔 「args 에 역할이 있으면 우리 것」으로 보고 백업하지 않았다.
    const mine = { command: "mine", args: ["--role", "design"], env: { MY_SETTING: "preserve" } };
    const before = { ".mcp.json": `${JSON.stringify({ mcpServers: { "ai-erd": mine } }, null, 2)}\n` };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const after = snapshot(Object.fromEntries(init.writes.map((w) => [w.path, w.content])));

    const undo = planUndo({ files: after, managed: init.managed });
    const restored = JSON.parse(undo.writes.find((w) => w.path === ".mcp.json")!.content);

    expect(restored.mcpServers["ai-erd"]).toEqual(mine);
  });

  it("★이미 있던 HARNESS.md 는 원본으로 되돌린다", () => {
    const before = { ".ai-erd/HARNESS.md": "MY OWN NOTES\n" };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const after = snapshot(Object.fromEntries(init.writes.map((w) => [w.path, w.content])));

    const undo = planUndo({ files: after, managed: init.managed });

    expect(undo.writes.find((w) => w.path === ".ai-erd/HARNESS.md")?.content).toBe("MY OWN NOTES\n");
    expect(undo.deletes).not.toContain(".ai-erd/HARNESS.md");
  });

  it("★이미 있던 규칙 블록도 원본으로 되돌린다", () => {
    const mineBlock = "<!-- ai-erd:begin -->\nMY OWN RULES\n<!-- ai-erd:end -->";
    const before = { "AGENTS.md": `# Rules\n\n${mineBlock}\n` };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const after = snapshot(Object.fromEntries(init.writes.map((w) => [w.path, w.content])));

    const undo = planUndo({ files: after, managed: init.managed });

    expect(undo.writes.find((w) => w.path === "AGENTS.md")?.content).toContain("MY OWN RULES");
  });

  it("★우리가 만든 파일도 사용자가 고쳤으면 지우지 않는다", () => {
    const init = planInit({ ...BASE, files: snapshot({}) });
    const written = Object.fromEntries(init.writes.map((w) => [w.path, w.content]));
    written[".ai-erd/HARNESS.md"] = `${written[".ai-erd/HARNESS.md"]}\n\n내가 덧붙인 줄\n`;

    const undo = planUndo({ files: snapshot(written), managed: init.managed });

    expect(undo.deletes).not.toContain(".ai-erd/HARNESS.md");
    expect(undo.notes.join(" ")).toContain("edited after init");
  });

  it("tells the user about the parts it cannot reach", () => {
    const undo = planUndo({ files: snapshot({}) });
    expect(undo.notes.join(" ")).toContain("codex mcp remove");
    expect(undo.notes.join(" ")).toContain(ROLE_ENV_VAR);
  });
});

describe("tool response reading", () => {
  it("unwraps the MCP text content envelope", () => {
    const result = { content: [{ type: "text", text: JSON.stringify({ projects: [{ uuid: "p-1", name: "A" }] }) }] };
    expect(extractProjects(unwrapToolJson(result))).toEqual([{ uuid: "p-1", name: "A" }]);
  });

  it("finds projects however the server wraps them", () => {
    expect(extractProjects([{ uuid: "p-1", name: "A" }])).toEqual([{ uuid: "p-1", name: "A" }]);
    expect(extractProjects({ items: [{ uuid: "p-2", name: "B" }] })).toEqual([{ uuid: "p-2", name: "B" }]);
    expect(extractProjects({ created: [{ uuid: "p-3" }] })).toEqual([{ uuid: "p-3", name: "p-3" }]);
    expect(extractProjects({ nothing: true })).toEqual([]);
  });
});

/**
 * 2026-09-27 6차 독립 리뷰 — 파일 복구 계약.
 *
 * ★네 건(I1·I2·I3)이 «5차를 고치며 내가 만든» 회귀였다. 복구를 「전부 또는 전무」에서
 * 항목별로 바꾼 대가다. 그래서 여기 시험은 결과 한 컷이 아니라 <b>반복 실행의 수렴</b>을 본다 —
 * 한 번 돌려서 맞는 것과, 네 번 돌려도 같은 곳에 서 있는 것은 다른 사실이다.
 */
describe("6차 독립 리뷰 — 복구 계약", () => {
  const CONFIG = ".ai-erd/config.json";
  const RECORD = ".ai-erd/init-record.json";

  /** 계획을 스냅샷에 «적용»한 결과. 반복 undo 를 보려면 이게 필요하다. */
  function applyTo(files: Map<string, string | undefined>, plan: { writes: { path: string; content: string }[]; deletes: string[] }) {
    const next = new Map(files);
    for (const write of plan.writes) next.set(write.path, write.content);
    for (const path of plan.deletes) next.set(path, undefined);
    return next;
  }

  /**
   * 다음 undo·init 의 입력이 되는 기록. ★«기록 파일»에서 읽는다 — 실제 흐름과 같은 경로다.
   *
   * <p>7차 독립 리뷰 뒤에 기록을 config 에서 자기 파일로 내보냈다. 한 파일에 주인이 둘이라
   * 「이 칸이 누구 것인가」를 매번 판정해야 했고, 그 판정이 네 차수 연속 샜다.
   */
  function managedOf(files: Map<string, string | undefined>) {
    return readRecordBody(files.get(RECORD));
  }

  const json = (body: unknown) => `${JSON.stringify(body, null, 2)}\n`;

  it("★I1 사용자가 config 에 적은 칸을 되돌리기가 덮지 않는다", () => {
    // 원본 config 가 있으면 «무조건» 그것으로 덮던 자리다. 그 사이의 편집이 사라졌다.
    const before = { [CONFIG]: json({ mine: "before-init" }) };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const files = applyTo(snapshot(before), init);
    const ours = JSON.parse(files.get(CONFIG)!) as Record<string, unknown>;
    ours.mine = "edited-after-init";
    files.set(CONFIG, json(ours));

    const undone = applyTo(files, planUndo({ files, managed: managedOf(files) }));

    expect(JSON.parse(undone.get(CONFIG)!).mine).toBe("edited-after-init");
  });

  it("★I1 기록을 줄여 쓴다는 이유로 사용자 칸을 우리 것으로 삼지 않는다", () => {
    const init = planInit({ ...BASE, files: snapshot({}) });
    let files = applyTo(snapshot({}), init);
    // 사용자가 config 에 자기 칸을 더하고, 우리 MCP 항목도 손댔다(= 해소 안 된 충돌).
    files.set(CONFIG, json({ ...JSON.parse(files.get(CONFIG)!), mine: "keep-me" }));
    const mcp = JSON.parse(files.get(".mcp.json")!);
    mcp.mcpServers["ai-erd"].args = [...mcp.mcpServers["ai-erd"].args, "--mine"];
    files.set(".mcp.json", json(mcp));

    // 1차 — 충돌이 남았으니 기록을 «줄여서» 남긴다. 사용자 칸은 그대로.
    files = applyTo(files, planUndo({ files, managed: managedOf(files) }));
    expect(JSON.parse(files.get(CONFIG)!).mine).toBe("keep-me");

    // 사람이 안내대로 우리 항목을 손으로 지워 충돌을 해소했다.
    files.set(".mcp.json", json({ mcpServers: {} }));

    // 2차 — 끝났다. 우리 칸만 걷히고 사용자 칸은 남는다(파일이 사라지지 않는다).
    files = applyTo(files, planUndo({ files, managed: managedOf(files) }));
    expect(files.get(CONFIG)).toBeDefined();
    expect(JSON.parse(files.get(CONFIG)!).mine).toBe("keep-me");
    expect(JSON.parse(files.get(CONFIG)!).managed).toBeUndefined();
  });

  it("★I2 손으로 원본 파일을 되돌려 놨으면 끝난 것으로 본다", () => {
    const before = { ".ai-erd/HARNESS.md": "my own harness notes\n" };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const files = applyTo(snapshot(before), init);
    files.set(".ai-erd/HARNESS.md", before[".ai-erd/HARNESS.md"]);

    const undo = planUndo({ files, managed: managedOf(files) });

    expect(undo.notes.join(" ")).toContain("already the file that existed before init");
    // 그리고 기록이 남지 않는다 — 다시 돌려도 할 일이 없다(수렴).
    expect(managedOf(applyTo(files, undo))).toBeUndefined();
  });

  it("★I2 우리가 «더한» 항목을 손으로 지웠으면 그것도 끝난 것이다", () => {
    // 되돌릴 목표가 「없음」인 항목. 예전엔 백업이 없으면 곧바로 충돌로 봐서 안 끝났다.
    const before = { ".mcp.json": json({ mcpServers: { sentry: { type: "http", url: "https://x" } } }) };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const files = applyTo(snapshot(before), init);
    files.set(".mcp.json", before[".mcp.json"]);

    const undo = planUndo({ files, managed: managedOf(files) });

    expect(undo.notes.join(" ")).toContain("already gone");
    expect(managedOf(applyTo(files, undo))).toBeUndefined();
  });

  it("★I2 우리가 «더한» 블록을 손으로 지웠으면 그것도 끝난 것이다", () => {
    const before = { "AGENTS.md": "# House rules\n\nBe careful.\n" };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const files = applyTo(snapshot(before), init);
    files.set("AGENTS.md", before["AGENTS.md"]);

    const undo = planUndo({ files, managed: managedOf(files) });

    expect(undo.notes.join(" ")).toContain("already");
    expect(managedOf(applyTo(files, undo))).toBeUndefined();
  });

  it("★I2 되돌린 상태에서 네 번 더 돌려도 같은 곳에 선다", () => {
    const before = { ".ai-erd/HARNESS.md": "mine\n" };
    let files = applyTo(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));
    files.set(".ai-erd/HARNESS.md", before[".ai-erd/HARNESS.md"]);

    const seen: string[] = [];
    for (let round = 0; round < 4; round += 1) {
      files = applyTo(files, planUndo({ files, managed: managedOf(files) }));
      seen.push(JSON.stringify([...files].filter(([, body]) => body !== undefined).sort()));
    }

    // ⚠「상태가 안 변한다」만으로는 모자란다 — «안정적이지만 영영 미해결»도 안 변한다.
    //   수렴의 증거는 <b>할 일이 없어진 것</b>이다: 기록이 사라지고 원본만 남았다.
    expect(new Set(seen.slice(1)).size).toBe(1);
    expect(files.get(".ai-erd/HARNESS.md")).toBe(before[".ai-erd/HARNESS.md"]);
    expect(managedOf(files)).toBeUndefined();
    expect(files.get(CONFIG)).toBeUndefined();
  });

  it("★I3 기록보다 «지금 파일»이 최신이면 그것을 새 원본으로 삼는다", () => {
    const a = { command: "A", args: ["--a"] };
    const b = { command: "B", args: ["--b"] };
    const before = { ".mcp.json": json({ mcpServers: { "ai-erd": a } }) };
    let files = applyTo(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));
    // 사용자가 우리 항목을 자기 것 B 로 갈아 끼웠다(= 완료된 기록이 낡았다).
    files.set(".mcp.json", json({ mcpServers: { "ai-erd": b } }));

    files = applyTo(files, planInit({ ...BASE, files, previous: managedOf(files) }));
    const undo = planUndo({ files, managed: managedOf(files) });

    const restored = JSON.parse(undo.writes.find((w) => w.path === ".mcp.json")!.content);
    expect(restored.mcpServers["ai-erd"]).toEqual(b);
  });

  it("★I4 열린 코드펜스로 끝나는 파일에는 블록을 넣지 않는다", () => {
    // 블록 «안»만 검사했더니, 합친 결과에서 멀쩡한 블록이 펜스 안으로 들어가 우리 것으로
    // 안 보였다. 그래서 init 마다 하나씩 늘고 undo 는 아무것도 못 걷어냈다.
    const before = { "AGENTS.md": "# Rules\n\n```sh\nnot closed\n" };
    const first = planInit({ ...BASE, files: snapshot(before) });

    expect(first.writes.find((w) => w.path === "AGENTS.md")).toBeUndefined();
    expect(first.notes.join(" ")).toContain("unclosed code fence");

    let files = applyTo(snapshot(before), first);
    files = applyTo(files, planInit({ ...BASE, files, previous: managedOf(files) }));
    expect(files.get("AGENTS.md")).toBe(before["AGENTS.md"]);
  });

  it("★I4 우리 것으로 알아볼 수 없는 블록이 파일에 있으면 기록을 지키고 알린다", () => {
    const before = { "AGENTS.md": "# Rules\n\nBe careful.\n" };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const files = applyTo(snapshot(before), init);
    // 사람이 블록을 코드펜스 안으로 옮겼다 — 있지만 «우리 것으로» 안 보인다.
    files.set("AGENTS.md", `# Rules\n\n\`\`\`md\n${MARKER_BEGIN}\nx\n${MARKER_END}\n\`\`\`\n`);

    const undo = planUndo({ files, managed: managedOf(files) });

    expect(undo.notes.join(" ")).toContain("not where --undo can remove it");
    // 「없으니 끝났다」로 기록을 지우지 않는다 — 블록은 파일에 남아 있다.
    expect(managedOf(applyTo(files, undo))).toBeDefined();
  });
});

/**
 * 2026-09-27 7차 독립 리뷰 — 복구 계약을 «구조»로 바꾼 뒤.
 *
 * ★7차의 중요 6건 중 4건이 또 「직전을 고치며 내가 만든」 회귀였고, 그중 I1 은 «정상 경로»를
 * 퇴행시켰다 — 편집도 안 한 init→undo 가 사용자 config 를 지웠다. 원인은 유실이 undo 가 아니라
 * <b>init</b> 에서 일어나는데 내가 undo 쪽만 고친 것이었다(결함을 「보고된 자리」에서 고쳤다).
 *
 * ⇒ 그래서 이번엔 덧붙이지 않고 구조를 바꿨다: 기록을 우리 파일로 내보내고, 남의 파일은
 *   병합해서 쓴다. 여기 시험은 그 «불변식»을 고정한다 — 우리 파일은 통째로, 남의 파일은 조각만.
 */
describe("7차 독립 리뷰 — 우리 파일과 남의 파일", () => {
  const CONFIG = ".ai-erd/config.json";
  const RECORD = ".ai-erd/init-record.json";
  const json = (body: unknown) => `${JSON.stringify(body, null, 2)}\n`;

  function applyTo(files: Map<string, string | undefined>, plan: { writes: { path: string; content: string }[]; deletes: string[] }) {
    const next = new Map(files);
    for (const write of plan.writes) next.set(write.path, write.content);
    for (const path of plan.deletes) next.set(path, undefined);
    return next;
  }
  const recordOf = (files: Map<string, string | undefined>) => readRecordBody(files.get(RECORD));

  it("★I1 편집하지 않은 init→undo 가 원래 config 를 지우지 않는다", () => {
    // ★7차가 잡은 정상 경로 퇴행. 같은 입력에서 6차는 원본을 복원했고 내 수정이 삭제했다.
    const before = { [CONFIG]: json({ userSetting: "KEEP ORIGINAL" }) };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const written = applyTo(snapshot(before), init);

    // ★유실은 undo 가 아니라 init 에서 일어났다 — 그 자리부터 본다.
    expect(JSON.parse(written.get(CONFIG)!).userSetting).toBe("KEEP ORIGINAL");

    const undone = applyTo(written, planUndo({ files: written, managed: recordOf(written) }));
    expect(undone.get(CONFIG)).toBeDefined();
    expect(JSON.parse(undone.get(CONFIG)!).userSetting).toBe("KEEP ORIGINAL");
  });

  it("★I1 init 뒤에 더한 사용자 칸이 재init 에서도 살아남는다", () => {
    const first = planInit({ ...BASE, files: snapshot({}) });
    let files = applyTo(snapshot({}), first);
    files.set(CONFIG, json({ ...JSON.parse(files.get(CONFIG)!), mine: "keep" }));

    files = applyTo(files, planInit({ ...BASE, files, previous: recordOf(files) }));

    expect(JSON.parse(files.get(CONFIG)!).mine).toBe("keep");
  });

  it("★I1 JSON 객체가 아닌 config 는 손대지 않는다", () => {
    for (const body of ["[1,2,3]\n", "not json at all\n"]) {
      const plan = planInit({ ...BASE, files: snapshot({ [CONFIG]: body }) });
      expect(plan.writes.find((w) => w.path === CONFIG)).toBeUndefined();
      expect(plan.notes.join(" ")).toContain("not a JSON object");
    }
  });

  it("★I2 이름이 우리 칸이어도 «값»을 사용자가 고쳤으면 덮지 않는다", () => {
    const init = planInit({ ...BASE, files: snapshot({}) });
    const files = applyTo(snapshot({}), init);
    const edited = JSON.parse(files.get(CONFIG)!) as Record<string, unknown>;
    edited.endpoint = "https://mine.example/mcp";
    files.set(CONFIG, json(edited));

    const undo = planUndo({ files, managed: recordOf(files) });
    const undone = applyTo(files, undo);

    expect(undo.notes.join(" ")).toContain("you changed endpoint after init");
    expect(JSON.parse(undone.get(CONFIG)!).endpoint).toBe("https://mine.example/mcp");
  });

  it("★I2 사용자가 적은 managed 칸을 복구 근거로 읽지 않는다", () => {
    // 기록이 우리 파일로 나갔으므로 config 의 managed 는 «사용자 것»이다.
    const mine = { created: ["AGENTS.md"], lastWritten: { "AGENTS.md": "x" } };
    const files = snapshot({ [CONFIG]: json({ managed: mine }) });

    const undo = planUndo({ files, managed: readRecordBody(files.get(RECORD)) });

    expect(undo.deletes).toEqual([]);
    expect(undo.writes).toEqual([]);
    expect(undo.notes.join(" ")).toContain("No record of a previous init");
  });

  it("★I5 저장된 null 백업이 «백업 없음»으로 바뀌지 않는다", () => {
    const before = { ".mcp.json": json({ mcpServers: { "ai-erd": null, other: { url: "u" } } }) };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const files = applyTo(snapshot(before), init);
    // 사용자가 우리 항목을 손으로 지웠다 — 목표는 «null 로 되돌리기»이고 「없음」이 아니다.
    files.set(".mcp.json", json({ mcpServers: { other: { url: "u" } } }));

    const undone = applyTo(files, planUndo({ files, managed: recordOf(files) }));
    const servers = JSON.parse(undone.get(".mcp.json")!).mcpServers;

    expect(Object.prototype.hasOwnProperty.call(servers, "ai-erd")).toBe(true);
    expect(servers["ai-erd"]).toBeNull();
  });

  it("★I5 객체와 «그 객체의 JSON 문자열»을 같은 것으로 보지 않는다", () => {
    const mine = { command: "mine", args: ["x"] };
    const before = { ".mcp.json": json({ mcpServers: { "ai-erd": mine } }) };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const files = applyTo(snapshot(before), init);
    // 타입만 다른 값 — 문자열이다. 「원본 복구 완료」로 보면 객체 백업을 잃는다.
    files.set(".mcp.json", json({ mcpServers: { "ai-erd": JSON.stringify(mine) } }));

    const undo = planUndo({ files, managed: recordOf(files) });

    expect(undo.notes.join(" ")).not.toContain("already back in place");
    expect(recordOf(applyTo(files, undo))?.replacedEntries[".mcp.json"]).toEqual(mine);
  });

  it("★I6 init 전부터 펜스 안에 있던 예제 때문에 반복 undo 가 안 끝나지 않는다", () => {
    const example = `# Rules\n\n\`\`\`md\n${MARKER_BEGIN}\nexample\n${MARKER_END}\n\`\`\`\n`;
    const before = { "AGENTS.md": example };
    let files = applyTo(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));

    const seen: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      files = applyTo(files, planUndo({ files, managed: recordOf(files) }));
      seen.push(String(files.get("AGENTS.md")));
    }

    expect(files.get("AGENTS.md")).toBe(example);
    expect(new Set(seen).size).toBe(1);
    expect(recordOf(files)).toBeUndefined();
  });

  it("★I4 건너뛴 파일의 옛 백업을 버리지 않는다", () => {
    const mineBlock = `${MARKER_BEGIN}\nmine\n${MARKER_END}`;
    const before = { "AGENTS.md": `# Rules\n\n${mineBlock}\n` };
    const first = planInit({ ...BASE, files: snapshot(before) });
    const files = applyTo(snapshot(before), first);
    expect(recordOf(files)?.replacedBlocks["AGENTS.md"]).toBe(mineBlock);
    // 쓸 수 없는 모양으로 만든다 — 열린 펜스를 «앞»에 두면 우리 블록이 그 안으로 들어간다.
    files.set("AGENTS.md", `\`\`\`sh\nunclosed\n${files.get("AGENTS.md")}`);

    const second = planInit({ ...BASE, files, previous: recordOf(files) });

    expect(second.notes.join(" ")).toContain("unclosed code fence");
    // ★건너뛴 파일의 백업은 그대로 있어야 한다 — 새 기준도 못 세웠으므로.
    expect(second.managed?.replacedBlocks["AGENTS.md"]).toBe(mineBlock);
  });

  it("★S2 안내대로 지운 뒤에는 원본을 도로 넣는다 — 같은 안내를 반복하지 않는다", () => {
    const mine = { command: "mine", args: ["x"] };
    const before = { ".mcp.json": json({ mcpServers: { "ai-erd": mine } }) };
    const init = planInit({ ...BASE, files: snapshot(before) });
    let files = applyTo(snapshot(before), init);
    // 우리 항목을 «편집»하면 undo 는 손으로 지우라고 한다.
    const edited = JSON.parse(files.get(".mcp.json")!);
    edited.mcpServers["ai-erd"].env = { MINE: "1" };
    files.set(".mcp.json", json(edited));
    expect(planUndo({ files, managed: recordOf(files) }).notes.join(" ")).toContain("Remove it by hand");

    // 안내대로 지웠다 — 이제 남은 일은 «원본을 도로 넣는 것»이다.
    files.set(".mcp.json", json({ mcpServers: {} }));
    files = applyTo(files, planUndo({ files, managed: recordOf(files) }));

    expect(JSON.parse(files.get(".mcp.json")!).mcpServers["ai-erd"]).toEqual(mine);
    expect(recordOf(files)).toBeUndefined();
  });
});
