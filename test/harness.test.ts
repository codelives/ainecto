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
  MARKER_BEGIN,
  MARKER_END,
  removeMarkerBlock,
  renderAgentNote,
  renderHarnessDoc,
  upsertMarkerBlock,
} from "../src/core/harness/harnessDoc";
import { detectRoles, planInit, planUndo } from "../src/core/harness/initPlan";
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

    expect(second.writes.map((write) => write.path)).toEqual([".ai-erd/HARNESS.md", ".ai-erd/config.json"]);
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
