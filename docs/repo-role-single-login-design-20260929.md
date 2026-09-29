# 0.4.2 설계 — 저장소 역할 하나, 로그인은 기계당 한 번 (2026-09-29)

> 상태: 설계 → 리뷰(조건부 GO, P0 2건) → 사용자 결정 반영 → 구현.
> 사용자 결정(2026-09-29): **«마이그레이션은 고려하지 마.»** 옛 버전(0.4.1 이하 역할 토큰·떠 있는 옛 세션) 호환을 버린다. 리뷰의 P1·P2 는 전부 반영한다(§10).
> 기준: `@ai-erd/mcp`·`ai-erd`·`@ai-erd/cli` 0.4.1, ainecto-api `dev` `ffca54b8`, 레지스트리 dev(`HARNESS.DOC` r4 · `HARNESS.INSTRUCTIONS` r3 · `HARNESS.AGENT_NOTE` r2).
> 앞선 설계: `interactive-init-design-20260929.md`(0.4.0/0.4.1). 이 문서는 그 위에 얹는 변경분이다.
> 표기: **[확인]** 이번에 코드·실측으로 확인, **[추정]** 확인하지 않음.

---

## 0. 결정

- 역할은 **작업 가드레일**이다(Q1, 0.4.0). **로그인은 기계·서버마다 한 번**(역할 없는 토큰)만 받는다.
- 역할을 **저장하는 곳은 하나**다. init 이 저장소에 쓴 `.mcp.json`·`.cursor/mcp.json` 의 `ai-erd` 항목의 `--role`.
  - 그 저장소 안에서 부르는 셸 CLI(`ai-erd tools call …` 등)는 `--role` 없이 이 값을 헤더(`X-AI-ERD-Role`)로 싣는다.
  - MCP 브리지는 지금처럼 `--role` 인자로 받는다.
- `--role`·`AI_ERD_ROLE` 이 저장소 역할과 **다르면 거절**한다. 역할을 바꾸는 길은 `init --role` 하나(사용자에게 묻고 실행)다.
- **저장소 밖**은 역할 없음 = 제한 없음(현행).
- **옛 역할 토큰 칸은 무시한다.** 읽지도, 지우지도 않는다.

---

## 1. 서버 — 헤더 역할은 지금도 «적용»된다

**[확인] 헤더 경로는 무시되지 않는다. 요청마다 끝까지 적용된다. «권고»는 «헤더를 빼면 우회된다»는 뜻이다.**

| 단계 | 코드 | 헤더 역할일 때 |
|---|---|---|
| 역할 결정 | `McpController.handle` → `McpSessionRoleResolver.resolve(header, caller)` | 토큰에 역할 scope 가 없으면 `fromConfiguredValue(header)`. 모르는 값은 400 `INVALID_SESSION_ROLE`, 헤더가 없으면 `FULL` |
| 도구 목록 | `toolsListResult(role)` → `rolePolicy.allows` | 그 역할 밖의 도구가 빠진다 |
| 도구 호출 | `rolePolicy.allows` 거부 → `roleDenied`, `rolePolicy.argumentProblem` | 거절·인자 판정까지 |
| 안내문 | `instructionsFor(role, tokenBound=false, …)` | 역할 토큰과 같은 글(`ROLE_INSTRUCTIONS`+`COMMON`+`<ROLE>`) |

- ⇒ **강제 로직은 변경 없음.**
- **서버 변경은 한 곳이다**: `McpProtocolHandler.instructionsFor` 의 헤더 경로 binding 문장(352-358)을 **빈 문자열**로 한다(리뷰 P2 — 새 문장보다 작다).
  - 지금 문장은 「run `ai-erd auth login --role <role>` to have the server enforce it」으로, 에이전트에게 역할별 로그인을 시킨다.
  - 비우면 `ROLE_INSTRUCTIONS` 본문(「This session is an AI-ERD X Session …」)만 남는다. 토큰 경로 문장은 그대로 둔다.
- 서버 주석: `McpSessionRoleResolver` 36-50(헤더는 «권고») → «헤더 역할도 요청마다 전부 적용된다. 헤더를 빼면 우회되므로 가드레일이다»로 정정. 61행 오류 문구 `ai-erd auth login --role …` → `ai-erd auth login`.

---

## 2. CLI

### 2-1. 저장소 역할 찾기 — 한 모듈 (리뷰 P1-a·P2)

- 새 모듈 `src/core/harness/repositoryRole.ts` — ★**역할 판정의 SSOT**.
  - `rolesInFiles(files)` — 파일 스냅샷에서 `ai-erd` 항목의 역할과 «읽기 문제»를 돌려준다. init 의 `currentRole`·`repositoryRoles` 도 이것을 쓴다.
  - `findRepositoryRole(cwd)` — 명령용.
  - `findGitRoot`, 경계 검사 읽기(`readManagedFile`·`assertInsideRepository`)도 여기로 옮긴다. init 과 명령이 같은 읽기 문을 지난다.
- 탐색: **cwd 에서 위로, `ai-erd` 항목이 든 `.mcp.json`·`.cursor/mcp.json` 이 있는 첫 폴더**(리뷰 P1-a). git 과 무관하다.
  - ★**홈 폴더 자체는 보지 않는다**(구현 중 발견, 2026-09-29 — 설계에 없던 결정이라 보고함). `~/.cursor/mcp.json` 은 Cursor 의 «전역» 설정이다. 이 기계에서 실측: 사람의 `~/.cursor/mcp.json` 에 역할 없는 `ai-erd` 항목(HTTP 연결)이 있었고, 홈을 탐색하자 홈 아래 모든 폴더의 명령이 «역할을 못 읽음»으로 멈췄다.
  - 중첩 저장소는 가까운 쪽이 이기고, git 아닌 하위 폴더와 worktree 도 같은 규칙이다.
  - 그런 폴더가 없으면 «역할 없음».
- **읽기 문제는 멈춘다(conflict)** — 리뷰 P2:
  - `ai-erd` 항목이 있는데 `--role` 이 없거나 모르는 값
  - 파일이 JSON 이 아님
  - 파일이 그 폴더 밖을 가리키는 링크
  - 두 설정의 역할이 다름
- init 은 지금 규칙 그대로다(git 루트에서만, 하위 폴더 거절). 역할 추론만 같은 `rolesInFiles` 를 쓴다.

### 2-2. 명령의 역할 결정 (`ainectoCli`, mcp·init·auth 분기 «뒤», 한 곳)

| 저장소 역할 | `--role`/`AI_ERD_ROLE` | 결과 |
|---|---|---|
| R | 없음 / R | **R**(헤더) |
| R | S≠R | **거절**, 원격 0: `This repository's AI sessions have the role R (set in <file>). --role S does not match — the role changes only with \`ai-erd init --role <role>\`, after asking the user.` |
| conflict | 무엇이든 | 거절: 이유 + 「Ask the user which role …, then run \`ai-erd init --role <role>\` in <dir>.」 |
| 없음 | 없음 | 역할 없음(제한 없음) |
| 없음 | S | S |

- `mcp`(브리지): 역할은 `--role`/`AI_ERD_ROLE` 만 쓴다(저장소를 적용하지 않는다). (§2-6 의 경고는 코드 리뷰 P1-2 로 삭제 — §11.)
- `init`: 자기 규칙.
- `auth login|status|logout`: 역할과 무관하다. `--role` 을 주면 `Sign-in is one per machine; --role is not used by auth.` 한 줄을 쓰고 진행한다. 저장소를 읽지 않는다 — 깨진 저장소 안에서도 로그인·로그아웃이 된다.
- 시험 셋(리뷰 P2): 설정이 어긋난 저장소 안에서 `auth status`·`mcp`·`init --role X` 이 저장소 역할 판정에 막히지 않는다.

### 2-3. 헤더 — 강제 진입점 하나, 빠뜨림은 타입이 잡는다

- 헤더는 `McpRpcClient.postJson` 한 곳에서 싣는다 [확인]. 모든 MCP 요청이 지난다.
- `McpRpcClientOptions.role` 을 **필수 `HarnessRole | null`** 로 바꾼다(리뷰 P2). 클라이언트를 만드는 모든 곳이 «역할을 정했는지»를 타입 앞에서 밝혀야 한다.

### 2-4. 토큰 칸 — (endpoint, 역할 없음) 한 칸

- `OAuthClient`·`TokenStore` 에서 역할을 없앤다. 칸은 `tokenKey(endpoint)` 하나다(0.4.1 의 역할 없는 칸과 같은 키). 인가 `scope` 는 `mcp` 만 쓴다.
- **옛 역할 칸은 무시한다** — 읽지도 지우지도 않는다(사용자 결정: 마이그레이션 고려 안 함). `auth logout` 도 역할 없는 칸만 지운다.
  - 근거(더 작은 쪽): 옛 칸은 어떤 경로도 읽지 않으므로 지워도 동작이 달라지지 않는다. 지우려면 역할 목록으로 키를 다시 계산하는 코드가 는다.
- ★**가드(리뷰 P0-1 의 남는 부분)**: `FileTokenStore.save` 는 `scope` 에 `ai-erd:role:` 이 든 토큰을 **거절**한다.
  - 호환 읽기가 없으므로 역할 토큰이 이 칸에 들어올 경로는 없다. 하지만 그런 토큰이 들어오면 모든 저장소에서 토큰 역할이 헤더를 이긴다(역할 뒤바뀜). 저장 경계에서 막고 시험으로 고정한다.
- 리뷰 P0-2(로그인 뒤 옛 칸 자동 정리가 떠 있는 옛 세션을 죽인다): 정리 자체를 하지 않으므로 해당 없음.
- `tokenStore.ts` 의 「역할마다 토큰을 따로 둔다」 주석은 폐기한다.
- `auth status`(리뷰 P2): 한 칸의 로그인 여부만 말한다(호환 칸이 없으므로 모호함이 없다).

### 2-5. init 과 로그인 안내

- 로그인은 역할 없는 칸이 비었을 때만 한다. 성공 줄 `Signed in.`
- `loginCommand` 는 `ai-erd auth login`(+`--env`/`--endpoint`)이다. 「each role signs in once」 문장을 지운다.
- `--json` 의 `login_url` 이벤트는 `{"event":"login_url","url":…}` — **`role` 필드를 뺀다**(리뷰 P2). 로그인이 역할과 무관해졌다. 사람용 줄은 `Opening your browser to sign in to AI-ERD. If it does not open, visit: <url>`.
- 동의 화면에서 역할(`ai-erd:role:…`)이 사라진다. 잃는 것: 사람이 브라우저에서 «어느 역할인지» 보는 기회. 대화에서 고른 값이 대신한다.

### 2-6. 역할 없는 브리지 경고 (리뷰 P1-b) — ⛔코드 리뷰 P1-2 로 삭제(§11). 아래는 기록.

- 0.4.1 에서는 역할 없는 칸이 비어 있으면 역할 없는 브리지가 401 로 막혔다. 0.4.2 는 칸이 하나라 **조용히 제한 없음**으로 붙는다. README 의 「역할 없는 브리지는 거절된다」 뜻도 뒤집힌다.
- `runConnector` 는 역할이 없을 때 cwd 에서 `findRepositoryRole` 을 본다. 저장소 역할 R 이 있으면 stderr 에 한 줄을 쓴다:
  `ai-erd: this MCP connection has no role, but <dir> sets the role R for AI sessions. Another "ai-erd" entry may be hiding .mcp.json (Claude Code: \`claude mcp get ai-erd\`).`
- 역할을 적용하지는 않는다 — 경고만.

---

## 3. 옛 버전에서 올릴 때

- 사용자 결정으로 호환을 고려하지 않는다. 0.4.2 는 역할 없는 칸만 본다.
  - 역할 토큰만 있던 기계는 한 번 `ai-erd auth login` 하거나 `init` 을 치면(로그인 포함) 된다.
- 배포 순서: **api → CLI → 레지스트리**(리뷰 P2).

---

## 4. 문구 목록 (이름·뜻 두 번 찾기 + 리뷰 누락분)

| 곳 | 위치 | 처리 |
|---|---|---|
| api | `McpProtocolHandler.instructionsFor` 352-358 | 헤더 경로 binding = 빈 문자열 |
| api | `McpSessionRoleResolver.java` 20·36-50·61 | 주석·오류 문구 |
| 레지스트리 | `HARNESS.DOC` r4 12행 「once signed in for that role, from the access token itself」, 64행 「It signs in for that role if needed」 | r5 |
| 레지스트리 | `HARNESS.AGENT_NOTE` r2 「and from the access token when you signed in with a role」 | r3 |
| 레지스트리 | `HARNESS.INSTRUCTIONS` r3 「If the user is not signed in for that role, it opens a browser」 | r4 |
| CLI | `initCommand.ts` 307(dry-run 안내 「No usable sign-in for this role」)·531-533·553 | §2-5 |
| CLI | `ainectoCli.ts` 56-57(login_url role), help `auth login --role` | §2-5 |
| CLI | `connector.ts` 18-20(「브리지도 역할별 토큰」 주석) | §2-4 |
| CLI | `harnessDoc.ts` 181-182(패키지 기본 AGENT_NOTE 「and from the access token when you signed in with a role」) | AGENT_NOTE r3 과 같은 문구 |
| CLI | `tokenStore.ts` 86, `oauth.ts` scope 주석, `role.ts` 머리 주석 | 주석 |
| README | 55·57·81·85-91·94·122-130·140·154·171-172 | 한 번 로그인·저장소 역할·거절 규칙·브리지 경고 |
| 도움말 en | `docs/cli.mdx` 55-62·84-86·127-128·134-143·157-158·180·202 | 루트가 다른 워커에게 |
| 도움말 ko | `i18n/ko/…/cli.mdx` 51-57·77·123-126·131·144·166·188 | 루트가 다른 워커에게 |
| 홈페이지 | `LinearHomepage.tsx` 627 「signs you in through the browser if needed」 | 그대로(참) |
| 앱 | `mcpContent.tsx` 341 `ai-erd auth login` | 그대로 |
| api 리소스 | `HARNESS.DOC.en-US.md`·`HARNESS.AGENT_NOTE.en-US.md` | ⛔그대로 — 적용된 V198·V199 의 입력 |

---

## 5. 왜 이보다 작게는 안 되는가 / 무엇을 계속 지키는가

**작게 못 하는 이유**
- 로그인이 한 번이면 역할은 요청마다 와야 한다. 서버가 이미 받는 자리가 헤더다.
- 셸 CLI 가 «자동으로» 역할을 얻을 곳은 저장소뿐이다. init 이 이미 쓰는 그 파일이다.
- binding 문장은 코드 문자열이라 레지스트리로 못 고친다.

**계속 지키는 것**
- 떠 있는 세션의 역할 불변(브리지 인자 고정).
- 역할은 사람이 고르고, 바꾸는 길은 `init --role` 하나.
- 서버의 역할 적용 코드 불변.
- 저장소 밖은 제한 없음(현행).
- 역할의 저장 위치 하나(MCP 항목).
- 헤더 진입점 하나(`postJson`).

---

## 6. 보안

| # | 항목 | 등급 | 처리 |
|---|---|---|---|
| R1 | 서버가 서명한 역할이 사라진다(헤더만) — 같은 토큰으로 헤더를 빼면 제한 없음 | P1 (Q1 로 수용) | 가드레일로 명시 |
| R2 | 저장소 밖 `cd` 한 줄로 제한 없음(0.4.1 의 «역할 없는 토큰 없음 = 브라우저 관문»이 사라짐) | P1 (결정 방향의 결과) | 수용. 브리지는 P1-b 경고로 가림을 드러낸다 |
| R3 | 동의 화면에서 역할이 사라짐 | P2 | 대화의 선택이 대신 |
| R4 | 저장 토큰이 역할마다에서 한 개로 준다 | 개선 | — |
| R6 | 역할 없는 칸에 역할 scope 토큰이 들어가면 모든 저장소에서 역할이 뒤바뀐다 | P0 → **가드로 막음** | `FileTokenStore.save` 거절 + 시험 |
| R7 | 저장소 안에서 헤더를 빠뜨리면 조용히 FULL | P0 → **타입·시험으로 막음** | `role` 필수 타입 + 「저장소 안, `--role` 없음 → 헤더 = 저장소 역할」 시험 |
| R8 | Codex 프로필 역할 ≠ 저장소 역할이면 브리지는 프로필 역할 | P2 | 사용자의 명시 선택. 문서 한 줄 |

---

## 7. 합격 시나리오

| 단계 | 0.4.2 |
|---|---|
| 1. "ai-erd cli 설치해줘" → 에이전트가 `ai-erd` 를 찾는다 | `ai-erd`·`@ai-erd/cli` 가 있다 — 통과 |
| 2. 역할 묻기 | README·안내문 — 통과 |
| 3. `init --role`(비TTY) | 통과 |
| 4. 로그인은 처음 한 번만 | 역할 없는 칸이 비었을 때만 — **통과** |
| 5. 새 세션에서 역할 적용 | `.mcp.json --role R` → 헤더 R — 통과 |
| 6. 셸 CLI 도 저장소 역할 | `--role` 없이 헤더 R, `--role S≠R` 은 거절 — **통과** |

---

## 8. 바뀌는 곳

- **CLI**
  - `core/harness/repositoryRole.ts`(신규)
  - `ainectoCli.ts`(§2-2, help, login_url)
  - `oauth.ts`·`tokenStore.ts`(§2-4)
  - `rpcClient.ts`(role 필수)
  - `connector.ts`·`bin/mcp.ts`(토큰 한 칸·역할 헤더)
  - `initCommand.ts`(§2-5, 모듈 이동)
  - `harnessDoc.ts`(AGENT_NOTE 기본값)
  - `role.ts`, README, scripts(sync-tools·smoke-mcp: `role: null`)
  - 시험
- **api**: binding 빈 문자열, 주석·문구.
- **레지스트리**: `HARNESS.DOC` r5, `HARNESS.AGENT_NOTE` r3, `HARNESS.INSTRUCTIONS` r4. 각각 가드 SQL.

---

## 9. 결정된 질문

- 옛 역할 토큰 호환 읽기: **두지 않는다**(사용자 결정 「마이그레이션은 고려하지 마」). 앞 판의 «둔다»(루트 결정)를 대체한다.

---

## 10. 리뷰 반영 (사용자 결정: P1·P2 전부 반영)

| 지적 | 반영 |
|---|---|
| P0-1 옛 칸 토큰의 갱신이 역할 없는 칸에 들어감 | 호환 읽기 삭제로 경로 없음. 저장 가드 유지(§2-4) |
| P0-2 로그인 뒤 자동 정리가 옛 세션을 죽임 | 정리 없음(§2-4) |
| P1-a 탐색은 «ai-erd 항목이 있는 첫 폴더» | §2-1 |
| P1-b 역할 없는 브리지가 조용히 제한 없음 | 경고 한 줄(§2-6) |
| P1-c «자동으로 0.4.2» 는 추정 | 문구 삭제(§3) |
| P2 읽기 실패는 conflict | §2-1 |
| P2 저장소 역할 판정은 분기 뒤 + 시험 셋 | §2-2 |
| P2 `role` 필수 타입 | §2-3 |
| P2 `auth status` | §2-4 |
| P2 `login_url` 의 role 필드 | 뺌(§2-5) |
| P2 SSOT 모듈화 | §2-1 |
| P2 binding 빈 문자열 | §1 |
| P2 문구 누락분 | §4 |
| P2 배포 순서 | §3 |

---

## 11. 0.4.2 코드 리뷰(GO, P0 없음) 반영 — 사용자 결정: 추천대로

| 지적 | 반영 |
|---|---|
| P1-1 홈 제외가 문자열 비교라 `/var` ↔ `/private/var` 처럼 링크로 갈라진 같은 폴더를 못 알아봄 | 양쪽을 실제 경로(realpath, 실패 시 resolve)로 비교, Windows 는 대소문자 무시. 시험은 macOS tmpdir 로 재현했고, 고치기 전 코드에서 실패함을 확인했다 |
| P1-2 역할 없는 브리지 경고(§2-6)는 보이지 않는 장치(stderr 는 호스트 디버그 로그로만 감) | **삭제.** 가림 진단은 README 한 줄(`claude mcp get ai-erd`)과 서버 안내문(`HARNESS.INSTRUCTIONS`)이 맡는다 |
| P1-3 «읽기 문제는 멈춤» 범위가 넓음 | 폴더 «안»을 가리키는 링크는 읽는다. `ai-erd` 항목이 우리 브리지(`@ai-erd/mcp`·`ai-erd`·`ai-erd-mcp`·`--role`)가 아니면(url·mcp-remote) 역할 없음. 깨진 JSON 은 원문에 `ai-erd` 가 있을 때만 멈춘다. 우리 브리지인데 `--role` 이 없거나 모르는 값이면 멈춘다(그대로) |
| P2 잘못된 `AI_ERD_ROLE` 이 auth 를 막음 | auth 는 명시 역할을 읽지 않는다 |
| P2 원격을 안 부르는 명령도 역할 판정을 지남 | `tools catalog`·모르는 명령은 판정 «전»에 끝난다(`--help` 는 원래 맨 앞) |
| P2 시험 보강 | R 저장소에서 `init --role S` 성공(종료 0·파일 역할 S), 어긋난 저장소의 init 을 성공으로 증명, cwd 를 안 옮기던 CLI 시험 셋을 임시 폴더로 격리 |
| P2 역할 읽기 중복(`initPlan.previousRole` vs `rolesInFiles`) | `readConfigRole` 한 곳 |
| P2 멈춤 안내가 막다른 길 | 그 폴더가 git 저장소의 하위 폴더면 «init 으로 고치라» 대신 «사용자에게 그 설정을 어떻게 둘지 물어라 — init 은 저장소 루트에서만 돈다» |
| 그대로 둠(사용자 결정) | logout 뒤 옛 역할 칸, AINECTO_TOKEN 가드, connect(null) 타입 한계 |
