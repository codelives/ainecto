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
  markerEvidence,
  removeMarkerBlock,
  renderAgentNote,
  renderHarnessDoc,
  upsertMarkerBlock,
} from "../src/core/harness/harnessDoc";
import { detectRoles, planInit, planUndo, readRecord } from "../src/core/harness/initPlan";
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

const RECORD_FILE = ".ai-erd/init-record.json";

/**
 * 되돌리기 기록. ★<b>한 파일의 사실이 한 항목에 모였다</b> — 평행한 map 아홉 개가 아니다.
 * 그 어긋남이 다섯 차수를 관통한 실패의 이름이었다(2026-09-27 8차 독립 리뷰).
 */
function recordOf(files: Map<string, string | undefined>) {
  const state = readRecord(files.get(RECORD_FILE));
  return state.state === "valid" ? state.record : undefined;
}

/** 계획을 스냅샷에 «적용»한 결과. 반복 실행의 수렴을 보려면 이게 필요하다. */
function applied(
  files: Map<string, string | undefined>,
  plan: { writes: { path: string; content: string }[]; deletes: string[] },
) {
  const next = new Map(files);
  for (const write of plan.writes) next.set(write.path, write.content);
  for (const path of plan.deletes) next.set(path, undefined);
  return next;
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

    // ★<b>정말 «하나도» 안 쓴다.</b> 이 시험의 이름이 원래 그것이었는데, 그동안은 HARNESS.md 와
    //   기록 파일을 매번 다시 써서 기대값에 그 둘을 적어 두고 있었다 — 시험이 이름보다 약했다.
    //   파일별 계약으로 옮기면서 「내용이 같으면 쓰지 않는다」가 모든 파일에 한 규칙으로 걸린다.
    expect(second.writes.map((write) => write.path)).toEqual([]);
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

    const undo = planUndo({ files: after });
    const undone = Object.fromEntries(undo.writes.map((write) => [write.path, write.content]));

    expect(undone[".mcp.json"]).toBe(before[".mcp.json"]);
    expect(undone["AGENTS.md"]).toBe(before["AGENTS.md"]);
    expect(undo.deletes).toContain(".ai-erd/HARNESS.md");
    expect(undo.deletes).toContain(".ai-erd/config.json");
  });

  it("deletes files it created outright, and keeps ones it only edited", () => {
    const init = planInit({ ...BASE, files: snapshot({}) });
    const after = snapshot(Object.fromEntries(init.writes.map((write) => [write.path, write.content])));

    const undo = planUndo({ files: after });

    expect(undo.deletes).toContain(".mcp.json");
    expect(undo.deletes).toContain(".cursor/mcp.json");
    expect(undo.deletes).toContain("AGENTS.md");
  });

  it("keeps files that existed before init, even when the name is ours", () => {
    // ★이름이 같다는 이유로 남의 파일을 지우던 것이 I2 였다.
    const before = { ".ai-erd/HARNESS.md": "mine\n", ".ai-erd/config.json": "{}\n" };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const after = snapshot(Object.fromEntries(init.writes.map((w) => [w.path, w.content])));

    const undo = planUndo({ files: after });

    expect(undo.deletes).not.toContain(".ai-erd/HARNESS.md");
    expect(undo.notes.join(" ")).toContain("existed before init");
  });

  it("puts back a user's own ai-erd entry instead of deleting it", () => {
    const mine = { command: "old", args: ["x"], env: { MY_SETTING: "preserve" } };
    const before = { ".mcp.json": `${JSON.stringify({ mcpServers: { "ai-erd": mine } }, null, 2)}\n` };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const after = snapshot(Object.fromEntries(init.writes.map((w) => [w.path, w.content])));

    const undo = planUndo({ files: after });
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

    const undo = planUndo({ files: after });
    const restored = JSON.parse(undo.writes.find((w) => w.path === ".mcp.json")!.content);

    expect(restored.mcpServers["ai-erd"]).toEqual(mine);
  });

  it("★이미 있던 HARNESS.md 는 원본으로 되돌린다", () => {
    const before = { ".ai-erd/HARNESS.md": "MY OWN NOTES\n" };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const after = snapshot(Object.fromEntries(init.writes.map((w) => [w.path, w.content])));

    const undo = planUndo({ files: after });

    expect(undo.writes.find((w) => w.path === ".ai-erd/HARNESS.md")?.content).toBe("MY OWN NOTES\n");
    expect(undo.deletes).not.toContain(".ai-erd/HARNESS.md");
  });

  it("★이미 있던 규칙 블록도 원본으로 되돌린다", () => {
    const mineBlock = "<!-- ai-erd:begin -->\nMY OWN RULES\n<!-- ai-erd:end -->";
    const before = { "AGENTS.md": `# Rules\n\n${mineBlock}\n` };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const after = snapshot(Object.fromEntries(init.writes.map((w) => [w.path, w.content])));

    const undo = planUndo({ files: after });

    expect(undo.writes.find((w) => w.path === "AGENTS.md")?.content).toContain("MY OWN RULES");
  });

  it("★우리가 만든 파일도 사용자가 고쳤으면 지우지 않는다", () => {
    const init = planInit({ ...BASE, files: snapshot({}) });
    const written = Object.fromEntries(init.writes.map((w) => [w.path, w.content]));
    written[".ai-erd/HARNESS.md"] = `${written[".ai-erd/HARNESS.md"]}\n\n내가 덧붙인 줄\n`;

    const undo = planUndo({ files: snapshot(written) });

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

  const json = (body: unknown) => `${JSON.stringify(body, null, 2)}\n`;

  it("★I1 사용자가 config 에 적은 칸을 되돌리기가 덮지 않는다", () => {
    // 원본 config 가 있으면 «무조건» 그것으로 덮던 자리다. 그 사이의 편집이 사라졌다.
    const before = { [CONFIG]: json({ mine: "before-init" }) };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const files = applied(snapshot(before), init);
    const ours = JSON.parse(files.get(CONFIG)!) as Record<string, unknown>;
    ours.mine = "edited-after-init";
    files.set(CONFIG, json(ours));

    const undone = applied(files, planUndo({ files }));

    expect(JSON.parse(undone.get(CONFIG)!).mine).toBe("edited-after-init");
  });

  it("★I1 기록을 줄여 쓴다는 이유로 사용자 칸을 우리 것으로 삼지 않는다", () => {
    const init = planInit({ ...BASE, files: snapshot({}) });
    let files = applied(snapshot({}), init);
    // 사용자가 config 에 자기 칸을 더하고, 우리 MCP 항목도 손댔다(= 해소 안 된 충돌).
    files.set(CONFIG, json({ ...JSON.parse(files.get(CONFIG)!), mine: "keep-me" }));
    const mcp = JSON.parse(files.get(".mcp.json")!);
    mcp.mcpServers["ai-erd"].args = [...mcp.mcpServers["ai-erd"].args, "--mine"];
    files.set(".mcp.json", json(mcp));

    // 1차 — 충돌이 남았으니 기록을 «줄여서» 남긴다. 사용자 칸은 그대로.
    files = applied(files, planUndo({ files }));
    expect(JSON.parse(files.get(CONFIG)!).mine).toBe("keep-me");

    // 사람이 안내대로 우리 항목을 손으로 지워 충돌을 해소했다.
    files.set(".mcp.json", json({ mcpServers: {} }));

    // 2차 — 끝났다. 우리 칸만 걷히고 사용자 칸은 남는다(파일이 사라지지 않는다).
    files = applied(files, planUndo({ files }));
    expect(files.get(CONFIG)).toBeDefined();
    expect(JSON.parse(files.get(CONFIG)!).mine).toBe("keep-me");
    expect(JSON.parse(files.get(CONFIG)!).managed).toBeUndefined();
  });

  it("★I2 손으로 원본 파일을 되돌려 놨으면 끝난 것으로 본다", () => {
    const before = { ".ai-erd/HARNESS.md": "my own harness notes\n" };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const files = applied(snapshot(before), init);
    files.set(".ai-erd/HARNESS.md", before[".ai-erd/HARNESS.md"]);

    const undo = planUndo({ files });

    expect(undo.notes.join(" ")).toContain("already the file that existed before init");
    // 그리고 기록이 남지 않는다 — 다시 돌려도 할 일이 없다(수렴).
    expect(recordOf(applied(files, undo))).toBeUndefined();
  });

  it("★I2 우리가 «더한» 항목을 손으로 지웠으면 그것도 끝난 것이다", () => {
    // 되돌릴 목표가 「없음」인 항목. 예전엔 백업이 없으면 곧바로 충돌로 봐서 안 끝났다.
    const before = { ".mcp.json": json({ mcpServers: { sentry: { type: "http", url: "https://x" } } }) };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const files = applied(snapshot(before), init);
    files.set(".mcp.json", before[".mcp.json"]);

    const undo = planUndo({ files });

    expect(undo.notes.join(" ")).toContain("already gone");
    expect(recordOf(applied(files, undo))).toBeUndefined();
  });

  it("★I2 우리가 «더한» 블록을 손으로 지웠으면 그것도 끝난 것이다", () => {
    const before = { "AGENTS.md": "# House rules\n\nBe careful.\n" };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const files = applied(snapshot(before), init);
    files.set("AGENTS.md", before["AGENTS.md"]);

    const undo = planUndo({ files });

    expect(undo.notes.join(" ")).toContain("already");
    expect(recordOf(applied(files, undo))).toBeUndefined();
  });

  it("★I2 되돌린 상태에서 네 번 더 돌려도 같은 곳에 선다", () => {
    const before = { ".ai-erd/HARNESS.md": "mine\n" };
    let files = applied(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));
    files.set(".ai-erd/HARNESS.md", before[".ai-erd/HARNESS.md"]);

    const seen: string[] = [];
    for (let round = 0; round < 4; round += 1) {
      files = applied(files, planUndo({ files }));
      seen.push(JSON.stringify([...files].filter(([, body]) => body !== undefined).sort()));
    }

    // ⚠「상태가 안 변한다」만으로는 모자란다 — «안정적이지만 영영 미해결»도 안 변한다.
    //   수렴의 증거는 <b>할 일이 없어진 것</b>이다: 기록이 사라지고 원본만 남았다.
    expect(new Set(seen.slice(1)).size).toBe(1);
    expect(files.get(".ai-erd/HARNESS.md")).toBe(before[".ai-erd/HARNESS.md"]);
    expect(recordOf(files)).toBeUndefined();
    expect(files.get(CONFIG)).toBeUndefined();
  });

  it("★I3 기록보다 «지금 파일»이 최신이면 그것을 새 원본으로 삼는다", () => {
    const a = { command: "A", args: ["--a"] };
    const b = { command: "B", args: ["--b"] };
    const before = { ".mcp.json": json({ mcpServers: { "ai-erd": a } }) };
    let files = applied(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));
    // 사용자가 우리 항목을 자기 것 B 로 갈아 끼웠다(= 완료된 기록이 낡았다).
    files.set(".mcp.json", json({ mcpServers: { "ai-erd": b } }));

    files = applied(files, planInit({ ...BASE, files }));
    const undo = planUndo({ files });

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

    let files = applied(snapshot(before), first);
    files = applied(files, planInit({ ...BASE, files }));
    expect(files.get("AGENTS.md")).toBe(before["AGENTS.md"]);
  });

  it("★I4 우리 것으로 알아볼 수 없는 블록이 파일에 있으면 기록을 지키고 알린다", () => {
    const before = { "AGENTS.md": "# Rules\n\nBe careful.\n" };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const files = applied(snapshot(before), init);
    // 사람이 블록을 코드펜스 안으로 옮겼다 — 있지만 «우리 것으로» 안 보인다.
    files.set("AGENTS.md", `# Rules\n\n\`\`\`md\n${MARKER_BEGIN}\nx\n${MARKER_END}\n\`\`\`\n`);

    const undo = planUndo({ files });

    // ⚠문구는 9차 2차 리뷰에서 한 판정으로 합쳐졌다(개수·모양·잔류 세 갈래 → 증거 대조 하나).
    //   뜻은 그대로다: 「이 파일의 마커를 기록으로 설명할 수 없다」.
    expect(undo.notes.join(" ")).toContain("cannot account for");
    // 「없으니 끝났다」로 기록을 지우지 않는다 — 블록은 파일에 남아 있다.
    expect(recordOf(applied(files, undo))).toBeDefined();
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
  const json = (body: unknown) => `${JSON.stringify(body, null, 2)}\n`;


  it("★I1 편집하지 않은 init→undo 가 원래 config 를 지우지 않는다", () => {
    // ★7차가 잡은 정상 경로 퇴행. 같은 입력에서 6차는 원본을 복원했고 내 수정이 삭제했다.
    const before = { [CONFIG]: json({ userSetting: "KEEP ORIGINAL" }) };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const written = applied(snapshot(before), init);

    // ★유실은 undo 가 아니라 init 에서 일어났다 — 그 자리부터 본다.
    expect(JSON.parse(written.get(CONFIG)!).userSetting).toBe("KEEP ORIGINAL");

    const undone = applied(written, planUndo({ files: written }));
    expect(undone.get(CONFIG)).toBeDefined();
    expect(JSON.parse(undone.get(CONFIG)!).userSetting).toBe("KEEP ORIGINAL");
  });

  it("★I1 init 뒤에 더한 사용자 칸이 재init 에서도 살아남는다", () => {
    const first = planInit({ ...BASE, files: snapshot({}) });
    let files = applied(snapshot({}), first);
    files.set(CONFIG, json({ ...JSON.parse(files.get(CONFIG)!), mine: "keep" }));

    files = applied(files, planInit({ ...BASE, files }));

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
    const files = applied(snapshot({}), init);
    const edited = JSON.parse(files.get(CONFIG)!) as Record<string, unknown>;
    edited.endpoint = "https://mine.example/mcp";
    files.set(CONFIG, json(edited));

    const undo = planUndo({ files });
    const undone = applied(files, undo);

    expect(undo.notes.join(" ")).toContain("you changed endpoint after init");
    expect(JSON.parse(undone.get(CONFIG)!).endpoint).toBe("https://mine.example/mcp");
  });

  it("★I2 사용자가 적은 managed 칸을 복구 근거로 읽지 않는다", () => {
    // 기록이 우리 파일로 나갔으므로 config 의 managed 는 «사용자 것»이다.
    const mine = { created: ["AGENTS.md"], lastWritten: { "AGENTS.md": "x" } };
    const files = snapshot({ [CONFIG]: json({ managed: mine }) });

    const undo = planUndo({ files });

    expect(undo.deletes).toEqual([]);
    expect(undo.writes).toEqual([]);
    expect(undo.notes.join(" ")).toContain("No record of a previous init");
  });

  it("★I5 저장된 null 백업이 «백업 없음»으로 바뀌지 않는다", () => {
    const before = { ".mcp.json": json({ mcpServers: { "ai-erd": null, other: { url: "u" } } }) };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const files = applied(snapshot(before), init);
    // 사용자가 우리 항목을 손으로 지웠다 — 목표는 «null 로 되돌리기»이고 「없음」이 아니다.
    files.set(".mcp.json", json({ mcpServers: { other: { url: "u" } } }));

    const undone = applied(files, planUndo({ files }));
    const servers = JSON.parse(undone.get(".mcp.json")!).mcpServers;

    expect(Object.prototype.hasOwnProperty.call(servers, "ai-erd")).toBe(true);
    expect(servers["ai-erd"]).toBeNull();
  });

  it("★I5 객체와 «그 객체의 JSON 문자열»을 같은 것으로 보지 않는다", () => {
    const mine = { command: "mine", args: ["x"] };
    const before = { ".mcp.json": json({ mcpServers: { "ai-erd": mine } }) };
    const init = planInit({ ...BASE, files: snapshot(before) });
    const files = applied(snapshot(before), init);
    // 타입만 다른 값 — 문자열이다. 「원본 복구 완료」로 보면 객체 백업을 잃는다.
    files.set(".mcp.json", json({ mcpServers: { "ai-erd": JSON.stringify(mine) } }));

    const undo = planUndo({ files });

    expect(undo.notes.join(" ")).not.toContain("already back in place");
    expect(recordOf(applied(files, undo))?.files[".mcp.json"]?.original)
      .toEqual({ at: "json", value: mine });
  });

  it("★I6 init 전부터 펜스 안에 있던 예제 때문에 반복 undo 가 안 끝나지 않는다", () => {
    const example = `# Rules\n\n\`\`\`md\n${MARKER_BEGIN}\nexample\n${MARKER_END}\n\`\`\`\n`;
    const before = { "AGENTS.md": example };
    let files = applied(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));

    const seen: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      files = applied(files, planUndo({ files }));
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
    const files = applied(snapshot(before), first);
    expect(recordOf(files)?.files["AGENTS.md"]?.original).toEqual({ at: "text", text: mineBlock });
    // 쓸 수 없는 모양으로 만든다 — 열린 펜스를 «앞»에 두면 우리 블록이 그 안으로 들어간다.
    files.set("AGENTS.md", `\`\`\`sh\nunclosed\n${files.get("AGENTS.md")}`);

    const second = planInit({ ...BASE, files });

    expect(second.notes.join(" ")).toContain("unclosed code fence");
    // ★건너뛴 파일의 백업은 그대로 있어야 한다 — 새 기준도 못 세웠으므로.
    expect(second.record?.files["AGENTS.md"]?.original).toEqual({ at: "text", text: mineBlock });
  });

  it("★S2 안내대로 지운 뒤에는 원본을 도로 넣는다 — 같은 안내를 반복하지 않는다", () => {
    const mine = { command: "mine", args: ["x"] };
    const before = { ".mcp.json": json({ mcpServers: { "ai-erd": mine } }) };
    const init = planInit({ ...BASE, files: snapshot(before) });
    let files = applied(snapshot(before), init);
    // 우리 항목을 «편집»하면 undo 는 손으로 지우라고 한다.
    const edited = JSON.parse(files.get(".mcp.json")!);
    edited.mcpServers["ai-erd"].env = { MINE: "1" };
    files.set(".mcp.json", json(edited));
    expect(planUndo({ files }).notes.join(" ")).toContain("Remove it by hand");

    // 안내대로 지웠다 — 이제 남은 일은 «원본을 도로 넣는 것»이다.
    files.set(".mcp.json", json({ mcpServers: {} }));
    files = applied(files, planUndo({ files }));

    expect(JSON.parse(files.get(".mcp.json")!).mcpServers["ai-erd"]).toEqual(mine);
    expect(recordOf(files)).toBeUndefined();
  });
});

/**
 * ★<b>9차 독립 리뷰 — 커밋 게이트.</b> 8차의 세 경계를 넣은 «뒤»에 남아 있던 구멍들이다.
 *
 * <p>두 가지가 이 차수의 배움이다:
 * <ul>
 *   <li><b>칸이 «있는지»에서 멈추면 반쯤 맞는 기록으로 파일을 고친다</b>(B1). 로더가 map 두 개가
 *       객체인지만 봤고, 한쪽에서 칸 하나를 지운 기록을 «유효»로 돌려줬다.</li>
 *   <li><b>개수로는 갈리지 않는 경우가 있다</b>(B2). 「예제를 지우고 그 자리에 우리 블록을
 *       옮기기」는 마커 총수를 유지한다 — 그래서 우리 블록이 남아 있는데도 «완료»로 읽혔다.</li>
 * </ul>
 */
describe("9차 독립 리뷰 — 반쯤 맞는 기록과 옮겨진 블록", () => {
  const CONFIG = ".ai-erd/config.json";
  const json = (body: unknown) => `${JSON.stringify(body, null, 2)}\n`;

  /** 기록 파일을 «손으로 고친» 상태를 만든다 — 사용자·다른 도구·병합 사고가 하는 일이다. */
  function tamperRecord(
    files: Map<string, string | undefined>,
    edit: (record: { files: Record<string, Record<string, unknown>> }) => void,
  ) {
    const raw = JSON.parse(files.get(RECORD_FILE)!) as { files: Record<string, Record<string, unknown>> };
    edit(raw);
    const next = new Map(files);
    next.set(RECORD_FILE, `${JSON.stringify(raw, null, 2)}\n`);
    return next;
  }

  it("★B1 writtenFields 의 칸 하나가 빠진 기록은 «손상»이다 — 백업을 지우지 않는다", () => {
    const before = { [CONFIG]: json({ endpoint: "https://mine.example/mcp" }) };
    const files = applied(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));
    const tampered = tamperRecord(files, (record) => {
      delete (record.files[CONFIG]!.writtenFields as Record<string, unknown>).endpoint;
    });

    // ★로더가 먼저 거절한다. 예전엔 valid 를 돌려줬고, 그래서 그다음이 전부 틀렸다.
    const state = readRecord(tampered.get(RECORD_FILE));
    expect(state.state).toBe("corrupt");

    const undo = planUndo({ files: tampered });
    expect(undo.writes).toHaveLength(0);
    expect(undo.deletes).toHaveLength(0);
    // 사용자 원본이 든 기록이 그대로 있어야 한다.
    expect(tampered.get(RECORD_FILE)).toContain("https://mine.example/mcp");
  });

  it("★B1 originalFields 의 칸 하나가 빠진 기록도 «손상»이다 — config 를 비우지 않는다", () => {
    const before = { [CONFIG]: json({ endpoint: "https://mine.example/mcp" }) };
    const files = applied(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));
    const tampered = tamperRecord(files, (record) => {
      delete (record.files[CONFIG]!.originalFields as Record<string, unknown>).endpoint;
    });

    expect(readRecord(tampered.get(RECORD_FILE)).state).toBe("corrupt");
    const undone = applied(tampered, planUndo({ files: tampered }));

    // ★예전엔 이 경로가 config 를 {} 로 만들었다 — 우리 칸은 「우리가 더한 것」으로 읽히고
    //   사용자 원본은 빠진 기록 탓에 되살릴 수 없었기 때문이다. 지금은 손대지 않는다.
    expect(JSON.parse(undone.get(CONFIG)!).endpoint).toBe(BASE.endpoint);
    expect(Object.keys(JSON.parse(undone.get(CONFIG)!)).length).toBeGreaterThan(0);
    // ★기록 파일을 지우지 않는다 — 읽어 내지 못한 것은 「없는 것」이 아니다.
    const undo = planUndo({ files: tampered });
    expect(undo.writes).toHaveLength(0);
    expect(undo.deletes).toHaveLength(0);
    expect(undone.get(RECORD_FILE)).toBeDefined();
  });

  it("★B1 우리가 쓴 본문과 어긋난 값을 든 기록도 «손상»이다", () => {
    const files = applied(snapshot({}), planInit({ ...BASE, files: snapshot({}) }));
    const tampered = tamperRecord(files, (record) => {
      (record.files[CONFIG]!.writtenFields as Record<string, unknown>).endpoint = "https://elsewhere/mcp";
    });

    const state = readRecord(tampered.get(RECORD_FILE));
    expect(state.state).toBe("corrupt");
    expect(state.state === "corrupt" ? state.reason : "").toContain("endpoint");
  });

  it("★B1 판단 재료가 빠지면 되돌리기가 «완료»로 바꾸지 않는다 (로더를 지나쳐 들어와도)", () => {
    const before = { [CONFIG]: json({ endpoint: "https://mine.example/mcp" }) };
    const files = applied(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));
    const valid = recordOf(files)!;
    // ★로더 뒤의 층을 따로 시험한다 — 계약이 어떤 경로로 들어와도 이 판정은 유지돼야 한다.
    const contract = valid.files[CONFIG]!;
    const partial = { ...contract.writtenFields };
    delete partial.endpoint;
    const undo = planUndo({
      files,
      record: { state: "valid", record: { ...valid, files: { ...valid.files, [CONFIG]: { ...contract, writtenFields: partial } } } },
    });

    // ★2차 리뷰 뒤: 로더와 «같은» 검증 함수가 여기서도 돌아 더 앞에서 잡는다.
    //   문구는 그 검증의 사유이고, 뜻은 같다 — 두 map 이 서로 다른 칸을 말한다.
    expect(undo.notes.join(" ")).toContain("lists different fields as written");
    expect(undo.writes.find((write) => write.path === CONFIG)).toBeUndefined();
    // ★기록은 줄여서 «다시 쓴다» — 지우지 않는다.
    expect(undo.deletes).not.toContain(RECORD_FILE);
    expect(JSON.parse(writtenAt(undo, RECORD_FILE)!).files[CONFIG]).toBeDefined();
  });

  it("★B2 우리 블록이 닫힌 펜스 안으로 옮겨졌으면 재init 이 계약을 버리지 않는다", () => {
    const mineBlock = `${MARKER_BEGIN}\nMY OWN RULES\n${MARKER_END}`;
    const before = { "AGENTS.md": `# Rules\n\n${mineBlock}\n` };
    let files = applied(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));
    const ourBlock = recordOf(files)!.files["AGENTS.md"]!.written;
    expect(ourBlock.at).toBe("text");
    // 우리 블록을 «닫힌» 펜스 안으로 옮긴다 — upsert 는 여기서 거절하지 않는다.
    files.set("AGENTS.md", `# Rules\n\n\`\`\`md\n${ourBlock.at === "text" ? ourBlock.text : ""}\n\`\`\`\n`);

    const second = planInit({ ...BASE, files });

    expect(second.notes.join(" ")).toContain("not where ai-erd can find it again");
    expect(second.writes.find((write) => write.path === "AGENTS.md")).toBeUndefined();
    // ★사용자 원본 블록의 백업이 살아 있어야 한다. 예전엔 여기서 버려졌다.
    expect(second.record?.files["AGENTS.md"]?.original).toEqual({ at: "text", text: mineBlock });
  });

  it("★B2 예제를 지우고 그 자리에 우리 블록을 옮겨도 «완료»가 아니다 (마커 총수가 같다)", () => {
    const example = "# Rules\n\n```md\n" + `${MARKER_BEGIN}\nEXAMPLE ONLY\n${MARKER_END}` + "\n```\n";
    const before = { "AGENTS.md": example };
    const files = applied(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));
    const ourBlock = recordOf(files)!.files["AGENTS.md"]!.written;
    // 예제를 지우고 그 자리에 우리 블록을 넣는다 — begin 개수는 1 그대로다.
    const moved = new Map(files);
    moved.set("AGENTS.md", "# Rules\n\n```md\n" + (ourBlock.at === "text" ? ourBlock.text : "") + "\n```\n");

    const undo = planUndo({ files: moved });

    expect(undo.notes.join(" ")).toContain("cannot account for");
    // ★기록을 지키고 파일도 건드리지 않는다. 예전엔 「이미 사라졌다」로 읽고 기록을 지웠다.
    expect(undo.deletes).not.toContain(RECORD_FILE);
    expect(JSON.parse(writtenAt(undo, RECORD_FILE)!).files["AGENTS.md"]).toBeDefined();
  });

  it("★B2 우리 블록의 사본이 «다른 자리에» 한 벌 더 있으면 미해결이다", () => {
    const files = applied(snapshot({ "AGENTS.md": "# Rules\n" }), planInit({ ...BASE, files: snapshot({ "AGENTS.md": "# Rules\n" }) }));
    const ourBlock = recordOf(files)!.files["AGENTS.md"]!.written;
    const both = new Map(files);
    // 정상 위치의 블록 + 펜스 안의 사본. 앞의 것만 걷어내면 뒤의 것이 남는다.
    both.set("AGENTS.md", `${files.get("AGENTS.md")}\n\`\`\`md\n${ourBlock.at === "text" ? ourBlock.text : ""}\n\`\`\`\n`);

    const undo = planUndo({ files: both });

    expect(undo.notes.join(" ")).toContain("cannot account for");
    expect(undo.deletes).not.toContain(RECORD_FILE);
  });
});

/**
 * ★<b>9차 2차 리뷰 — 부분 수정이었던 두 건.</b> 1차 수정은 B1·B2 를 «닫았다»고 주장했고,
 * 리뷰가 그 둘을 각각 다섯·네 모양으로 다시 뚫었다. 배운 것 하나로 요약된다:
 *
 * <p><b>「우리 블록을 알아본다」로 짜면 계속 뚫린다.</b> 제목 한 줄만 고쳐도, 인용문으로 옮겨도,
 * 마커를 겹쳐도 못 알아보고 그것을 「없다」로 읽어 백업을 버렸다. 거꾸로 init 전부터 있던
 * «똑같은» 예제는 우리 것으로 오인해 정상 되돌리기를 막았다(내가 만든 회귀 N1).
 * ⇒ 알아보려 하지 않는다. <b>init 전에 무엇이 있었는지를 기록해 두고, 그것으로 설명되지 않는
 * 마커가 있으면 완료로 만들지 않는다.</b> 모양 비교는 「적어 둔 예제가 그대로 있나」에만 쓴다.
 *
 * <p>fields 쪽도 같은 종류였다 — 「칸이 있나」에서 멈추면 반쯤 맞는 기록으로 파일을 고친다.
 * 원본이 {@code text} 로 바뀐 기록 하나가 실제로 config 를 비우고 기록을 지웠다.
 */
describe("9차 2차 리뷰 — 증거로 판정한다", () => {
  const CONFIG = ".ai-erd/config.json";
  const AGENTS = "AGENTS.md";
  const json = (body: unknown) => `${JSON.stringify(body, null, 2)}\n`;

  function tamper(
    files: Map<string, string | undefined>,
    edit: (record: { files: Record<string, Record<string, unknown>> }) => void,
  ) {
    const raw = JSON.parse(files.get(RECORD_FILE)!) as { files: Record<string, Record<string, unknown>> };
    edit(raw);
    const next = new Map(files);
    next.set(RECORD_FILE, `${JSON.stringify(raw, null, 2)}\n`);
    return next;
  }

  /** init 이 이 파일에 실제로 쓴 블록 원문. 「우리 블록을 옮긴다」를 만들려면 이것이 필요하다. */
  function ourBlock(files: Map<string, string | undefined>, path: string): string {
    const written = recordOf(files)!.files[path]!.written;
    if (written.at !== "text") throw new Error("block contract must hold the text it wrote");
    return written.text;
  }

  // ───────────────────────── B1 ─────────────────────────

  it("★B1 원본이 «되돌릴 수 없는 모양»인 기록은 손상이다 — config 를 비우지 않는다", () => {
    // 2차 리뷰: originalFields.endpoint 를 {at:"text"} 로 바꾸면 로더가 valid 를 줬고,
    // 실제 undo 가 config 를 {} 로 만들고 복구 기록을 지웠다. 원본은 absent 또는 json 뿐이다.
    const before = { [CONFIG]: json({ endpoint: "https://mine.example/mcp" }) };
    const files = applied(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));
    const tampered = tamper(files, (record) => {
      (record.files[CONFIG]!.originalFields as Record<string, unknown>).endpoint =
        { at: "text", text: "https://mine.example/mcp" };
    });

    const state = readRecord(tampered.get(RECORD_FILE));
    expect(state.state).toBe("corrupt");
    expect(state.state === "corrupt" ? state.reason : "").toContain("--undo can put back");

    const undo = planUndo({ files: tampered });
    expect(undo.writes).toHaveLength(0);
    expect(undo.deletes).toHaveLength(0);
  });

  it("★B1 두 map 에서 «동시에» 빠진 칸도 완료로 바뀌지 않는다", () => {
    // ⚠로더는 이것을 못 본다 — 어느 칸이 «우리 것»인지는 형식 층의 지식이 아니다(⑨).
    //   그 지식을 가진 계획 층이 같은 검증 함수에 그 목록을 넘겨서 잡는다.
    const before = { [CONFIG]: json({ endpoint: "https://mine.example/mcp" }) };
    const files = applied(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));
    const tampered = tamper(files, (record) => {
      delete (record.files[CONFIG]!.writtenFields as Record<string, unknown>).endpoint;
      delete (record.files[CONFIG]!.originalFields as Record<string, unknown>).endpoint;
    });

    const undo = planUndo({ files: tampered });

    expect(undo.notes.join(" ")).toContain("does not record what it put there");
    expect(undo.writes.find((write) => write.path === CONFIG)).toBeUndefined();
    expect(undo.deletes).not.toContain(RECORD_FILE);
  });

  it("★B1 로더를 지나쳐 들어온 계약도 «같은» 검증을 받는다", () => {
    const before = { [CONFIG]: json({ endpoint: "https://mine.example/mcp" }) };
    const files = applied(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));
    const valid = recordOf(files)!;
    const contract = valid.files[CONFIG]!;
    const cases: Array<[string, Record<string, unknown>]> = [
      ["원본 칸이 없다", { ...contract, originalFields: {} }],
      ["쓴 값이 본문과 다르다", {
        ...contract,
        writtenFields: { ...contract.writtenFields, endpoint: "https://elsewhere/mcp" },
      }],
    ];
    for (const [label, broken] of cases) {
      const undo = planUndo({
        files,
        record: { state: "valid", record: { ...valid, files: { ...valid.files, [CONFIG]: broken as never } } },
      });
      expect(undo.writes.find((write) => write.path === CONFIG), label).toBeUndefined();
      expect(undo.deletes, label).not.toContain(RECORD_FILE);
    }
  });

  // ───────────────────────── B2 ─────────────────────────

  /** 우리 블록을 «이 모양으로» 옮겨 놓는다. 다섯 가지 전부 1차 수정을 뚫었다. */
  const movedInto: Array<[string, (block: string) => string]> = [
    ["닫힌 펜스 + 제목만 편집", (b) => "# Rules\n\n```md\n"
      + b.replace("## AI-ERD Harness", "## EDITED AI-ERD Harness") + "\n```\n"],
    ["인용문", (b) => `# Rules\n\n${b.split("\n").map((line) => `> ${line}`).join("\n")}\n`],
    ["바깥 마커 쌍으로 감싸기", (b) => `# Rules\n\n${MARKER_BEGIN}\n${b}\n${MARKER_END}\n`],
  ];

  for (const [label, move] of movedInto) {
    it(`★B2 우리 블록을 «${label}»으로 옮기면 재init 이 백업을 버리지 않는다`, () => {
      const mineBlock = `${MARKER_BEGIN}\nORIGINAL USER BLOCK\n${MARKER_END}`;
      const before = { [AGENTS]: `# Rules\n\n${mineBlock}\n` };
      const files = applied(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));
      files.set(AGENTS, move(ourBlock(files, AGENTS)));

      const second = planInit({ ...BASE, files });

      // ⚠어느 «가드»가 막는지는 모양에 따라 다르다(설명되지 않는 마커 / 짝이 안 맞는 마커).
      //   검사하는 것은 안내문의 출처가 아니라 뜻이다: 이 파일을 건드리지 않았고 백업이 살아 있다.
      expect(second.notes.join(" ")).toContain(AGENTS);
      expect(second.writes.find((write) => write.path === AGENTS)).toBeUndefined();
      // ★사용자 원본 블록의 백업이 살아 있어야 한다. 1차 수정은 여기서 버렸다.
      expect(second.record?.files[AGENTS]?.original).toEqual({ at: "text", text: mineBlock });

      // 그리고 되돌리기도 완료로 처리하지 않는다.
      const undo = planUndo({ files: applied(files, second) });
      expect(undo.notes.join(" ")).toContain("cannot account for");
      expect(undo.deletes).not.toContain(RECORD_FILE);
    });
  }

  it("★B2 예제 자리를 «편집한» 우리 블록으로 채워도 완료가 아니다", () => {
    const example = "# Rules\n\n```md\n"
      + `${MARKER_BEGIN}\nEXAMPLE ONLY\n${MARKER_END}` + "\n```\n";
    const before = { [AGENTS]: example };
    const files = applied(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));
    const edited = ourBlock(files, AGENTS).replace("## AI-ERD Harness", "## EDITED AI-ERD Harness");
    const moved = new Map(files);
    moved.set(AGENTS, `# Rules\n\n\`\`\`md\n${edited}\n\`\`\`\n`);

    const undo = planUndo({ files: moved });

    expect(undo.notes.join(" ")).toContain("cannot account for");
    expect(undo.deletes).not.toContain(RECORD_FILE);
  });

  it("★B2 정상 블록 옆에 «편집한 사본»이 한 벌 더 있으면 완료가 아니다", () => {
    const files = applied(snapshot({ [AGENTS]: "# Rules\n" }),
      planInit({ ...BASE, files: snapshot({ [AGENTS]: "# Rules\n" }) }));
    const edited = ourBlock(files, AGENTS).replace("## AI-ERD Harness", "## EDITED AI-ERD Harness");
    const both = new Map(files);
    both.set(AGENTS, `${files.get(AGENTS)}\n\`\`\`md\n${edited}\n\`\`\`\n`);

    const undo = planUndo({ files: both });

    expect(undo.notes.join(" ")).toContain("cannot account for");
    expect(undo.deletes).not.toContain(RECORD_FILE);
  });

  // ───────────────────────── N1 (내가 만든 회귀) ─────────────────────────

  it("★N1 init 전부터 있던 «동일 내용» 예제는 정상 되돌리기를 막지 않는다", () => {
    // ★1차 수정이 만든 회귀. 모양으로 우리 블록을 알아보려 했더니, 원래 예제가 우리 것과 같으면
    //   그것을 「우리 블록이 남았다」로 읽고 수동 삭제를 요구했다 — 파일을 고친 적도 없는데.
    //   기록해 둔 증거로 판정하면 「그 예제는 init 전에도 있었다」가 보인다.
    const beforeInit = applied(snapshot({}), planInit({ ...BASE, files: snapshot({}) }));
    const sameExample = `# Rules\n\n\`\`\`md\n${ourBlock(beforeInit, AGENTS)}\n\`\`\`\n`;

    const files = applied(snapshot({ [AGENTS]: sameExample }),
      planInit({ ...BASE, files: snapshot({ [AGENTS]: sameExample }) }));
    const undone = applied(files, planUndo({ files }));

    // 우리 블록은 걷어냈고, 예제는 그대로 있고, 의무는 끝났다.
    expect(undone.get(AGENTS)).toBe(sameExample);
    expect(recordOf(undone)).toBeUndefined();
  });
});

/**
 * ★<b>9차 3차 리뷰 — 증거 자체의 구멍.</b> 2차에서 「모양으로 우리 블록을 알아보기」를 버리고
 * 「init 전의 증거로 설명하기」로 옮겼는데, 3차가 그 <b>증거 수집</b>을 세 군데서 뚫었다:
 *
 * <ol>
 *   <li>짝 없는 마커를 한 문자열로 뭉쳐서, 「원래 있던 «닫는» 예제」와 「우리 블록에 남은 «여는»
 *       마커」가 서로 상쇄됐다 — 증거가 맞는 것처럼 보이고 백업이 사라졌다.</li>
 *   <li>마커를 변형·삭제하면 우리 블록이 «검출되지 않는다». 그것을 「블록이 없다」로 읽고
 *       계약을 버렸다 — ★검출 실패는 백업을 버릴 근거가 아니다.</li>
 *   <li>가드를 「정상 위치에 블록이 없을 때만」 돌렸다. 그 블록을 고치고 사본을 옆에 두면
 *       가드를 건너뛰고, 게다가 «우리 사본»을 「원래 있던 예제」로 새로 등록했다.</li>
 * </ol>
 * 그리고 증거를 우리 블록 «안»까지 훑은 탓에, 여는 마커만 적어 둔 예제가 우리 블록의 닫는
 * 마커와 한 쌍으로 묶여 정상 되돌리기를 막았다(N2). ⇒ 증거는 <b>우리 블록을 빼고</b> 본다.
 */
describe("9차 3차 리뷰 — 증거를 우리 블록 밖에서 센다", () => {
  const AGENTS = "AGENTS.md";
  const CONFIG = ".ai-erd/config.json";
  const json = (body: unknown) => `${JSON.stringify(body, null, 2)}\n`;
  const USER_BLOCK = `${MARKER_BEGIN}\nORIGINAL USER BLOCK\n${MARKER_END}`;

  function ourBlock(files: Map<string, string | undefined>): string {
    const written = recordOf(files)!.files[AGENTS]!.written;
    if (written.at !== "text") throw new Error("block contract must hold its text");
    return written.text;
  }

  /** 사용자 블록 A 가 있는 파일에 init 을 한 번 돌린 상태. */
  function afterFirstInit(extra = "") {
    const before = { [AGENTS]: `# Rules\n\n${USER_BLOCK}\n${extra}` };
    return applied(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));
  }

  it("★B2 짝 없는 마커의 «종류»가 다르면 상쇄되지 않는다", () => {
    // 3차 반례: init 전 펜스에 «닫는» 마커만 있는 예제 + 사용자 블록 A.
    // init 뒤 우리 블록을 펜스로 옮기고 그 «닫는» 마커와 옛 예제를 지우면, 예전 코드는
    // 「(짝 없는 마커) 하나 ↔ 하나」로 상쇄해 설명된 것으로 받고 A 의 백업을 absent 로 바꿨다.
    const files = afterFirstInit(`\n\`\`\`md\n${MARKER_END}\n\`\`\`\n`);
    expect(recordOf(files)!.files[AGENTS]!.foreignBlocks).toEqual(["(unpaired ai-erd end)"]);
    const moved = ourBlock(files).replace(`\n${MARKER_END}`, "");
    files.set(AGENTS, `# Rules\n\n\`\`\`md\n${moved}\n\`\`\`\n`);

    const second = planInit({ ...BASE, files });

    expect(second.writes.find((write) => write.path === AGENTS)).toBeUndefined();
    expect(second.record?.files[AGENTS]?.original).toEqual({ at: "text", text: USER_BLOCK });
  });

  const mangled: Array<[string, (block: string) => string]> = [
    ["양쪽에 공백", (b) => b.replace("ai-erd:begin", "ai-erd: begin").replace("ai-erd:end", "ai-erd: end")],
    ["양쪽 대문자", (b) => b.replace("ai-erd:begin", "AI-ERD:BEGIN").replace("ai-erd:end", "AI-ERD:END")],
    ["마커를 줄로 쪼갬", (b) => b.replace("<!-- ai-erd:begin -->", "<!--\nai-erd:begin\n-->")],
    ["양쪽 마커 삭제", (b) => b.replace(`${MARKER_BEGIN}\n`, "").replace(`\n${MARKER_END}`, "")],
  ];

  for (const [label, mangle] of mangled) {
    it(`★B2 우리 블록의 마커를 «${label}»으로 바꿔도 사용자 원본을 버리지 않는다`, () => {
      // ★검출 실패는 「블록이 없다」가 아니다. 예전 코드는 증거가 비니 계약을 버렸고,
      //   그 뒤 undo 가 새 블록만 걷어내고 기록을 지워 A 를 영구히 잃었다.
      const files = afterFirstInit();
      files.set(AGENTS, `# Rules\n\n\`\`\`md\n${mangle(ourBlock(files))}\n\`\`\`\n`);

      const second = planInit({ ...BASE, files });

      expect(second.record?.files[AGENTS]?.original).toEqual({ at: "text", text: USER_BLOCK });

      // ★지켜야 할 불변식은 「A 가 즉시 돌아온다」가 아니라 <b>「A 를 잃지 않는다」</b>다.
      //   설명되지 않는 마커가 파일에 남아 있으면 되돌리기는 사람에게 넘긴다 — 그때도 백업은
      //   기록에 살아 있어야 하고, 그래야 사람이 치운 뒤 다시 실행해 A 를 되살릴 수 있다.
      const afterSecond = applied(files, second);
      const undone = applied(afterSecond, planUndo({ files: afterSecond }));
      const restored = (undone.get(AGENTS) ?? "").includes("ORIGINAL USER BLOCK");
      const stillHeld = recordOf(undone)?.files[AGENTS]?.original;
      expect(restored || stillHeld?.at === "text", label).toBe(true);
      if (!restored) {
        expect(stillHeld).toEqual({ at: "text", text: USER_BLOCK });
      }
    });
  }

  it("★B2 정상 블록을 고치고 사본을 옆에 두면, 그 사본을 «원래 예제»로 받아들이지 않는다", () => {
    // 3차 반례 중 가장 나쁜 것: 가드가 「정상 위치에 블록이 없을 때만」 돌아 건너뛰고,
    // priorOf 가 계약을 버린 뒤 증거를 «다시 모아» 우리 사본을 남의 예제로 등록했다.
    // ⇒ 그다음 undo 가 사본을 남긴 채 기록을 지웠다. 2차 트리는 같은 입력에서 기록을 지켰다.
    const files = afterFirstInit();
    const block = ourBlock(files);
    files.set(AGENTS, `${files.get(AGENTS)!.replace("## AI-ERD Harness", "## EDITED AI-ERD Harness")}`
      + `\n\`\`\`md\n${block}\n\`\`\`\n`);

    const second = planInit({ ...BASE, files });

    expect(second.writes.find((write) => write.path === AGENTS)).toBeUndefined();
    expect(second.record?.files[AGENTS]?.foreignBlocks).toEqual([]);
    expect(second.record?.files[AGENTS]?.original).toEqual({ at: "text", text: USER_BLOCK });

    const undo = planUndo({ files: applied(files, second) });
    expect(undo.deletes).not.toContain(RECORD_FILE);
  });

  // ───────────────────── N2 (내가 만든 두 번째 회귀) ─────────────────────

  const looseExamples: Array<[string, string]> = [
    ["여는 마커만", `\`\`\`md\n${MARKER_BEGIN}\n\`\`\`\n`],
    ["닫는 뒤에 여는", `\`\`\`md\n${MARKER_END}\n\`\`\`\n\n\`\`\`md\n${MARKER_BEGIN}\n\`\`\`\n`],
  ];

  for (const [label, example] of looseExamples) {
    it(`★N2 «${label}»만 적어 둔 기존 예제가 정상 되돌리기를 막지 않는다`, () => {
      // ★init 이 «자기가 쓴 블록» 때문에 남의 증거를 새로 만들어 내던 자리다:
      //   예제의 여는 마커가 우리 블록의 닫는 마커와 한 쌍으로 묶였다. 우리 블록을 빼고 세면 없다.
      const before = { [AGENTS]: `# Rules\n\n${example}` };
      const files = applied(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));

      const undone = applied(files, planUndo({ files }));

      expect(undone.get(AGENTS)).toBe(before[AGENTS]); // 예제는 그대로
      expect(recordOf(undone)).toBeUndefined();        // 의무는 끝났다
    });
  }

  it("★우리 블록을 더하거나 걷어내도 «남의 증거»는 변하지 않는다 (불변식)", () => {
    // 3차가 요구한 불변식. 이것이 깨지면 init 이 스스로 남의 증거를 만들어 낸다는 뜻이다.
    for (const example of [
      `\`\`\`md\n${MARKER_BEGIN}\n\`\`\`\n`,
      `\`\`\`md\n${MARKER_END}\n\`\`\`\n`,
      `\`\`\`md\n${MARKER_BEGIN}\nEXAMPLE\n${MARKER_END}\n\`\`\`\n`,
      "",
    ]) {
      const before = `# Rules\n\n${example}`;
      const files = applied(snapshot({ [AGENTS]: before }),
        planInit({ ...BASE, files: snapshot({ [AGENTS]: before }) }));
      const withOurs = files.get(AGENTS)!;
      const undone = applied(files, planUndo({ files })).get(AGENTS)!;

      expect(markerEvidence(withOurs), example).toEqual(markerEvidence(before));
      expect(markerEvidence(undone), example).toEqual(markerEvidence(before));
    }
  });

  // ───────────────────── F1 ─────────────────────

  it("★F1 재init 도 fields 계약의 완전성을 본다 — 검증 전 기록으로 파일을 고치지 않는다", () => {
    // 3차 반례: 두 map 에서 endpoint 를 함께 지운 기록을 undo 는 거절했지만 재init 은 그대로
    // 실행해 «현재 endpoint»를 새 원본으로 적었다. 그러면 다음 undo 가 사용자 원본이 아니라
    // 우리가 쓴 값을 복원한다.
    const before = { [CONFIG]: json({ endpoint: "https://mine.example/mcp" }) };
    const files = applied(snapshot(before), planInit({ ...BASE, files: snapshot(before) }));
    const raw = JSON.parse(files.get(RECORD_FILE)!) as { files: Record<string, Record<string, unknown>> };
    delete (raw.files[CONFIG]!.writtenFields as Record<string, unknown>).endpoint;
    delete (raw.files[CONFIG]!.originalFields as Record<string, unknown>).endpoint;
    files.set(RECORD_FILE, `${JSON.stringify(raw, null, 2)}\n`);

    const second = planInit({ ...BASE, files, endpoint: "https://other.example/mcp" });

    expect(second.refusal).toContain("does not record what it put there");
    expect(second.writes).toHaveLength(0);
  });
});

/**
 * ★<b>구판이 다른 자리에 남긴 기록.</b> 7차에 기록을 우리 파일로 내보내면서, 구판이
 * {@code .ai-erd/config.json} 의 {@code managed} 칸에 남긴 기록을 «없는 것»으로 안내하게 됐다
 * (9차 1차 리뷰 B6) — 그 config 안에 사용자 원본 백업이 그대로 들어 있는데도.
 * 사용자는 「되돌릴 것이 없구나」로 읽고 그 백업을 영영 쓰지 않는다.
 *
 * <p>⚠그리고 이 판정은 <b>7차 I2 와 맞부딪힌다</b> — 「config 의 managed 는 사용자 것이다」.
 * 모양만으로는 둘이 구별되지 않아서, 구판이 «함께 쓴 것»으로 가른다:
 * {@code generatedBy}(우리 CLI 만 적는 칸) 또는 {@code managed.lastWritten} 안의 config 자기 경로.
 */
describe("9차 B6 — 구판 기록은 «없는 기록»이 아니다", () => {
  const CONFIG = ".ai-erd/config.json";
  const json = (body: unknown) => `${JSON.stringify(body, null, 2)}\n`;

  /** 구판(6차 이전) CLI 가 실제로 쓴 모양: 우리 칸 + managed 가 한 파일에 있다. */
  const legacyConfig = json({
    version: 1,
    project: { uuid: "p-1", name: "Billing" },
    endpoint: "https://ai-erd.com/mcp",
    generatedBy: "@ai-erd/mcp 0.2.0",
    promptVersions: {},
    managed: {
      created: [".mcp.json"],
      originals: { "AGENTS.md": "USER ORIGINAL BLOCK" },
      lastWritten: { [CONFIG]: "sha-of-config" },
    },
  });

  it("★undo 가 「이전 init 기록이 없다」고 말하지 않는다 — 그 안에 백업이 있다", () => {
    const undo = planUndo({ files: snapshot({ [CONFIG]: legacyConfig }) });

    const notes = undo.notes.join(" ");
    expect(notes).not.toContain("No record of a previous init");
    expect(notes).toContain("an older version of this CLI");
    expect(notes).toContain("--undo");          // 무엇을 하라는지 말한다
    expect(undo.writes).toEqual([]);            // ⛔그리고 아무것도 건드리지 않는다
    expect(undo.deletes).toEqual([]);
  });

  it("★init 은 구판 기록 위에 쓰지 않는다 — 이행할 수 없는 백업을 죽은 글로 만들지 않는다", () => {
    const plan = planInit({ ...BASE, files: snapshot({ [CONFIG]: legacyConfig }) });

    expect(plan.refusal).toContain("an older version of this CLI");
    expect(plan.writes).toEqual([]);
  });

  it("★사용자가 적은 managed 칸은 그대로 사용자 것이다 (7차 I2 유지)", () => {
    // 구판이 «함께 쓴 것»이 없다 — generatedBy 도, lastWritten 안의 config 경로도 없다.
    const mine = json({ managed: { created: ["AGENTS.md"], lastWritten: { "AGENTS.md": "x" } } });

    expect(planUndo({ files: snapshot({ [CONFIG]: mine }) }).notes.join(" "))
      .toContain("No record of a previous init");
    // init 도 막히지 않고, 그 칸을 건드리지도 않는다.
    const plan = planInit({ ...BASE, files: snapshot({ [CONFIG]: mine }) });
    expect(plan.refusal).toBeUndefined();
    expect(JSON.parse(writtenAt(plan, CONFIG)!).managed)
      .toEqual({ created: ["AGENTS.md"], lastWritten: { "AGENTS.md": "x" } });
  });
});
