# Petree Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each task's work a committed `petree/<id>` branch in its work-dir clone, expose a diff + host-side push over the API, and rebuild the task detail view with tabs, copy buttons, and a visual polish pass.

**Architecture:** All git runs on the host (the sandbox never gets credentials). A new `src/gitops.ts` holds branch/commit/status/diff/push; `prepareWorkspace` branches each clone; the launcher commits changes after the run; the server adds diff + push endpoints; the dashboard becomes a tabbed, copy-button-equipped, polished panel.

**Tech Stack:** Node ≥ 22, TypeScript strict ESM, express, better-sqlite3, vitest. No new dependencies.

## Global Constraints

- No new dependencies. Node ≥ 22 (`nvm use` before npm/npx — better-sqlite3 breaks on newer Node).
- TypeScript strict ESM; relative imports end in `.js`.
- All git operations run on the HOST via `execFileSync('git', [...])` — array args, never a shell string, never `ANTHROPIC_API_KEY`, never credentials in the sandbox.
- Git identity for petree commits/pushes is per-invocation: `-c user.name=Petree -c user.email=petree@localhost` (never global config).
- NEVER push to a repo's base branch; NEVER perform a real push to the user's Azure repos in any test — tests use local fixture repos and a local bare remote only.
- Branch name for a task: `petree/<task-id>`.
- Dashboard safe sinks unchanged: task fields via `esc()`/`textContent`, only `result` via escape-first `renderMarkdown`, diffs rendered as escaped text.
- Commit messages use `feat:|fix:|chore:|docs:` prefixes.

## File Structure

```
src/
  gitops.ts      # NEW: branch/commit/status/diff/push (host git)
  git.ts         # prepareWorkspace branches each clone after cloning
  launcher.ts    # + finalize: commit changes on the branch after the run
  server.ts      # + GET /api/tasks/:id/diff, POST /api/tasks/:id/push
  dashboard.html # rebuilt: tabbed detail, copy buttons, polish
test/
  gitops.test.ts # NEW
  (git/launcher/server tests extended)
```

---

## Plan-Phase A — git foundation & API

### Task 1: gitops module

**Files:**
- Create: `src/gitops.ts`, `test/gitops.test.ts`

**Interfaces:**
- Produces: `taskBranch(taskId): string`; `createTaskBranch(repoDir, taskId): void`; `commitChanges(repoDir, taskId, message): boolean`; `repoStatus(repoDir, baseBranch): { hasChanges, ahead, baseBranch }`; `diffBranch(repoDir, baseBranch): { stat, patch }`; `pushBranch(repoDir, taskId, target): { ok, output }`.

- [ ] **Step 1: Write the failing tests**

`test/gitops.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { taskBranch, createTaskBranch, commitChanges, repoStatus, diffBranch, pushBranch } from '../src/gitops.js'

// a clone-shaped fixture: a bare "origin" + a working clone on branch main
function fixture(): { repoDir: string; bare: string } {
  const root = mkdtempSync(join(tmpdir(), 'petree-gitops-'))
  const bare = join(root, 'origin.git')
  execFileSync('git', ['init', '--bare', '-b', 'main', bare])
  const seed = join(root, 'seed')
  execFileSync('git', ['clone', bare, seed])
  writeFileSync(join(seed, 'README.md'), 'base\n')
  execFileSync('git', ['-C', seed, 'add', '.'])
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base'])
  execFileSync('git', ['-C', seed, 'push', 'origin', 'main'])
  const repoDir = join(root, 'work')
  execFileSync('git', ['clone', '--branch', 'main', bare, repoDir])
  return { repoDir, bare }
}

describe('gitops', () => {
  it('creates the task branch', () => {
    const { repoDir } = fixture()
    createTaskBranch(repoDir, 'abc123')
    const cur = execFileSync('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(cur).toBe('petree/abc123')
    expect(taskBranch('abc123')).toBe('petree/abc123')
  })

  it('commits changes only when the tree is dirty', () => {
    const { repoDir } = fixture()
    createTaskBranch(repoDir, 'abc123')
    expect(commitChanges(repoDir, 'abc123', 'petree abc123: nothing')).toBe(false)
    writeFileSync(join(repoDir, 'new.txt'), 'hi\n')
    expect(commitChanges(repoDir, 'abc123', 'petree abc123: add file')).toBe(true)
    const msg = execFileSync('git', ['-C', repoDir, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim()
    expect(msg).toBe('petree abc123: add file')
  })

  it('reports status and diff of the branch vs base', () => {
    const { repoDir } = fixture()
    createTaskBranch(repoDir, 'abc123')
    writeFileSync(join(repoDir, 'README.md'), 'base\nadded line\n')
    commitChanges(repoDir, 'abc123', 'petree abc123: edit')
    const st = repoStatus(repoDir, 'main')
    expect(st.hasChanges).toBe(true)
    expect(st.ahead).toBe(1)
    const d = diffBranch(repoDir, 'main')
    expect(d.stat).toContain('README.md')
    expect(d.patch).toContain('+added line')
  })

  it('pushes the branch to a target and refuses git errors gracefully', () => {
    const { repoDir } = fixture()
    createTaskBranch(repoDir, 'abc123')
    writeFileSync(join(repoDir, 'f.txt'), 'x\n')
    commitChanges(repoDir, 'abc123', 'petree abc123: f')
    const ok = pushBranch(repoDir, 'abc123', 'petree/abc123')
    expect(ok.ok).toBe(true)
    // the branch now exists on origin
    const refs = execFileSync('git', ['-C', repoDir, 'ls-remote', 'origin', 'petree/abc123'], { encoding: 'utf8' })
    expect(refs).toContain('petree/abc123')
  })

  it('returns ok:false with output on a push error', () => {
    const { repoDir } = fixture()
    createTaskBranch(repoDir, 'abc123')
    // remove origin so push fails
    execFileSync('git', ['-C', repoDir, 'remote', 'remove', 'origin'])
    const res = pushBranch(repoDir, 'abc123', 'petree/abc123')
    expect(res.ok).toBe(false)
    expect(res.output.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/gitops.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/gitops.ts`**

```ts
import { execFileSync } from 'node:child_process'

const IDENT = ['-c', 'user.name=Petree', '-c', 'user.email=petree@localhost']

function git(repoDir: string, args: string[], opts: { ident?: boolean } = {}): string {
  const full = ['-C', repoDir, ...(opts.ident ? IDENT : []), ...args]
  return execFileSync('git', full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function taskBranch(taskId: string): string {
  return `petree/${taskId}`
}

export function createTaskBranch(repoDir: string, taskId: string): void {
  git(repoDir, ['checkout', '-b', taskBranch(taskId)])
}

export function commitChanges(repoDir: string, taskId: string, message: string): boolean {
  const status = git(repoDir, ['status', '--porcelain'])
  if (!status.trim()) return false
  git(repoDir, ['add', '-A'])
  git(repoDir, ['commit', '-m', message], { ident: true })
  return true
}

export interface RepoStatus {
  hasChanges: boolean
  ahead: number
  baseBranch: string
}

export function repoStatus(repoDir: string, baseBranch: string): RepoStatus {
  let ahead = 0
  try {
    ahead = Number(git(repoDir, ['rev-list', '--count', `origin/${baseBranch}..HEAD`]).trim()) || 0
  } catch {
    ahead = 0
  }
  return { hasChanges: ahead > 0, ahead, baseBranch }
}

export function diffBranch(repoDir: string, baseBranch: string): { stat: string; patch: string } {
  const base = `origin/${baseBranch}`
  const stat = git(repoDir, ['diff', '--stat', `${base}...HEAD`])
  const patch = git(repoDir, ['diff', `${base}...HEAD`])
  return { stat, patch }
}

export function pushBranch(repoDir: string, taskId: string, target: string): { ok: boolean; output: string } {
  try {
    const output = git(repoDir, ['push', 'origin', `${taskBranch(taskId)}:${target}`], { ident: true })
    return { ok: true, output: output || `pushed ${taskBranch(taskId)} -> ${target}` }
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = err as any
    const output = (e.stderr?.toString() || e.stdout?.toString() || e.message || 'push failed') as string
    return { ok: false, output }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/gitops.test.ts && npm run typecheck`
Expected: 5 passed, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/gitops.ts test/gitops.test.ts
git commit -m "feat: host-side git ops (branch, commit, status, diff, push)"
```

---

### Task 2: prepareWorkspace branches each clone

**Files:**
- Modify: `src/git.ts`
- Test: `test/git.test.ts`

**Interfaces:**
- Consumes: `createTaskBranch` (Task 1).
- Produces: `prepareWorkspace(cfg, repoNames, workDir, taskId)` — after cloning each repo, checks out `petree/<taskId>`. The `taskId` param is new (append it).

- [ ] **Step 1: Update the failing tests**

In `test/git.test.ts`, update the existing call sites to pass a task id and assert the branch. Change the successful-clone test to:

```ts
  it('clones named repos into workDir/<name> on a petree task branch', () => {
    const fixture = makeFixtureRepo()
    const workDir = join(mkdtempSync(join(tmpdir(), 'petree-work-')), 'w')
    prepareWorkspace(cfgWith(`file://${fixture}`), ['demo'], workDir, 'abc123')
    expect(existsSync(join(workDir, 'demo', 'README.md'))).toBe(true)
    const branch = execFileSync('git', ['-C', join(workDir, 'demo'), 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(branch).toBe('petree/abc123')
  })
```

Update the unknown-repo test call to `prepareWorkspace(cfgWith('file:///x'), ['nope'], '/tmp/unused-dir', 'abc123')`. Ensure `execFileSync` is imported in the test (it already is).

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/git.test.ts`
Expected: FAIL (branch is `main`/`master`, not `petree/abc123`; or arity error).

- [ ] **Step 3: Implement in `src/git.ts`**

Add the import and branch after clone:

```ts
import { createTaskBranch } from './gitops.js'
```

Change the signature and loop:

```ts
export function prepareWorkspace(cfg: PetreeConfig, repoNames: string[], workDir: string, taskId: string): void {
  for (const name of repoNames) {
    if (!cfg.repos[name]) throw new Error(`unknown repo: ${name}`)
  }
  mkdirSync(workDir, { recursive: true })
  for (const name of repoNames) {
    const repo = cfg.repos[name]
    execFileSync(
      'git',
      ['clone', '--depth', '1', '--branch', repo.defaultBranch, repo.url, join(workDir, name)],
      { stdio: 'pipe' },
    )
    createTaskBranch(join(workDir, name), taskId)
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/git.test.ts && npm run typecheck`
Expected: pass. (Typecheck will flag the launcher's call to `prepareWorkspace` missing the new arg — that is fixed in Task 3; if you run the full suite now it may fail to typecheck at launcher.ts. That is expected and resolved in Task 3. Run only the git test file here.)

- [ ] **Step 5: Commit**

```bash
git add src/git.ts test/git.test.ts
git commit -m "feat: prepareWorkspace checks out a petree task branch per repo"
```

---

### Task 3: Launcher finalize — commit changes on the branch

**Files:**
- Modify: `src/launcher.ts`
- Test: `test/launcher.test.ts`

**Interfaces:**
- Consumes: `prepareWorkspace(cfg, repos, workDir, taskId)` (Task 2), `commitChanges` (Task 1).
- Produces: after the run, each repo's changes are committed on `petree/<taskId>`; unchanged repos get no commit.

- [ ] **Step 1: Write the failing test**

Add a fixture-repo helper mode to `test/launcher.test.ts` that writes a file, or reuse an existing fixture where the fake claude edits `/work`. Simplest: use `buildCommand` to run a fake that writes a file into the workDir repo, then assert a commit exists. Add:

```ts
import { execFileSync } from 'node:child_process'

it('commits the agent changes on the task branch after a run', async () => {
  const home = mkdtempSync(join(tmpdir(), 'petree-home-'))
  mkdirSync(join(home, 'logs'), { recursive: true })
  const cfg = {
    home,
    defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null },
    repos: { demo: { url: `file://${makeFixtureRepo()}`, defaultBranch: 'main', image: 'sandbox-node', setup: [], test: [], skills: [], defaultModel: null } },
    allowClone: [],
  }
  const store = new TaskStore(join(home, 'petree.db'))
  const created = store.create({ prompt: 'edit the readme', repos: ['demo'], tokenBudget: 500000, timeoutMinutes: 30 })
  const task = store.transition(created.id, 'provisioning')
  // fake "claude" that writes a file into /work/demo then emits a clean done
  const writer = [process.execPath, '-e',
    `const fs=require('fs');fs.writeFileSync(process.env.WD+'/demo/added.txt','x');` +
    `console.log(JSON.stringify({type:'result',subtype:'success',result:'done'}))`]
  const launch = makeLauncher(cfg, store, { buildCommand: (t, workDir) => { process.env.WD = workDir; return writer } })
  await launch(task)
  const repoDir = join(home, 'work', task.id, 'demo')
  const msg = execFileSync('git', ['-C', repoDir, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim()
  expect(msg).toContain(`petree ${task.id}`)
  const branch = execFileSync('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
  expect(branch).toBe(`petree/${task.id}`)
})
```

Also update every existing `prepareWorkspace`/`makeLauncher` path: the launcher must pass `task.id` to `prepareWorkspace` (Step 3). Existing launcher tests already run through `launch`, so no test-call change is needed beyond this new test.

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use && npx vitest run test/launcher.test.ts`
Expected: FAIL (no commit / prepareWorkspace arity).

- [ ] **Step 3: Implement in `src/launcher.ts`**

Add the import:

```ts
import { commitChanges } from './gitops.js'
```

Pass the task id when preparing (find the `prepareWorkspace(cfg, task.repos, workDir)` call):

```ts
    prepareWorkspace(cfg, task.repos, workDir, task.id)
```

After the post-run reconciliation block (near the end of `launch`, after the `if (finished && ...)` block), add finalize:

```ts
    // Capture any file changes the agent made as a commit on the task branch,
    // per repo, on the host. Investigation tasks that changed nothing get no commit.
    const firstLine = task.prompt.split('\n')[0].slice(0, 72)
    for (const repo of task.repos) {
      try {
        commitChanges(join(workDir, repo), task.id, `petree ${task.id}: ${firstLine}`)
      } catch (err) {
        storeError = `commit failed for ${repo}: ${String(err)}`
      }
    }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/launcher.test.ts && npm run typecheck && npm test`
Expected: all pass, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/launcher.ts test/launcher.test.ts
git commit -m "feat: commit agent changes on the task branch after each run"
```

---

### Task 4: Server — diff & push endpoints

**Files:**
- Modify: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `repoStatus`, `diffBranch`, `pushBranch`, `taskBranch` (Task 1); `cfg.repos[].defaultBranch`; `store.get`.
- Produces: `GET /api/tasks/:id/diff` → `[{ repo, branch, baseBranch, hasChanges, stat, patch, reviewCommand }]`; `POST /api/tasks/:id/push` `{ repo, target }` → `{ ok, output }` (400 on unknown repo or base-branch target).

- [ ] **Step 1: Write the failing tests**

The server tests need a task whose work dir is a real branch with a commit and a bare remote to push to. Add a helper in `test/server.test.ts` that builds such a work dir under `cfg.home/work/<id>/<repo>` and registers the repo's `defaultBranch`. Add:

```ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

function seedWorkRepo(home: string, taskId: string, repo: string): string {
  const root = mkdtempSync(join(tmpdir(), 'petree-remote-'))
  const bare = join(root, 'origin.git')
  execFileSync('git', ['init', '--bare', '-b', 'main', bare])
  const seed = join(root, 'seed')
  execFileSync('git', ['clone', bare, seed])
  writeFileSync(join(seed, 'README.md'), 'base\n')
  execFileSync('git', ['-C', seed, 'add', '.'])
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base'])
  execFileSync('git', ['-C', seed, 'push', 'origin', 'main'])
  const workDir = join(home, 'work', taskId, repo)
  mkdirSync(join(home, 'work', taskId), { recursive: true })
  execFileSync('git', ['clone', '--branch', 'main', bare, workDir])
  execFileSync('git', ['-C', workDir, 'checkout', '-b', `petree/${taskId}`])
  writeFileSync(join(workDir, 'change.txt'), 'x\n')
  execFileSync('git', ['-C', workDir, 'add', '-A'])
  execFileSync('git', ['-C', workDir, '-c', 'user.email=p@p', '-c', 'user.name=p', 'commit', '-m', `petree ${taskId}: x`])
  return bare
}
```

Then, with the `beforeEach` `cfg.home` already a temp dir and `demo` repo having `defaultBranch: 'main'`, add tests:

```ts
  it('returns a per-repo diff with a review command', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    seedWorkRepo(home, t.id, 'demo')
    const res = await fetch(`${base}/api/tasks/${t.id}/diff`)
    const arr = await res.json()
    expect(arr[0].repo).toBe('demo')
    expect(arr[0].hasChanges).toBe(true)
    expect(arr[0].branch).toBe(`petree/${t.id}`)
    expect(arr[0].patch).toContain('change.txt')
    expect(arr[0].reviewCommand).toContain(`petree/${t.id}`)
  })

  it('pushes a task branch to a target and rejects the base branch', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    seedWorkRepo(home, t.id, 'demo')
    const good = await fetch(`${base}/api/tasks/${t.id}/push`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'demo', target: `petree/${t.id}` }),
    })
    expect((await good.json()).ok).toBe(true)
    const bad = await fetch(`${base}/api/tasks/${t.id}/push`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'demo', target: 'main' }),
    })
    expect(bad.status).toBe(400)
    const unknown = await fetch(`${base}/api/tasks/${t.id}/push`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'nope', target: 'x' }),
    })
    expect(unknown.status).toBe(400)
  })
```

Note: the `demo` repo in the test `cfg` must have `defaultBranch: 'main'` (it already does) so the endpoints diff against `origin/main`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/server.test.ts`
Expected: FAIL (routes 404).

- [ ] **Step 3: Implement in `src/server.ts`**

Add imports:

```ts
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { repoStatus, diffBranch, pushBranch, taskBranch } from './gitops.js'
```

(`join`/`existsSync` may already be imported — do not duplicate.)

Add the diff route (after the logs route):

```ts
  app.get('/api/tasks/:id/diff', (req, res) => {
    if (!/^[0-9a-f-]{8,36}$/.test(req.params.id)) { res.sendStatus(400); return }
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    const out = t.repos.map((repo) => {
      const repoDir = join(cfg.home, 'work', t.id, repo)
      const baseBranch = cfg.repos[repo]?.defaultBranch ?? 'main'
      const branch = taskBranch(t.id)
      if (!existsSync(repoDir)) {
        return { repo, branch, baseBranch, hasChanges: false, stat: '', patch: '', reviewCommand: '' }
      }
      const st = repoStatus(repoDir, baseBranch)
      const d = st.hasChanges ? diffBranch(repoDir, baseBranch) : { stat: '', patch: '' }
      const reviewCommand = `git -C <your-repo> fetch ${repoDir} ${branch} && git checkout ${branch}`
      return { repo, branch, baseBranch, hasChanges: st.hasChanges, stat: d.stat, patch: d.patch, reviewCommand }
    })
    res.json(out)
  })
```

Add the push route:

```ts
  app.post('/api/tasks/:id/push', (req, res) => {
    if (!/^[0-9a-f-]{8,36}$/.test(req.params.id)) { res.sendStatus(400); return }
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    const { repo, target } = (req.body ?? {}) as { repo?: string; target?: string }
    if (!repo || !t.repos.includes(repo)) { res.status(400).json({ error: `unknown repo: ${repo}` }); return }
    if (!target || target === (cfg.repos[repo]?.defaultBranch ?? 'main')) {
      res.status(400).json({ error: 'refusing to push to the base branch' }); return
    }
    const repoDir = join(cfg.home, 'work', t.id, repo)
    if (!existsSync(repoDir)) { res.status(400).json({ error: 'no work dir for task' }); return }
    res.json(pushBranch(repoDir, t.id, target))
  })
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server.test.ts && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: task diff and host-side push endpoints"
```

---

## Plan-Phase B — dashboard

### Task 5: Tabbed detail, copy buttons, visual polish

**Files:**
- Modify: `src/dashboard.html` (rebuild)

**Interfaces:**
- Consumes: existing endpoints (`/api/tasks`, `/api/tasks/:id`, `/api/tasks/:id/logs`, `/api/repos`, `POST /api/tasks`, `import './markdown.js'`).

Browser-only, manually verified. This task delivers the new look and the tab shell with **Overview / Result / Log** working and a **Changes** tab placeholder ("loading changes…"); Task 6 fills Changes in.

- [ ] **Step 1: Rebuild `src/dashboard.html`**

```html
<title>Petree</title>
<style>
  :root {
    --bg: #f6f6f3; --surface: #fff; --ink: #1e1e1c; --muted: #6b6b66;
    --line: #e3e3de; --accent: #3b7; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
    --sans: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; --sp: 8px; --radius: 8px;
  }
  * { box-sizing: border-box; }
  body { font-family: var(--sans); margin: 0; background: var(--bg); color: var(--ink); line-height: 1.5; }
  header { padding: calc(var(--sp)*2) calc(var(--sp)*3); border-bottom: 1px solid var(--line); background: var(--surface); }
  header h1 { margin: 0; font-size: 1.15rem; letter-spacing: .5px; }
  .wrap { padding: calc(var(--sp)*2) calc(var(--sp)*3); }
  .layout { display: flex; gap: calc(var(--sp)*3); align-items: flex-start; }
  .left { flex: 1 1 42%; min-width: 0; } .right { flex: 1 1 58%; min-width: 0; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
  form.create { padding: calc(var(--sp)*2); display: flex; flex-direction: column; gap: var(--sp); margin-bottom: calc(var(--sp)*2); }
  textarea { width: 100%; padding: var(--sp); font: inherit; border: 1px solid var(--line); border-radius: 6px; resize: none; overflow: hidden; min-height: 3rem; }
  .field { display: flex; gap: var(--sp); align-items: center; flex-wrap: wrap; font-size: .9rem; }
  .field > label.k { color: var(--muted); min-width: 3.5rem; }
  .repos { display: flex; flex-wrap: wrap; gap: calc(var(--sp)*1.5); }
  select, button { font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); cursor: pointer; }
  button.primary { background: var(--ink); color: #fff; border-color: var(--ink); }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: .8rem; }
  tbody tr { cursor: pointer; } tbody tr:hover { background: #faf8f2; } tr.sel { background: #eef6ff; }
  .badge { padding: 2px 8px; border-radius: 20px; font-size: .78rem; background: #eee; white-space: nowrap; }
  .badge.running { background: #cfe8ff; } .badge.done { background: #d4f3d4; } .badge.failed { background: #ffd7d7; }
  .badge[class*="paused"], .badge.waiting-for-you { background: #ffe9b8; }
  .mono { font-family: var(--mono); }
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); padding: 0 var(--sp); }
  .tabs button { border: none; background: none; border-radius: 0; padding: 10px 12px; color: var(--muted); border-bottom: 2px solid transparent; }
  .tabs button.active { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
  .tabbody { padding: calc(var(--sp)*2); }
  dl { margin: 0; } dt { color: var(--muted); font-size: .78rem; margin-top: 10px; } dd { margin: 2px 0 0; }
  .result h1,.result h2,.result h3 { font-size: 1rem; margin: .7rem 0 .3rem; }
  .result pre, pre.diff, pre.log { background: #16160f; color: #e6e6d8; padding: 12px; border-radius: 6px; overflow: auto; font-family: var(--mono); font-size: .82rem; }
  pre.log, pre.diff { max-height: 46vh; }
  .result code { background: #eee; padding: 0 .25rem; border-radius: 3px; font-family: var(--mono); }
  .err { color: #b00020; white-space: pre-wrap; font-family: var(--mono); }
  .copy { font-size: .72rem; padding: 2px 8px; margin-left: 6px; }
  .cmd { display: flex; align-items: center; gap: 6px; background: #f0efe9; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; font-family: var(--mono); font-size: .8rem; overflow-x: auto; }
  .muted { color: var(--muted); }
  @media (max-width: 820px) { .layout { flex-direction: column; } .left, .right { flex: 1 1 100%; } }
</style>
<header><h1>🧫 Petree</h1></header>
<div class="wrap">
  <form class="create card" id="create">
    <textarea name="prompt" id="prompt" placeholder="task prompt — Cmd/Ctrl+Enter to start" required></textarea>
    <div class="field"><label class="k">repos</label><span class="repos" id="repos"></span></div>
    <div class="field"><label class="k">model</label>
      <select id="model">
        <option value="default">default</option><option value="haiku">haiku</option>
        <option value="sonnet">sonnet</option><option value="opus">opus</option>
      </select>
      <button class="primary" type="submit" style="margin-left:auto">Start task</button>
    </div>
  </form>
  <div class="layout">
    <div class="left card"><table><thead><tr><th>id</th><th>state</th><th>repos</th><th>tokens</th></tr></thead><tbody id="tasks"></tbody></table></div>
    <div class="right card">
      <div class="tabs" id="tabs"></div>
      <div class="tabbody" id="tabbody"><p class="muted">Select a task to see details.</p></div>
    </div>
  </div>
</div>
<script type="module">
  import { renderMarkdown } from './markdown.js'
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  let selected = null, tab = 'Overview'
  const TABS = ['Overview', 'Result', 'Changes', 'Log']

  // copy button: returns HTML; clicking copies decodeURIComponent of data-copy
  function copyBtn(text) { return `<button class="copy" data-copy="${encodeURIComponent(text)}">copy</button>` }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('.copy'); if (!b) return
    try { await navigator.clipboard.writeText(decodeURIComponent(b.dataset.copy)); const o = b.textContent; b.textContent = 'copied'; setTimeout(() => (b.textContent = o), 1200) } catch {}
  })

  // create form
  const reposEl = document.getElementById('repos')
  fetch('/api/repos').then((r) => r.json()).then((repos) => {
    reposEl.innerHTML = repos.map((r) => `<label><input type="checkbox" name="repo" value="${esc(r.name)}"> ${esc(r.name)}</label>`).join('')
  })
  const prompt = document.getElementById('prompt')
  const autosize = () => { prompt.style.height = 'auto'; prompt.style.height = prompt.scrollHeight + 'px' }
  prompt.value = localStorage.getItem('petree-draft') || ''; autosize()
  prompt.addEventListener('input', () => { localStorage.setItem('petree-draft', prompt.value); autosize() })
  prompt.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); document.getElementById('create').requestSubmit() } })
  document.getElementById('create').addEventListener('submit', async (e) => {
    e.preventDefault()
    const repos = [...document.querySelectorAll('input[name=repo]:checked')].map((c) => c.value)
    if (!repos.length) { alert('select at least one repo'); return }
    await fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: prompt.value, repos, model: document.getElementById('model').value }) })
    prompt.value = ''; localStorage.removeItem('petree-draft'); autosize(); refresh()
  })

  function taskRow(t) {
    return `<tr class="${t.id === selected ? 'sel' : ''}" data-id="${esc(t.id)}">
      <td class="mono">${esc(t.id)}</td><td><span class="badge ${esc(t.state)}">${esc(t.state)}</span></td>
      <td>${esc(t.repos.join(', '))}</td><td>${esc(t.tokensUsed)}</td></tr>`
  }
  document.getElementById('tasks').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return
    selected = tr.dataset.id; tab = 'Overview'; refresh()
  })

  function renderTabs() {
    document.getElementById('tabs').innerHTML = selected
      ? TABS.map((n) => `<button class="${n === tab ? 'active' : ''}" data-tab="${n}">${n}</button>`).join('') : ''
  }
  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]'); if (!b) return; tab = b.dataset.tab; renderBody()
  })

  async function renderBody() {
    const body = document.getElementById('tabbody')
    if (!selected) { body.innerHTML = '<p class="muted">Select a task to see details.</p>'; return }
    const t = await (await fetch('/api/tasks/' + selected)).json()
    renderTabs()
    if (tab === 'Overview') {
      const resume = ['paused-limit', 'paused-rate-limit', 'waiting-for-you', 'failed'].includes(t.state)
        ? `<button data-resume="${esc(t.id)}">resume</button>` : ''
      body.innerHTML = `<dl>
        <dt>state</dt><dd><span class="badge ${esc(t.state)}">${esc(t.state)}</span> ${resume}</dd>
        <dt>id</dt><dd class="mono">${esc(t.id)} ${copyBtn(t.id)}</dd>
        <dt>prompt</dt><dd>${esc(t.prompt)}</dd>
        <dt>repos</dt><dd>${esc(t.repos.join(', '))}</dd>
        <dt>model</dt><dd>${esc(t.model || 'default')}</dd>
        <dt>tokens</dt><dd>${esc(t.tokensUsed)} / ${esc(t.tokenBudget)}</dd>
        <dt>session</dt><dd class="mono">${esc(t.sessionId || '—')} ${t.sessionId ? copyBtn(t.sessionId) : ''}</dd>
        <dt>created / updated</dt><dd class="mono">${esc(t.createdAt)} · ${esc(t.updatedAt)}</dd>
        ${t.state === 'failed' && t.error ? `<dt>error</dt><dd class="err">${esc(t.error)}</dd>` : ''}
      </dl>`
    } else if (tab === 'Result') {
      body.innerHTML = t.state === 'done' && t.result
        ? `<div><button class="copy" data-copy="${encodeURIComponent(t.result)}">copy markdown</button></div><div class="result">${renderMarkdown(t.result)}</div>`
        : '<p class="muted">No result yet.</p>'
    } else if (tab === 'Log') {
      const logs = await (await fetch('/api/tasks/' + selected + '/logs')).text()
      body.innerHTML = `<pre class="log">${esc(logs)}</pre>`
    } else if (tab === 'Changes') {
      body.innerHTML = '<p class="muted">loading changes…</p>' // filled in Task 6
    }
    document.querySelectorAll('[data-resume]').forEach((b) => b.addEventListener('click', async () => {
      await fetch('/api/tasks/' + b.dataset.resume + '/resume', { method: 'POST' }); refresh()
    }))
  }

  async function refresh() {
    const tasks = await (await fetch('/api/tasks')).json()
    document.getElementById('tasks').innerHTML = tasks.map(taskRow).join('')
    renderTabs(); await renderBody()
  }
  setInterval(refresh, 3000); refresh()
</script>
```

- [ ] **Step 2: Typecheck + suite still green**

Run: `nvm use && npm run typecheck && npm test`
Expected: typecheck clean; 74+/74+ tests pass (dashboard has no DOM test).

- [ ] **Step 3: Manual smoke** (deferred to user — needs the running app)

Open http://localhost:4100: confirm the polished look, the four tabs switch, copy buttons on id/session/result work, the create form still starts tasks, and the prompt draft persists.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard.html
git commit -m "feat: tabbed, copy-button, polished task detail"
```

---

### Task 6: Changes tab — diff, review command, push

**Files:**
- Modify: `src/dashboard.html`

**Interfaces:**
- Consumes: `GET /api/tasks/:id/diff`, `POST /api/tasks/:id/push`.

- [ ] **Step 1: Fill in the Changes tab**

Replace the Changes branch in `renderBody()` (`body.innerHTML = '<p class="muted">loading changes…</p>'`) with:

```js
    } else if (tab === 'Changes') {
      body.innerHTML = '<p class="muted">loading changes…</p>'
      const repos = await (await fetch('/api/tasks/' + selected + '/diff')).json()
      body.innerHTML = repos.map((r) => {
        if (!r.hasChanges) return `<div class="repoChange"><strong>${esc(r.repo)}</strong> <span class="muted">— no changes for this task</span></div>`
        const cmd = r.reviewCommand
        return `<div class="repoChange" style="margin-bottom:16px">
          <div><strong>${esc(r.repo)}</strong> <span class="muted mono">${esc(r.branch)} vs ${esc(r.baseBranch)}</span></div>
          <dt>review locally</dt>
          <div class="cmd"><span>${esc(cmd)}</span>${copyBtn(cmd)}</div>
          <dt>diff</dt>
          <div><button class="copy" data-copy="${encodeURIComponent(r.patch)}">copy diff</button></div>
          <pre class="diff">${esc(r.patch)}</pre>
          <dt>push</dt>
          <div class="field">
            <input class="mono" data-target="${esc(r.repo)}" value="${esc(r.branch)}" style="padding:6px;border:1px solid var(--line);border-radius:6px">
            <button data-push="${esc(r.repo)}">Push branch</button>
            <span class="pushout muted" data-out="${esc(r.repo)}"></span>
          </div>
        </div>`
      }).join('')
      body.querySelectorAll('[data-push]').forEach((btn) => btn.addEventListener('click', async () => {
        const repo = btn.dataset.push
        const target = body.querySelector(`[data-target="${repo}"]`).value
        const out = body.querySelector(`[data-out="${repo}"]`)
        out.textContent = 'pushing…'
        const res = await (await fetch('/api/tasks/' + selected + '/push', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, target }),
        })).json()
        out.textContent = res.ok ? '✓ ' + (res.output || 'pushed').split('\n')[0] : '✗ ' + (res.output || 'failed').split('\n').slice(-2).join(' ')
      }))
    }
```

Note: keep every interpolation of server/task data wrapped in `esc()`; the diff patch (container-influenced) is rendered as escaped text inside `<pre>`, never as HTML.

- [ ] **Step 2: Typecheck + suite still green**

Run: `nvm use && npm run typecheck && npm test`
Expected: clean; suite green.

- [ ] **Step 3: Manual smoke** (deferred to user — needs a task that changed files)

Run a task that edits a file in `demo` (a throwaway local repo), open the Changes tab: confirm the diff renders, the review-locally command + copy work, and Push to `petree/<id>` succeeds against a target you control (never the base branch). Do NOT test push against the real Druid repos.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard.html
git commit -m "feat: Changes tab with diff, review command, and push controls"
```
