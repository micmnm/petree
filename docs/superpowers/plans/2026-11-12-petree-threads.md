# Petree Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn petree tasks into threads that move investigate → spec → build with two user gates, comments folded into the next turn, per-repo notes, agent-skills in the sandbox, and a Local folder panel.

**Architecture:** A thread is the existing `tasks` row plus `stage` and `comments` columns. The launcher finalizes investigate/spec turns into `waiting-for-you`; `/next` with a `stage` is the only way forward. New `src/notes.ts` owns the `_thread/` and `~/.petree/notes/` file operations; the dashboard renders it.

**Tech Stack:** Node 22, TypeScript (ESM), Express 5, better-sqlite3, vitest, plain HTML/JS dashboard, Docker.

**Spec:** `docs/superpowers/specs/2026-11-12-petree-threads-design.md`

## Global Constraints

- Node 22 (`nvm use`); run tests with `npx vitest run --exclude '.claude/**'` (the `.claude/worktrees` copy has its own tests).
- No new npm dependencies.
- Code keeps the name `task`; UI text says "thread".
- Stages, exactly: `'investigate' | 'spec' | 'build'`, order in that sequence.
- Thread scratch dir inside the sandbox: `/work/_thread/` (`spec.md`, `findings.md`, `notes/<repo>/<topic>.md`); on host `~/.petree/work/<id>/_thread/`.
- Notes on host: `~/.petree/notes/<repo>/INDEX.md` + `<topic>.md`; mounted `/petree/notes:ro`.
- Topic slugs match `^[a-z0-9-]+$`; repo names must be in the thread's `repos`.
- Skills mount: `~/.petree/shared/skills` → `/home/dev/.claude/skills:ro`.
- Combined image name: `sandbox-full`; mixing allowed only among `sandbox-node`, `sandbox-dotnet`.
- Thread title = first line (max 72 chars) of `turns[0].prompt ?? prompt`.
- Comments heading, exact: `## Comments from the user since the last turn`.
- Push stays manual; never add automatic push.
- Commits: one line, no AI/model names, no trailers (user rule).

## Review Focus

1. A comment posted while a turn is running must not change that turn's stored prompt and must appear in the next one — pinned in Task 1.
2. `/next` with an empty prompt, no pending comments and an unchanged stage → 400; with a stage advance → accepted — pinned in Task 5.
3. Notes accept with `topic: "../x"`, a repo outside the thread, or a multi-line summary → 400 / summary collapsed to one line in `INDEX.md` — pinned in Task 4.
4. A reattached (post-restart) investigate turn finishes in `waiting-for-you`, not `done` — pinned in Task 3.
5. A DB created before this change (no `stage`/`comments` columns) loads rows as `stage: 'build'`, `comments: []` and they behave exactly as before — pinned in Task 1.

## Parallelism

- Wave 1, in parallel: **Task 1** and **Task 4** (Task 4 uses no store types).
- Wave 2, in parallel after Task 1: **Task 2** and **Task 3** (disjoint files).
- Wave 3: **Task 5** after Tasks 1, 3, 4.
- Wave 4: **Task 6**, then **Task 7** (same file, sequential).

---

### Task 1: Store — stage, comments, gate transitions

**Files:**
- Modify: `src/store.ts`
- Modify (TaskRecord literals gain `stage: 'build', comments: []`): `test/sandbox.test.ts`, `test/prompt.test.ts`, any other test building a `TaskRecord` literal (`grep -rn "logOffset: 0" test/`)
- Modify (moved here from Task 3 so parallel tasks never share files): `src/config.ts` — `RepoConfig.run: string[]` parsed with `toList(value.run)`; every `RepoConfig` literal in `test/` gains `run: []` (`grep -rn "skills: \[\]" test/`)
- Test: `test/store.test.ts`, `test/config.test.ts` (`run: pnpm dev` → `['pnpm dev']`; absent → `[]`)

**Interfaces:**
- Produces:
  - `export type Stage = 'investigate' | 'spec' | 'build'`; `export const STAGES: Stage[]`
  - `export interface Comment { text: string; at: string; consumed: boolean }`
  - `Turn` gains `stage: Stage` (archived turns without it read as `'build'`)
  - `TaskRecord` gains `stage: Stage`, `comments: Comment[]`
  - `create(input & { stage?: Stage })` (default `'investigate'`)
  - `addComment(id: string, text: string): TaskRecord` — any state, no transition
  - `canMoveStage(state: TaskState, from: Stage, to: Stage): boolean` (exported function)
  - `followUp(id, prompt, model?, stage?: Stage): TaskRecord` — throws on illegal stage move
  - `export function threadTitle(t: TaskRecord): string`
  - `FOLLOWUP_STATES` = `['done','failed','cancelled','waiting-for-you']`; `RESUMABLE_STATES` without `'waiting-for-you'`
  - `TRANSITIONS['waiting-for-you']` = `['queued','failed','cancelled']`

- [ ] **Step 1: Write failing tests in `test/store.test.ts`** (new `describe('threads')`):
  - `create` without stage → `stage === 'investigate'`, `comments` `[]`.
  - migration: open a DB file created with the *old* `CREATE TABLE` (copy the pre-change SQL from git: `CREATE TABLE tasks (... model TEXT)` and insert one row) → `get()` returns `stage: 'build'`, `comments: []`.
  - `addComment` on a `running` task keeps `state === 'running'` and `prompt` unchanged; comment has `consumed: false`.
  - `followUp(id, 'more', undefined, 'spec')` from `waiting-for-you` at `investigate` with two pending comments → `prompt` equals `'more\n\n## Comments from the user since the last turn\n\n- c1\n- c2'`, both comments `consumed: true`, `stage === 'spec'`, last turn has `stage: 'investigate'`.
  - `followUp(id, '', undefined, 'build')` from `waiting-for-you` at `investigate` with no comments → `prompt === ''`, stage `build`.
  - comment added after `followUp` → stays `consumed: false` and is not in `prompt`.
  - `canMoveStage`: `('waiting-for-you','investigate','build')` true; `('waiting-for-you','spec','investigate')` false; `('done','build','spec')` true; `('done','spec','build')` false; same stage always true.
  - `followUp` with an illegal move throws `/illegal stage move/`.
  - `transition(id,'cancelled')` from `waiting-for-you` works; `RESUMABLE_STATES` excludes `'waiting-for-you'`.
  - `threadTitle` returns first line of `turns[0].prompt` when turns exist, else of `prompt`, cut to 72 chars.

- [ ] **Step 2: Run** `npx vitest run test/store.test.ts` — Expected: new tests FAIL (missing exports/fields).

- [ ] **Step 3: Implement in `src/store.ts`**: `ALTER TABLE` adds `stage TEXT NOT NULL DEFAULT 'build'` and `comments TEXT` (so old rows read `build`); `create` writes the given/default stage explicitly. `followUp` does the comment snapshot + consume + stage set in one `this.db.transaction`. Comment text in the bullet list is used verbatim (single `- ` prefix per comment; multi-line comments keep their newlines).

- [ ] **Step 4: Update TaskRecord literals in tests** (`stage: 'build', comments: []`) so `npm run typecheck` passes.

- [ ] **Step 5: Run** `npx vitest run --exclude '.claude/**'` and `npm run typecheck` — Expected: all PASS.

- [ ] **Step 6: Commit** `git commit -m "Add thread stage, comments and gate transitions to the task store"`

---

### Task 2: Prompt — stage instructions, notes, suggestions

**Files:**
- Modify: `src/prompt.ts`
- Test: `test/prompt.test.ts`

**Interfaces:**
- Consumes: `Stage`, `TaskRecord.stage` (Task 1)
- Produces: `composePrompt(task, cfg): string` (same signature), `export const STAGE_INSTRUCTIONS: Record<Stage, string>`

- [ ] **Step 1: Write failing tests**:
  - replace `'returns the prompt untouched when nothing is configured'` with: output starts with `'fix the bug'`, then contains `'## Stage: build'` and `STAGE_INSTRUCTIONS.build`.
  - investigate output contains `/work/_thread/findings.md` and "do not modify"; spec output contains `spec-driven-development` and `/work/_thread/spec.md`; build output contains `planning-and-task-breakdown`, `in parallel`, `test-driven-development`.
  - output contains `/petree/notes/demo/INDEX.md` and `/work/demo/CLAUDE.md` for each repo in `task.repos`.
  - output contains `/work/_thread/notes/demo/` (suggestion instruction).
  - with conventions configured, the `## Repo conventions` block is still present and still after the stage block.
  - empty `prompt` (approve) → output starts with `'## Stage: '`.

- [ ] **Step 2: Run** `npx vitest run test/prompt.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**: section order = stored prompt (omitted if empty) → `## Stage: <stage>` + `STAGE_INSTRUCTIONS[stage]` → `## Repo notes` (per repo: read `/petree/notes/<repo>/INDEX.md` if present, open notes only when relevant; read `/work/<repo>/CLAUDE.md` if present) → `## Suggesting notes` (write non-obvious learnings as short files in `/work/_thread/notes/<repo>/<topic>.md`, lowercase-hyphen topic names, nothing else there) → existing conventions block unchanged. Stage text per spec §5.3 (build text includes the parallel-subagent breakdown verbatim in spirit; no interactive questions in any stage — list open questions instead).

- [ ] **Step 4: Run** `npx vitest run test/prompt.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "Compose stage instructions, repo notes and note suggestions into the prompt"`

---

### Task 3: Sandbox, image, workspace, launcher finalization

**Files:**
- Modify: `src/sandbox.ts`, `src/launcher.ts`, `src/git.ts`, `src/index.ts`, `scripts/build-images.sh`, `README.md` (`RepoConfig.run` already exists from Task 1)
- Create: `images/full.Dockerfile`
- Test: `test/sandbox.test.ts`, `test/launcher.test.ts`, `test/git.test.ts`, `test/restart.test.ts` (reattach case)

**Interfaces:**
- Consumes: `Stage`, `threadTitle` (Task 1)
- Produces:
  - `export function pickImage(repos: string[], cfg: PetreeConfig): string` — throws `Error` naming repos+images on an unsupported mix
  - `buildSandboxCommands` uses `pickImage`; mounts skills at `/home/dev/.claude/skills:ro`, notes at `/petree/notes:ro`; no findings mount

- [ ] **Step 1: Write failing tests**:
  - sandbox: create cmd contains `/petree-home/shared/skills:/home/dev/.claude/skills:ro` and `/petree-home/notes:/petree/notes:ro`, not `/petree/findings`.
  - `pickImage(['a','b'])` with both `sandbox-node` → `'sandbox-node'`; node + dotnet → `'sandbox-full'`; node + `sandbox-python` → throws `/sandbox-python/`.
  - git: after `prepareWorkspace`, `git rev-list --count HEAD` in the clone equals the fixture repo's commit count with a fixture of 2 commits (proves no `--depth 1`).
  - launcher: a task with `stage: 'investigate'` and fake scenario `ok` ends `waiting-for-you` with `result` set; `stage: 'build'` ends `done`.
  - launcher: commit message on the branch equals `petree <id>: <threadTitle>` after a `followUp` with an empty prompt.
  - launcher: investigate turn that leaves repo changes → task `error` contains `investigate turn changed files in demo`. The fakes never touch the work dir, so the test calls `prepareWorkspace(cfg, ['demo'], join(home,'work',task.id), task.id)` itself, writes `x.txt` into the clone, then launches with scenario `ok` (`prepareWorkspace` skips existing clones).
  - restart/reattach: an investigate task reattached via `launch.reattach` ends `waiting-for-you`.

- [ ] **Step 2: Run** the listed test files — Expected: FAIL.

- [ ] **Step 3: Implement**:
  - `launcher.ts` `runTurn`: on `done` event → `setResult`, then `transition(id, task.stage === 'build' ? 'done' : 'waiting-for-you')`; commit message uses `threadTitle(store.get(id))`; when `stage !== 'build'` and `commitChanges` returned true, append `"<stage> turn changed files in <repo>"` to `error` the same way commit errors are appended.
  - `git.ts`: drop `'--depth', '1'`.
  - `index.ts`: dirs `['logs','work','shared/skills','notes']` (drop `shared/findings`).
  - `images/full.Dockerfile`: dotnet SDK 8 base + Node 22 + `@anthropic-ai/claude-code` + `dev` user, mirroring `dotnet.Dockerfile`; add its `docker build ... -t sandbox-full` line to `scripts/build-images.sh`.
  - `README.md`: setup step "copy skills into `~/.petree/shared/skills/` (`cp -R ~/.claude/plugins/cache/addy-agent-skills/agent-skills/<version>/skills/* ~/.petree/shared/skills/`) — copy, not symlink"; document `run:` and `~/.petree/notes/`.

- [ ] **Step 4: Run** `npx vitest run --exclude '.claude/**'` and `npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Manual skills check (spec §7)** — only if `docker images sandbox-node` exists and `~/.petree/token` exists; otherwise report "skipped: no docker image/token" and continue:
  `docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN=<token from file> -v ~/.petree/shared/skills:/home/dev/.claude/skills:ro sandbox-node claude -p "List the skills you have available by name. Reply with names only."`
  Expected: output names at least `spec-driven-development`. If not, STOP and report — spec §5.4 needs revisiting.

- [ ] **Step 6: Commit** `git commit -m "Mount skills and notes in the sandbox, pick a combined image, end gated stages in waiting-for-you"`

---

### Task 4: Notes and thread files module

**Files:**
- Create: `src/notes.ts`
- Test: `test/notes.test.ts`

**Interfaces:**
- Produces:
  - `export interface Suggestion { repo: string; topic: string; text: string; exists: boolean }` — `exists` = a note with that topic is already in `<notesHome>/<repo>/`
  - `readThreadFile(workDir: string, name: 'spec.md' | 'findings.md'): string | null`
  - `listSuggestions(notesHome: string, workDir: string, repos: string[]): Suggestion[]` — only `*.md` files directly under `_thread/notes/<repo>/` for repos in the list, topic = filename without `.md`, skip non-slug names
  - `acceptNote(notesHome: string, workDir: string, s: { repo: string; topic: string; text: string; summary: string }, repos: string[]): void` — writes `<notesHome>/<repo>/<topic>.md`, replaces or appends the `- [<topic>](<topic>.md) — <summary>` line in `INDEX.md`, deletes the suggestion file
  - `dropSuggestion(workDir: string, repo: string, topic: string, repos: string[]): void`
  - Both throw `NoteInputError` (exported class) on bad repo/topic

- [ ] **Step 1: Write failing tests** (temp dirs):
  - `readThreadFile` returns content / `null` when missing.
  - `listSuggestions` finds `_thread/notes/demo/run-locally.md` with `exists: false`, and `exists: true` once `notes/demo/run-locally.md` exists; ignores `Bad Name.md`, nested dirs, and repos not in the list.
  - `acceptNote` creates `notes/demo/run-locally.md` and `INDEX.md` line `- [run-locally](run-locally.md) — needs postgres`; accepting the same topic again replaces that line (one line total); suggestion file removed.
  - summary `"a\nb"` → index line ends `— a b`.
  - `topic: '../x'` → throws `NoteInputError`; `repo: 'other'` not in repos → throws; nothing written.
  - `dropSuggestion` removes the file; bad topic throws.

- [ ] **Step 2: Run** `npx vitest run test/notes.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** with `node:fs` sync calls; validate before any path join.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "Add thread file and note suggestion helpers"`

---

### Task 5: API routes

**Files:**
- Modify: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: Task 1 store API, `pickImage` + `RepoConfig.run` (Task 3), Task 4 module
- Produces (used by the dashboard):
  - `POST /api/tasks` body `{ prompt, repos, model?, stage? }` → 400 on unknown stage or `pickImage` error
  - `POST /api/tasks/:id/comments` `{ text }` → 201 updated task; 400 empty text; 404
  - `POST /api/tasks/:id/next` `{ prompt?, model?, stage? }` → 400 when prompt empty AND no pending comments AND stage unchanged/absent; 400 on illegal stage move; 409 on non-follow-up state
  - `POST /api/tasks/:id/stop` from `waiting-for-you` → `cancelled`
  - `GET /api/tasks/:id/thread` → `{ spec: string|null, findings: string|null, suggestions: Suggestion[] }`
  - `POST /api/tasks/:id/notes/accept` `{ repo, topic, text, summary }` → 200 `{ ok: true }`; `NoteInputError` → 400
  - `POST /api/tasks/:id/notes/drop` `{ repo, topic }` → same codes
  - `GET /api/tasks/:id/diff` entries gain `folder` (absolute repo dir) and `run: string[]`
  - `/pr` title `petree <id>: <threadTitle>`, body = first prompt (`turns[0]?.prompt ?? prompt`)
  - `GET /api/repos` entries gain `run`

- [ ] **Step 1: Write failing tests** for each bullet above, including Review Focus 2 (empty prompt + no comments + same stage → 400; empty prompt + `stage: 'spec'` from a `waiting-for-you` investigate task → 200 and state `queued`). Put a task into `waiting-for-you` via `store.transition` (`queued→provisioning→running→waiting-for-you`).

- [ ] **Step 2: Run** `npx vitest run test/server.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**; validate `:id` with the existing `/^[0-9a-f-]{8,36}$/` check on the new routes; notes home = `join(cfg.home, 'notes')`, workDir = `join(cfg.home, 'work', id)`.

- [ ] **Step 4: Run** `npx vitest run --exclude '.claude/**'` and `npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "Add thread API: stages, comments, gate drop, thread files and note review"`

---

### Task 6: Dashboard — thread list, create stage, gates, comments

**Files:**
- Modify: `src/dashboard.html`

**Interfaces:**
- Consumes: Task 5 routes; task JSON fields `stage`, `comments`, `turns[].stage`, state `waiting-for-you`

- [ ] **Step 1: Implement**:
  - UI text "task" → "thread" where user-visible.
  - List: stage badge; `waiting-for-you` rows first (then existing order); header shows `needs you: N` and `document.title` becomes `(N) petree` when N > 0.
  - Create form: stage select (investigate default, spec, build) sent as `stage`.
  - Remove `'waiting-for-you'` from the resume-button state list (`dashboard.html:370`).
  - Overview: stage + state, turn history shows each turn's stage, comments list (pending marked "will be included") + comment box posting to `/comments` (enabled in every state).
  - When `waiting-for-you`: buttons *Approve → spec* and *Approve → build* (investigate), *Approve → build* (spec), *Continue this stage*, *Drop*; one optional textarea shared by them. All rendering of user/agent text goes through the existing escape-first helpers.

- [ ] **Step 2: Verify in a browser**: `PETREE_HOME=<tmp with a repos.yaml for one local file:// repo> PORT=4199 npx tsx src/index.ts`; create a thread at `investigate`; set it to `waiting-for-you` via `node -e` + `TaskStore`, or by letting a run finish if docker is available; check: badge, sorting, `needs you: 1`, tab title, comment appears, Approve → spec moves it to queued with stage `spec`, Drop → cancelled. Use the Playwright MCP tools if available; record what was checked.

- [ ] **Step 3: Run** `npx vitest run --exclude '.claude/**'` — Expected: PASS (no regressions).

- [ ] **Step 4: Commit** `git commit -m "Show threads with stages, needs-you count, gate actions and comments in the dashboard"`

---

### Task 7: Dashboard — spec/findings, note review, Local panel

**Files:**
- Modify: `src/dashboard.html`

**Interfaces:**
- Consumes: `GET /thread`, `POST /notes/accept|drop`, `/diff` `folder` + `run`

- [ ] **Step 1: Implement**:
  - Tabs **Spec** and **Findings** shown only when content exists, rendered with the existing `renderMarkdown`.
  - **Notes** tab: one card per suggestion — repo, editable topic, editable one-line summary, editable text, *Accept* / *Drop*; when the suggestion has `exists: true`, *Accept* first asks `confirm('Replace the existing note <topic>?')`.
  - Result area: per repo a **Local** block — folder path with the existing copy button, branch, `run:` commands (each with copy) — beside Push / Create PR.
  - A turn that produced the "changed files" warning shows the existing error line; no extra UI.

- [ ] **Step 2: Verify in a browser** as in Task 6: create files under `<PETREE_HOME>/work/<id>/_thread/` (`spec.md`, `findings.md`, `notes/demo/run-locally.md`) and a clone at `work/<id>/demo`; check Spec/Findings render, accept writes `<PETREE_HOME>/notes/demo/run-locally.md` + `INDEX.md`, drop removes the suggestion, Local shows the path and copy works.

- [ ] **Step 3: Run** `npx vitest run --exclude '.claude/**'` — Expected: PASS.

- [ ] **Step 4: Commit** `git commit -m "Show thread spec, findings, note review and local folder in the dashboard"`
