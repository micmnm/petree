# Petree Next-Turn (Follow-up Prompt) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume a finished task from the dashboard with a follow-up prompt — same task id, work dir, `petree/<id>` branch, and (via persisted session state) the same Claude conversation.

**Architecture:** A per-task host dir `<home>/sessions/<taskId>` is mounted at `/home/dev/.claude` in every container run so `--resume <sessionId>` survives container destruction (`--resume` is only passed when the transcript file exists on the host). The store gains a `turns` history column, a `done → queued` transition, and a `followUp()` method that archives the previous prompt/result and resets the per-turn budget. `prepareWorkspace` becomes idempotent so requeued tasks reuse their existing clones. A new `POST /api/tasks/:id/next` endpoint queues the follow-up; the dashboard grows a "Next prompt" form and collapsed turn history. Spec: `docs/superpowers/specs/2026-08-03-petree-next-turn-design.md`.

**Tech Stack:** Node ≥ 22, TypeScript strict ESM, express, better-sqlite3, vitest. No new dependencies.

## Global Constraints

- No new dependencies. Node ≥ 22 (`nvm use` before npm/npx — better-sqlite3 breaks on newer Node).
- TypeScript strict ESM; relative imports end in `.js`.
- SQLite migrations are additive `ALTER TABLE ... ADD COLUMN` guarded by `PRAGMA table_info`, matching the existing `result`/`model` migrations.
- All git operations run on the HOST via `execFile`/`execFileSync('git', [...])` — array args, never a shell string, never credentials in the sandbox.
- NEVER push to a repo's base branch; tests use local fixture repos only (no real remotes, no real docker, no real claude).
- Dashboard safe sinks unchanged: task fields via `esc()`/`textContent`; only `result` (and turn results) via escape-first `renderMarkdown`.
- Commit messages use `feat:|fix:|chore:|docs:` prefixes.

## File Structure

```
src/
  store.ts       # + turns column, Turn type, done→queued, followUp()
  git.ts         # prepareWorkspace skips repos already cloned (idempotent)
  sandbox.ts     # + sessions mount; --resume gated on host transcript existence
  launcher.ts    # + creates <home>/sessions/<taskId> before the run
  server.ts      # + POST /api/tasks/:id/next
  dashboard.html # + Next-prompt form on terminal tasks, turn history, typing-guard in refresh
test/
  store.test.ts / git.test.ts / sandbox.test.ts / server.test.ts / launcher.test.ts extended
```

---

### Task 1: Store — turn history, done→queued, followUp()

**Files:**
- Modify: `src/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Produces: `interface Turn { prompt: string; result: string | null; tokensUsed: number; endedAt: string }`; `TaskRecord.turns: Turn[]` (default `[]`); `followUp(id: string, prompt: string, model?: string | null): TaskRecord` — valid only from `done`/`failed`/`cancelled`; archives current `{prompt, result, tokensUsed, endedAt}` onto `turns`, sets the new prompt (and `model` when the arg is not `undefined`), resets `tokensUsed` to 0 and `result` to null, transitions to `queued`, keeps `sessionId` and `error`. State machine gains `done: ['queued']`.

- [ ] **Step 1: Write the failing tests**

Append to `test/store.test.ts` (top-level, after the existing `describe` blocks):

```ts
describe('TaskStore follow-up turns', () => {
  function finish(s: TaskStore, id: string): void {
    s.transition(id, 'provisioning')
    s.transition(id, 'running')
    s.patch(id, { sessionId: 'sess-7' })
    s.addUsage(id, 120)
    s.setResult(id, 'first conclusions')
    s.transition(id, 'done')
  }

  it('archives the turn and requeues with a fresh budget on followUp', () => {
    const t = store.create(input)
    finish(store, t.id)
    const next = store.followUp(t.id, 'now implement it')
    expect(next.state).toBe('queued')
    expect(next.prompt).toBe('now implement it')
    expect(next.tokensUsed).toBe(0)
    expect(next.result).toBeNull()
    expect(next.sessionId).toBe('sess-7')
    expect(next.turns).toHaveLength(1)
    expect(next.turns[0].prompt).toBe('do it')
    expect(next.turns[0].result).toBe('first conclusions')
    expect(next.turns[0].tokensUsed).toBe(120)
    expect(next.turns[0].endedAt).toBeTruthy()
  })

  it('keeps the model unless a new one is passed', () => {
    const a = store.create({ ...input, model: 'haiku' })
    finish(store, a.id)
    expect(store.followUp(a.id, 'more').model).toBe('haiku')
    const b = store.create({ ...input, model: 'haiku' })
    finish(store, b.id)
    expect(store.followUp(b.id, 'more', 'sonnet').model).toBe('sonnet')
    const c = store.create({ ...input, model: 'haiku' })
    finish(store, c.id)
    expect(store.followUp(c.id, 'more', null).model).toBeNull()
  })

  it('works from failed and cancelled, rejects from running', () => {
    const f = store.create(input)
    store.transition(f.id, 'provisioning')
    store.transition(f.id, 'running')
    store.transition(f.id, 'failed', { error: 'boom' })
    expect(store.followUp(f.id, 'try again').state).toBe('queued')

    const r = store.create(input)
    store.transition(r.id, 'provisioning')
    store.transition(r.id, 'running')
    expect(() => store.followUp(r.id, 'nope')).toThrow(/cannot follow up/)
  })

  it('accumulates multiple turns in order', () => {
    const t = store.create(input)
    finish(store, t.id)
    store.followUp(t.id, 'second')
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.setResult(t.id, 'second result')
    store.transition(t.id, 'done')
    const third = store.followUp(t.id, 'third')
    expect(third.turns.map((x) => x.prompt)).toEqual(['do it', 'second'])
  })

  it('migrates a pre-turns db (no turns column) to turns: []', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'petree-mig-')), 'db')
    const raw = new Database(file)
    raw.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, repos TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'unattended', state TEXT NOT NULL,
      session_id TEXT, tokens_used INTEGER NOT NULL DEFAULT 0,
      token_budget INTEGER NOT NULL, timeout_minutes INTEGER NOT NULL,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result TEXT, model TEXT)`)
    raw.prepare(`INSERT INTO tasks (id,prompt,repos,mode,state,token_budget,timeout_minutes,created_at,updated_at)
      VALUES ('old1','p','["demo"]','unattended','done',1000,30,'t','t')`).run()
    raw.close()
    const s = new TaskStore(file)
    expect(s.get('old1')?.turns).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/store.test.ts`
Expected: FAIL — `followUp is not a function`, `turns` undefined.

- [ ] **Step 3: Implement in `src/store.ts`**

Add the `Turn` type and extend `TaskRecord`:

```ts
export interface Turn {
  prompt: string
  result: string | null
  tokensUsed: number
  endedAt: string
}
```

In `TaskRecord`, after `model: string | null`, add:

```ts
  turns: Turn[]
```

In `TRANSITIONS`, change `done: []` to:

```ts
  done: ['queued'],
```

In `rowToTask`, after `model: r.model ?? null,` add:

```ts
    turns: JSON.parse(r.turns ?? '[]'),
```

In the constructor, after the `model` migration line, add:

```ts
    if (!cols.includes('turns')) this.db.exec('ALTER TABLE tasks ADD COLUMN turns TEXT')
```

Add the method (after `setResult`):

```ts
  // Archive the finished turn and requeue the task with a follow-up prompt.
  // sessionId is kept — it is what lets the next run resume the conversation.
  followUp(id: string, prompt: string, model?: string | null): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    if (!['done', 'failed', 'cancelled'].includes(t.state)) {
      throw new Error(`cannot follow up from state ${t.state}`)
    }
    const turns: Turn[] = [
      ...t.turns,
      { prompt: t.prompt, result: t.result, tokensUsed: t.tokensUsed, endedAt: new Date().toISOString() },
    ]
    this.db.prepare(`UPDATE tasks SET prompt = ?, model = ?, tokens_used = 0, result = NULL,
      turns = ?, state = 'queued', updated_at = ? WHERE id = ?`)
      .run(prompt, model !== undefined ? model : t.model, JSON.stringify(turns), new Date().toISOString(), id)
    return this.get(id)!
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/store.test.ts && npm run typecheck`
Expected: all pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store.test.ts
git commit -m "feat: turn history, done->queued, and followUp() in the task store"
```

---

### Task 2: Idempotent prepareWorkspace

**Files:**
- Modify: `src/git.ts`
- Test: `test/git.test.ts`

**Interfaces:**
- Consumes: existing `prepareWorkspace(cfg, repoNames, workDir, taskId)`.
- Produces: same signature; repos whose dir `join(workDir, name)` already exists are skipped (no clone, no branch creation), preserving the existing `petree/<taskId>` branch and its commits. Fixes the requeue re-clone failure for every resume path.

- [ ] **Step 1: Write the failing test**

Append inside the `describe('prepareWorkspace', ...)` block in `test/git.test.ts`:

```ts
  it('skips repos already cloned, preserving branch and commits (requeue)', async () => {
    const fixture = makeFixtureRepo()
    const workDir = join(mkdtempSync(join(tmpdir(), 'petree-work-')), 'w')
    const cfg = cfgWith(`file://${fixture}`)
    await prepareWorkspace(cfg, ['demo'], workDir, 'abc123')
    // simulate a first turn: a commit lands on the task branch
    writeFileSync(join(workDir, 'demo', 'turn1.txt'), 'x\n')
    execFileSync('git', ['-C', join(workDir, 'demo'), 'add', '-A'])
    execFileSync('git', ['-C', join(workDir, 'demo'), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'turn 1'])
    // requeue: must not re-clone or reset anything
    await prepareWorkspace(cfg, ['demo'], workDir, 'abc123')
    const branch = execFileSync('git', ['-C', join(workDir, 'demo'), 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(branch).toBe('petree/abc123')
    const msg = execFileSync('git', ['-C', join(workDir, 'demo'), 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim()
    expect(msg).toBe('turn 1')
    expect(existsSync(join(workDir, 'demo', 'turn1.txt'))).toBe(true)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use && npx vitest run test/git.test.ts`
Expected: FAIL — the second `prepareWorkspace` throws (git clone into an existing non-empty directory).

- [ ] **Step 3: Implement in `src/git.ts`**

Add `existsSync` to the fs import:

```ts
import { existsSync, mkdirSync } from 'node:fs'
```

In the clone loop, guard each repo:

```ts
  for (const name of repoNames) {
    // Requeued tasks (follow-up turns, resume after pause/failure) already have
    // their clone on the petree/<taskId> branch with prior commits — reuse it.
    if (existsSync(join(workDir, name))) continue
    const repo = cfg.repos[name]
    await execFileAsync(
      'git',
      ['clone', '--depth', '1', '--branch', repo.defaultBranch, repo.url, join(workDir, name)],
    )
    createTaskBranch(join(workDir, name), taskId)
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/git.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/git.ts test/git.test.ts
git commit -m "fix: prepareWorkspace reuses existing clones on requeue"
```

---

### Task 3: Sandbox sessions mount + gated --resume; launcher creates the sessions dir

**Files:**
- Modify: `src/sandbox.ts`, `src/launcher.ts`
- Test: `test/sandbox.test.ts`, `test/launcher.test.ts`

**Interfaces:**
- Consumes: `buildDockerCommand(task, cfg, workDir, oauthToken)` (unchanged signature), `cfg.home`.
- Produces: the docker command always mounts `join(cfg.home, 'sessions', task.id)` at `/home/dev/.claude`; `--resume <sessionId>` is appended only when `join(cfg.home, 'sessions', task.id, 'projects', '-work', `${task.sessionId}.jsonl`)` exists on the host. The launcher creates `join(cfg.home, 'sessions', task.id)` (recursive) before building the command.

- [ ] **Step 1: Update/write the failing tests**

In `test/sandbox.test.ts`, the existing `--resume` test assumed blind trust in `sessionId`; it becomes two tests gated on the transcript file. Add `mkdirSync` to the fs import. Replace the test `'adds --resume when the task has a session id'` with:

```ts
  it('mounts the per-task session dir at /home/dev/.claude', () => {
    const cmd = buildDockerCommand(task, cfg, '/tmp/work/abc123', 'tok-1')
    expect(cmd.join(' ')).toContain('/petree-home/sessions/abc123:/home/dev/.claude')
  })

  it('adds --resume only when the session transcript exists on the host', () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-sess-'))
    const cfgReal = { ...cfg, home }
    // transcript missing: fresh session instead of a crashing --resume
    const without = buildDockerCommand({ ...task, sessionId: 'sess-9' }, cfgReal, '/w', 't')
    expect(without).not.toContain('--resume')
    // transcript present (as written by a previous containerized run): resume
    mkdirSync(join(home, 'sessions', task.id, 'projects', '-work'), { recursive: true })
    writeFileSync(join(home, 'sessions', task.id, 'projects', '-work', 'sess-9.jsonl'), '{}\n')
    const withResume = buildDockerCommand({ ...task, sessionId: 'sess-9' }, cfgReal, '/w', 't')
    expect(withResume.join(' ')).toContain('--resume sess-9')
  })
```

In `test/launcher.test.ts`, add to the first test (`'runs a task end to end: ...'`), after the existing log-file assertion:

```ts
    expect(existsSync(join(home, 'sessions', task.id))).toBe(true)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/sandbox.test.ts test/launcher.test.ts`
Expected: FAIL — no sessions mount, `--resume` currently unconditional, sessions dir never created.

- [ ] **Step 3: Implement**

`src/sandbox.ts` — in `buildDockerCommand`, add the mount after the findings mount:

```ts
    '-v', `${join(cfg.home, 'sessions', task.id)}:/home/dev/.claude`,
```

Replace the final `if (task.sessionId) cmd.push(...)` with:

```ts
  // Resume only when the transcript from a previous run actually exists on the
  // host (cwd inside the container is always /work, so the project key is
  // stable). A stale sessionId with no transcript must start a fresh session,
  // not crash the run.
  const transcript = task.sessionId
    ? join(cfg.home, 'sessions', task.id, 'projects', '-work', `${task.sessionId}.jsonl`)
    : null
  if (task.sessionId && transcript && existsSync(transcript)) cmd.push('--resume', task.sessionId)
```

`src/launcher.ts` — in `launch`, next to the logs `mkdirSync`, add:

```ts
    mkdirSync(join(cfg.home, 'sessions', task.id), { recursive: true })
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/sandbox.test.ts test/launcher.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox.ts src/launcher.ts test/sandbox.test.ts test/launcher.test.ts
git commit -m "feat: persist per-task claude session dir; gate --resume on host transcript"
```

---

### Task 4: Server — POST /api/tasks/:id/next

**Files:**
- Modify: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `store.followUp(id, prompt, model?)` (Task 1), `resolveModel`, `MODELS`, `scheduler.tick()`.
- Produces: `POST /api/tasks/:id/next` body `{ prompt, model? }` → 200 updated task (state `queued`); 404 unknown id; 400 missing/empty prompt or unknown model; 409 when state is not `done`/`failed`/`cancelled`. When `model` is omitted the task keeps its model; when given it is resolved like task creation.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('API', ...)` block in `test/server.test.ts`:

```ts
  it('queues a follow-up turn on a done task via /next', async () => {
    const t = store.create({ prompt: 'investigate', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.setResult(t.id, 'findings')
    store.transition(t.id, 'done')
    const res = await fetch(`${base}/api/tasks/${t.id}/next`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'now implement it', model: 'haiku' }),
    })
    expect(res.status).toBe(200)
    const task = await res.json()
    expect(task.state).toBe('queued')
    expect(task.prompt).toBe('now implement it')
    expect(task.model).toBe('haiku')
    expect(task.turns).toHaveLength(1)
    expect(task.turns[0].prompt).toBe('investigate')
    expect(task.turns[0].result).toBe('findings')
  })

  it('rejects /next with a missing prompt, unknown model, wrong state, or unknown id', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.transition(t.id, 'done')
    const noPrompt = await fetch(`${base}/api/tasks/${t.id}/next`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })
    expect(noPrompt.status).toBe(400)
    const badModel = await fetch(`${base}/api/tasks/${t.id}/next`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', model: 'gpt-4' }),
    })
    expect(badModel.status).toBe(400)

    const running = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    store.transition(running.id, 'provisioning')
    store.transition(running.id, 'running')
    const wrongState = await fetch(`${base}/api/tasks/${running.id}/next`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }),
    })
    expect(wrongState.status).toBe(409)

    const missing = await fetch(`${base}/api/tasks/zzzzzzzz/next`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }),
    })
    expect(missing.status).toBe(404)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/server.test.ts`
Expected: FAIL — route 404s.

- [ ] **Step 3: Implement in `src/server.ts`**

Add the route after the `/resume` route:

```ts
  app.post('/api/tasks/:id/next', (req, res) => {
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    const { prompt, model } = (req.body ?? {}) as { prompt?: string; model?: string }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'prompt is required' })
      return
    }
    if (model !== undefined && !MODELS.includes(model)) {
      res.status(400).json({ error: `unknown model: ${model}` })
      return
    }
    if (!['done', 'failed', 'cancelled'].includes(t.state)) {
      res.status(409).json({ error: `cannot follow up from state ${t.state}` })
      return
    }
    // Omitted model keeps the task's current one; a given model resolves the
    // same way task creation does ('default' -> config defaults).
    const effectiveModel = model !== undefined
      ? resolveModel(model, cfg.repos[t.repos[0]].defaultModel, cfg.defaults.defaultModel)
      : undefined
    res.json(store.followUp(t.id, prompt, effectiveModel))
    void scheduler.tick()
  })
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: POST /api/tasks/:id/next queues a follow-up turn"
```

---

### Task 5: Launcher two-turn integration test

**Files:**
- Test: `test/launcher.test.ts` (test only — Tasks 1–3 already provide the behavior)

**Interfaces:**
- Consumes: `store.followUp` (Task 1), idempotent `prepareWorkspace` (Task 2), launcher commit finalize (existing).

- [ ] **Step 1: Write the test**

Append inside the `describe('makeLauncher', ...)` block:

```ts
  it('runs a follow-up turn in the same workspace, stacking commits on the task branch', async () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-home-'))
    mkdirSync(join(home, 'logs'), { recursive: true })
    const cfg: PetreeConfig = {
      home,
      defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null },
      repos: { demo: { url: `file://${makeFixtureRepo()}`, defaultBranch: 'main', image: 'sandbox-node', setup: [], test: [], skills: [], defaultModel: null } },
      allowClone: [],
    }
    const store = new TaskStore(join(home, 'petree.db'))
    const created = store.create({ prompt: 'investigate', repos: ['demo'], tokenBudget: 500000, timeoutMinutes: 30 })
    const writer = (file: string) => [process.execPath, '-e',
      `const fs=require('fs');fs.writeFileSync(process.env.WD+'/demo/${file}','x');` +
      `console.log(JSON.stringify({type:'result',subtype:'success',result:'done ${file}'}))`]
    let file = 'turn1.txt'
    const launch = makeLauncher(cfg, store, { buildCommand: (t, workDir) => { process.env.WD = workDir; return writer(file) } })

    await launch(store.transition(created.id, 'provisioning'))
    expect(store.get(created.id)?.state).toBe('done')

    const followed = store.followUp(created.id, 'implement it')
    expect(followed.state).toBe('queued')
    file = 'turn2.txt'
    await launch(store.transition(created.id, 'provisioning'))

    const finished = store.get(created.id)!
    expect(finished.state).toBe('done')
    expect(finished.result).toBe('done turn2.txt')
    expect(finished.turns).toHaveLength(1)
    const repoDir = join(home, 'work', created.id, 'demo')
    expect(existsSync(join(repoDir, 'turn1.txt'))).toBe(true)
    expect(existsSync(join(repoDir, 'turn2.txt'))).toBe(true)
    const branch = execFileSync('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(branch).toBe(`petree/${created.id}`)
    const subjects = execFileSync('git', ['-C', repoDir, 'log', '--pretty=%s'], { encoding: 'utf8' }).trim().split('\n')
    expect(subjects.filter((s) => s.startsWith(`petree ${created.id}`)).length).toBe(2)
    expect(subjects[0]).toContain('implement it')
  })
```

- [ ] **Step 2: Run the test**

Run: `nvm use && npx vitest run test/launcher.test.ts`
Expected: PASS (Tasks 1–3 delivered the behavior; if it fails, the failure is a real integration bug — fix it in the responsible module before proceeding).

- [ ] **Step 3: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: everything green.

- [ ] **Step 4: Commit**

```bash
git add test/launcher.test.ts
git commit -m "test: two-turn follow-up flow reuses workspace and stacks commits"
```

---

### Task 6: Dashboard — Next-prompt form and turn history

**Files:**
- Modify: `src/dashboard.html`

**Interfaces:**
- Consumes: `POST /api/tasks/:id/next` (Task 4); `t.turns` (Task 1) on `GET /api/tasks/:id`.

Browser-only, manually verified (no DOM tests in this project).

- [ ] **Step 1: Add a typing-guard to the poll**

In `refresh()`, the 3s poll re-renders Overview — which would wipe the next-prompt form while the user types. Change the final lines of `refresh()`:

```js
    // Don't re-render under the user's caret: the Overview next-prompt form (and
    // any other input in the detail panel) must survive the 3s poll while focused.
    const active = document.activeElement
    const typing = active && document.getElementById('tabbody').contains(active) &&
      ['TEXTAREA', 'INPUT', 'SELECT'].includes(active.tagName)
    const resultLive = tab === 'Result' && resultShownFor !== selected
    if (selected && !typing && (tab === 'Overview' || tab === 'Log' || resultLive)) await renderBody()
```

- [ ] **Step 2: Add the Next-prompt form to Overview**

In `renderBody()`, in the `tab === 'Overview'` branch, after the closing `</dl>` template line, append to the same template literal:

```js
        ${['done', 'failed', 'cancelled'].includes(t.state) ? `
        <div class="card" style="margin-top:16px;padding:12px">
          <dt>next prompt</dt>
          <textarea id="nextPrompt" placeholder="follow-up prompt — continues this task's session, branch and workspace"></textarea>
          <div class="field" style="margin-top:8px">
            <label class="k">model</label>
            <select id="nextModel">
              ${['default', 'haiku', 'sonnet', 'opus'].map((m) => `<option value="${m}" ${(t.model || 'default') === m ? 'selected' : ''}>${m}</option>`).join('')}
            </select>
            <button class="primary" data-next="${esc(t.id)}" style="margin-left:auto">Continue task</button>
          </div>
        </div>` : ''}
```

After the existing `[data-stop]` wiring at the bottom of `renderBody()`, add:

```js
    document.querySelectorAll('[data-next]').forEach((b) => b.addEventListener('click', async () => {
      const ta = document.getElementById('nextPrompt')
      if (!ta.value.trim()) { alert('enter a follow-up prompt'); return }
      const res = await fetch('/api/tasks/' + b.dataset.next + '/next', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: ta.value, model: document.getElementById('nextModel').value }),
      })
      if (!res.ok) { alert((await res.json()).error || 'follow-up failed'); return }
      resultShownFor = null
      refresh()
    }))
    const nextTa = document.getElementById('nextPrompt')
    if (nextTa) nextTa.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); document.querySelector('[data-next]').click() }
    })
```

Note: `resultShownFor = null` un-freezes the Result tab so the next turn's result renders when it lands.

- [ ] **Step 3: Show turn history in the Result tab**

In the `tab === 'Result'` branch, prior turns render above whatever the current state shows. Replace the branch's opening so both paths include the history:

```js
    } else if (tab === 'Result') {
      const history = (t.turns || []).map((turn, i) => `
        <details class="card" style="margin-bottom:8px;padding:8px">
          <summary class="muted">turn ${i + 1} — ${esc(turn.prompt.split('\n')[0].slice(0, 80))} <span class="small">(${esc(turn.tokensUsed)} tokens)</span></summary>
          <dt>prompt</dt><dd>${esc(turn.prompt)}</dd>
          <dt>result</dt>
          <div class="result">${turn.result ? renderMarkdown(turn.result) : '<p class="muted">no result recorded</p>'}</div>
        </details>`).join('')
      if (t.state !== 'done' || !t.result) {
        body.innerHTML = history + '<p class="muted">No result yet.</p>'
      } else {
```

and inside the `else`, prefix the existing `body.innerHTML` template with `history +`:

```js
        body.innerHTML = history + `<div><button class="copy" data-copy="${encodeURIComponent(t.result)}">copy markdown</button></div>
```

(`renderMarkdown` is escape-first — same safe sink as the current result; all other fields go through `esc()`.)

- [ ] **Step 4: Typecheck + suite still green**

Run: `nvm use && npm run typecheck && npm test`
Expected: clean; suite green (dashboard has no DOM tests).

- [ ] **Step 5: Manual smoke** (deferred to user — needs the running app)

Open the dashboard, pick a `done` task: Overview shows the next-prompt box; submitting requeues the task (state flips to `queued`/`provisioning`); the Result tab shows "turn 1" collapsed above the new result once done; typing in the box is not interrupted by the 3s poll.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard.html
git commit -m "feat: next-prompt form and turn history in the dashboard"
```
