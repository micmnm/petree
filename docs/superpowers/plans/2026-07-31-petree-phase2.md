# Petree Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture and display task results, add per-task model selection, and rebuild the dashboard into a split list + detail view with a repo multi-select and a smart prompt editor.

**Architecture:** Two plan-phases. Plan-Phase A extends the existing backend (store gets `result`/`model` columns with an idempotent migration; config gets `default_model`; sandbox appends `--model`; launcher captures the result; the API validates/resolves the model and exposes `GET /api/repos`). Plan-Phase B adds a tested standalone `src/markdown.js` renderer and rebuilds `src/dashboard.html`. Everything composes behind the interfaces Phase 1 already established.

**Tech Stack:** Node ≥ 22, TypeScript (strict, ESM), better-sqlite3, express, vitest. Plus one plain-ESM `.js` module (`src/markdown.js`) importable by both vitest and the browser. No new dependencies.

## Global Constraints

- No new dependencies (runtime: express, better-sqlite3, js-yaml; dev: typescript, tsx, vitest, @types/*).
- Node ≥ 22 (`.nvmrc` pins 22; better-sqlite3's native module breaks on newer Node). Run `nvm use` before any npm command.
- TypeScript strict ESM; relative imports end in `.js`.
- Model allowlist verbatim: `['default', 'haiku', 'sonnet', 'opus']`.
- Never `git push`; never set `ANTHROPIC_API_KEY`.
- All task fields rendered into the DOM stay on safe sinks: the markdown renderer HTML-escapes before formatting; every other interpolation uses the existing `esc()` helper or `textContent`.
- Tests never invoke the real `claude` binary or Docker.
- Commit messages use `feat:|fix:|chore:|docs:` prefixes.

## File Structure

```
src/
  store.ts       # + result/model columns, migration, setResult, create(model)
  config.ts      # + defaultModel (defaults + per-repo), resolveModel()
  sandbox.ts     # + --model from task.model
  launcher.ts    # + capture result on 'done'
  server.ts      # + MODELS, POST model validation/resolution, GET /api/repos, GET /markdown.js
  markdown.js    # NEW: standalone tested markdown → HTML renderer (plain ESM)
  dashboard.html # rebuilt: split list+detail, repo multi-select, model dropdown, smart textarea
test/
  markdown.test.ts   # NEW
  (store/config/sandbox/server tests extended)
```

---

## Plan-Phase A — data & API

### Task 1: Store — result & model columns, migration, setResult

**Files:**
- Modify: `src/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: existing `TaskStore`, `TaskRecord`.
- Produces: `TaskRecord` gains `result: string | null` and `model: string | null`; `create` accepts optional `model`; new `setResult(id: string, text: string): TaskRecord`. Constructor migrates a pre-existing DB by adding the two columns if absent.

- [ ] **Step 1: Write the failing tests**

Add to `test/store.test.ts` (keep existing tests):

```ts
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'

describe('TaskStore result & model', () => {
  it('defaults result and model to null and persists a model on create', () => {
    const s = new TaskStore(join(mkdtempSync(join(tmpdir(), 'petree-rm-')), 'db'))
    const a = s.create(input)
    expect(a.result).toBeNull()
    expect(a.model).toBeNull()
    const b = s.create({ ...input, model: 'haiku' })
    expect(b.model).toBe('haiku')
  })

  it('setResult stores the result text', () => {
    const s = new TaskStore(join(mkdtempSync(join(tmpdir(), 'petree-rm-')), 'db'))
    const t = s.create(input)
    const updated = s.setResult(t.id, '# answer\nhello')
    expect(updated.result).toBe('# answer\nhello')
    expect(s.get(t.id)?.result).toBe('# answer\nhello')
  })

  it('migrates a pre-existing Phase-1 db (no result/model columns)', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'petree-mig-')), 'db')
    // create a Phase-1-shaped table without result/model
    const raw = new Database(file)
    raw.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, repos TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'unattended', state TEXT NOT NULL,
      session_id TEXT, tokens_used INTEGER NOT NULL DEFAULT 0,
      token_budget INTEGER NOT NULL, timeout_minutes INTEGER NOT NULL,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    raw.prepare(`INSERT INTO tasks (id,prompt,repos,mode,state,token_budget,timeout_minutes,created_at,updated_at)
      VALUES ('old1','p','["demo"]','unattended','done',1000,30,'t','t')`).run()
    raw.close()
    // opening with the new TaskStore must add the columns and not throw
    const s = new TaskStore(file)
    const old = s.get('old1')!
    expect(old.result).toBeNull()
    expect(old.model).toBeNull()
    expect(existsSync(file)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/store.test.ts`
Expected: FAIL (result/model undefined; setResult not a function).

- [ ] **Step 3: Implement in `src/store.ts`**

Add the two fields to the `TaskRecord` interface after `error`:

```ts
  error: string | null
  result: string | null
  model: string | null
  createdAt: string
```

Extend `rowToTask` return to include them:

```ts
    error: r.error, result: r.result ?? null, model: r.model ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
```

In the constructor, add the two columns to the `CREATE TABLE` (append `, result TEXT, model TEXT` before the closing paren), then after the `this.db.exec(CREATE TABLE ...)` call, migrate an existing DB:

```ts
    const cols = (this.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name)
    if (!cols.includes('result')) this.db.exec('ALTER TABLE tasks ADD COLUMN result TEXT')
    if (!cols.includes('model')) this.db.exec('ALTER TABLE tasks ADD COLUMN model TEXT')
```

Change `create` to accept and store `model`:

```ts
  create(input: { prompt: string; repos: string[]; tokenBudget: number; timeoutMinutes: number; model?: string | null }): TaskRecord {
    const now = new Date().toISOString()
    const id = randomUUID().slice(0, 8)
    this.db.prepare(`INSERT INTO tasks
      (id, prompt, repos, mode, state, token_budget, timeout_minutes, model, created_at, updated_at)
      VALUES (?, ?, ?, 'unattended', 'queued', ?, ?, ?, ?, ?)`)
      .run(id, input.prompt, JSON.stringify(input.repos), input.tokenBudget, input.timeoutMinutes, input.model ?? null, now, now)
    return this.get(id)!
  }
```

Add `setResult` (place it next to `patch`):

```ts
  setResult(id: string, text: string): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    this.db.prepare('UPDATE tasks SET result = ?, updated_at = ? WHERE id = ?')
      .run(text, new Date().toISOString(), id)
    return this.get(id)!
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/store.test.ts && npm run typecheck`
Expected: all pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store.test.ts
git commit -m "feat: task store result and model columns with idempotent migration"
```

---

### Task 2: Config — default_model & resolveModel

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: existing `loadConfig`, `PetreeConfig`, `Defaults`, `RepoConfig`.
- Produces: `Defaults` gains `defaultModel: string | null`; `RepoConfig` gains `defaultModel: string | null`; new `resolveModel(requested: string | null | undefined, repoDefault: string | null, globalDefault: string | null): string | null` — returns the first of requested/repoDefault/globalDefault that is set and not `'default'`, else null.

- [ ] **Step 1: Write the failing tests**

Add to `test/config.test.ts`:

```ts
import { resolveModel } from '../src/config.js'

describe('default_model', () => {
  it('parses default_model at defaults and repo level', () => {
    const home = petreeHome(`
defaults:
  default_model: sonnet
repos:
  demo: { url: x, image: sandbox-node }
  fast: { url: y, image: sandbox-node, default_model: haiku }
`)
    const cfg = loadConfig(home)
    expect(cfg.defaults.defaultModel).toBe('sonnet')
    expect(cfg.repos.demo.defaultModel).toBeNull()
    expect(cfg.repos.fast.defaultModel).toBe('haiku')
  })

  it('defaults default_model to null when absent', () => {
    const home = petreeHome(`
repos:
  demo: { url: x, image: sandbox-node }
`)
    const cfg = loadConfig(home)
    expect(cfg.defaults.defaultModel).toBeNull()
  })
})

describe('resolveModel', () => {
  it('prefers an explicit request over defaults', () => {
    expect(resolveModel('opus', 'haiku', 'sonnet')).toBe('opus')
  })
  it("treats 'default' as no-preference and falls through", () => {
    expect(resolveModel('default', 'haiku', 'sonnet')).toBe('haiku')
  })
  it('falls back repo then global then null', () => {
    expect(resolveModel(undefined, null, 'sonnet')).toBe('sonnet')
    expect(resolveModel(undefined, 'haiku', 'sonnet')).toBe('haiku')
    expect(resolveModel(null, null, null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/config.test.ts`
Expected: FAIL (defaultModel undefined; resolveModel not exported).

- [ ] **Step 3: Implement in `src/config.ts`**

Add `defaultModel: string | null` to the `Defaults` interface and to the `RepoConfig` interface.

In the repo-building loop, add to the `repos[name] = { ... }` object:

```ts
      defaultModel: value.default_model != null ? String(value.default_model) : null,
```

In the returned `defaults` object, add:

```ts
      defaultModel: d.default_model != null ? String(d.default_model) : null,
```

Note: `d` is typed `Record<string, number>` today — widen it to `Record<string, unknown>` so `default_model` (a string) is accessible, and cast the numeric reads (e.g. `Number(d.timeout_minutes ?? 30)`).

Add the exported helper at the end of the file:

```ts
export function resolveModel(
  requested: string | null | undefined,
  repoDefault: string | null,
  globalDefault: string | null,
): string | null {
  const norm = (m?: string | null): string | null => (m && m !== 'default' ? m : null)
  return norm(requested) ?? norm(repoDefault) ?? norm(globalDefault) ?? null
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/config.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: config default_model and resolveModel helper"
```

---

### Task 3: Sandbox — pass --model

**Files:**
- Modify: `src/sandbox.ts`
- Test: `test/sandbox.test.ts`

**Interfaces:**
- Consumes: `buildDockerCommand(task, cfg, workDir, oauthToken)`; `task.model` (from Task 1).
- Produces: same signature; appends `--model <task.model>` after `-p <prompt>` when `task.model` is non-null.

- [ ] **Step 1: Write the failing tests**

Add to `test/sandbox.test.ts` (the existing `task` fixture has no `model`; add one with a model):

```ts
  it('appends --model when the task has a model', () => {
    const cmd = buildDockerCommand({ ...task, model: 'haiku' }, cfg, '/w', 't')
    expect(cmd.join(' ')).toContain('--model haiku')
    // must come after the prompt, before --output-format
    const i = cmd.indexOf('--model')
    expect(cmd[i + 1]).toBe('haiku')
    expect(cmd.indexOf('-p')).toBeLessThan(i)
    expect(i).toBeLessThan(cmd.indexOf('--output-format'))
  })

  it('omits --model when the task model is null', () => {
    const cmd = buildDockerCommand({ ...task, model: null }, cfg, '/w', 't')
    expect(cmd).not.toContain('--model')
  })
```

Also update the existing sandbox test's `task` fixture to include `result: null, model: null` so it typechecks against the new `TaskRecord`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/sandbox.test.ts`
Expected: FAIL (no `--model` in command).

- [ ] **Step 3: Implement in `src/sandbox.ts`**

In `buildDockerCommand`, after the array literal is built (it currently ends `...--dangerously-skip-permissions ]`), insert the model flag right after the `-p` prompt args. The simplest correct edit: build the base `claude` args, then splice. Replace the fixed `'claude', '-p', task.prompt,` sequence and the trailing flags so the model sits between them:

```ts
    image,
    'claude', '-p', task.prompt,
    ...(task.model ? ['--model', task.model] : []),
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions',
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/sandbox.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox.ts test/sandbox.test.ts
git commit -m "feat: pass --model to claude when a task model is set"
```

---

### Task 4: Launcher — capture result on done

**Files:**
- Modify: `src/launcher.ts:56`
- Test: `test/launcher.test.ts`

**Interfaces:**
- Consumes: `store.setResult` (Task 1), the `done` runner event (`{type:'done', result}`).
- Produces: on `done`, the task's `result` is populated before the terminal transition.

- [ ] **Step 1: Write the failing test**

Add to `test/launcher.test.ts` (the `fake-claude.js` `ok` mode already emits `result: 'all tests pass'`):

```ts
  it('captures the result text on a successful run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-home-'))
    mkdirSync(join(home, 'logs'), { recursive: true })
    const cfg: PetreeConfig = {
      home,
      defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null },
      repos: { demo: { url: `file://${makeFixtureRepo()}`, defaultBranch: 'main', image: 'sandbox-node', setup: [], test: [], skills: [], defaultModel: null } },
      allowClone: [],
    }
    const store = new TaskStore(join(home, 'petree.db'))
    const created = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 500000, timeoutMinutes: 30 })
    const task = store.transition(created.id, 'provisioning')
    const launch = makeLauncher(cfg, store, { buildCommand: () => [process.execPath, fakeClaude, 'ok'] })
    await launch(task)
    expect(store.get(task.id)?.state).toBe('done')
    expect(store.get(task.id)?.result).toBe('all tests pass')
  })
```

Note: existing launcher tests construct `cfg` without `defaultModel` — add `defaultModel: null` to their `defaults` and each repo object so they typecheck against the Task 2 types.

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use && npx vitest run test/launcher.test.ts`
Expected: FAIL (result is null).

- [ ] **Step 3: Implement in `src/launcher.ts`**

Change the `done` branch (line 56) to capture the result before transitioning:

```ts
        else if (e.type === 'done') safely(() => { store.setResult(task.id, e.result); store.transition(task.id, 'done') })
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/launcher.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/launcher.ts test/launcher.test.ts
git commit -m "feat: capture task result text on completion"
```

---

### Task 5: Server — model validation, resolution & GET /api/repos

**Files:**
- Modify: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `resolveModel` (Task 2), `store.create({..., model})` (Task 1), `cfg.repos[].defaultModel`, `cfg.defaults.defaultModel`.
- Produces: exported `const MODELS = ['default','haiku','sonnet','opus']`; `POST /api/tasks` accepts optional `model` (validated against `MODELS`, else 400), resolves the effective model and stores it; `GET /api/repos` → `[{ name, defaultBranch, image, defaultModel }]`.

- [ ] **Step 1: Write the failing tests**

Add to `test/server.test.ts` (the beforeEach builds `cfg` — add `defaultModel: null` to its `defaults` and the `demo` repo so it typechecks; give `demo` a real `default_model` in one test as needed):

```ts
  it('lists repos for the selector', async () => {
    const repos = await (await fetch(`${base}/api/repos`)).json()
    expect(repos).toContainEqual({ name: 'demo', defaultBranch: 'main', image: 'sandbox-node', defaultModel: null })
  })

  it('accepts a valid model and stores the resolved value', async () => {
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', repos: ['demo'], model: 'haiku' }),
    })
    expect(res.status).toBe(201)
    expect((await res.json()).model).toBe('haiku')
  })

  it('rejects an unknown model with 400', async () => {
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', repos: ['demo'], model: 'gpt-4' }),
    })
    expect(res.status).toBe(400)
  })

  it("stores null when model is 'default' and no config default applies", async () => {
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', repos: ['demo'], model: 'default' }),
    })
    expect((await res.json()).model).toBeNull()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/server.test.ts`
Expected: FAIL (no /api/repos; model not handled).

- [ ] **Step 3: Implement in `src/server.ts`**

Add the import and the exported constant near the top (after imports):

```ts
import { resolveModel } from './config.js'

export const MODELS = ['default', 'haiku', 'sonnet', 'opus']
```

Rewrite the `POST /api/tasks` body to validate and resolve the model:

```ts
  app.post('/api/tasks', (req, res) => {
    const { prompt, repos, model } = (req.body ?? {}) as { prompt?: string; repos?: string[]; model?: string }
    if (typeof prompt !== 'string' || !prompt || !Array.isArray(repos) || repos.length === 0) {
      res.status(400).json({ error: 'prompt and repos[] are required' })
      return
    }
    if (model !== undefined && !MODELS.includes(model)) {
      res.status(400).json({ error: `unknown model: ${model}` })
      return
    }
    for (const r of repos) {
      if (!Object.hasOwn(cfg.repos, r)) {
        res.status(400).json({ error: `unknown repo: ${r}` })
        return
      }
    }
    const effectiveModel = resolveModel(model, cfg.repos[repos[0]].defaultModel, cfg.defaults.defaultModel)
    const task = store.create({
      prompt,
      repos,
      tokenBudget: cfg.defaults.tokenBudget,
      timeoutMinutes: cfg.defaults.timeoutMinutes,
      model: effectiveModel,
    })
    void scheduler.tick()
    res.status(201).json(task)
  })
```

Add the repos endpoint (after the `GET /api/tasks` list route):

```ts
  app.get('/api/repos', (_req, res) => {
    res.json(
      Object.entries(cfg.repos).map(([name, r]) => ({
        name,
        defaultBranch: r.defaultBranch,
        image: r.image,
        defaultModel: r.defaultModel,
      })),
    )
  })
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: per-task model validation/resolution and GET /api/repos"
```

---

## Plan-Phase B — dashboard

### Task 6: Markdown renderer module

**Files:**
- Create: `src/markdown.js`
- Test: `test/markdown.test.ts`

**Interfaces:**
- Produces: `renderMarkdown(text: string): string` — returns an HTML string with all input HTML-escaped before formatting. Supports `#`–`###` headings, `**bold**`, backtick inline code, triple-backtick fenced code blocks, `-`/`1.` list items, and blank-line-separated paragraphs.

- [ ] **Step 1: Write the failing tests**

`test/markdown.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../src/markdown.js'

describe('renderMarkdown', () => {
  it('escapes HTML before formatting (no injection)', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('renders headings', () => {
    expect(renderMarkdown('# Title')).toContain('<h1>Title</h1>')
    expect(renderMarkdown('### Small')).toContain('<h3>Small</h3>')
  })

  it('renders bold and inline code', () => {
    expect(renderMarkdown('a **b** c')).toContain('<strong>b</strong>')
    expect(renderMarkdown('use `x` here')).toContain('<code>x</code>')
  })

  it('renders fenced code blocks with escaped content', () => {
    const html = renderMarkdown('```\n<b>hi</b>\n```')
    expect(html).toContain('<pre><code>')
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;')
  })

  it('renders unordered and ordered list items', () => {
    const ul = renderMarkdown('- one\n- two')
    expect(ul).toContain('<li>one</li>')
    expect(ul).toContain('<li>two</li>')
    const ol = renderMarkdown('1. first\n2. second')
    expect(ol).toContain('<li>first</li>')
  })

  it('wraps plain lines in paragraphs', () => {
    expect(renderMarkdown('hello world')).toContain('<p>hello world</p>')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/markdown.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/markdown.js`** (plain ESM — no TypeScript syntax)

```js
// Minimal, dependency-free markdown → HTML. Escapes ALL input first so
// container-sourced result text can never inject markup.
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function inline(s) {
  // s is already HTML-escaped; apply bold then inline code
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

export function renderMarkdown(text) {
  const lines = String(text).split('\n')
  const out = []
  let i = 0
  let listType = null // 'ul' | 'ol' | null
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null } }

  while (i < lines.length) {
    const line = lines[i]

    // fenced code block
    if (line.trim().startsWith('```')) {
      closeList()
      const buf = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(escapeHtml(lines[i])); i++ }
      i++ // skip closing fence
      out.push('<pre><code>' + buf.join('\n') + '</code></pre>')
      continue
    }

    // heading
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      closeList()
      const level = h[1].length
      out.push(`<h${level}>` + inline(escapeHtml(h[2])) + `</h${level}>`)
      i++
      continue
    }

    // list item (unordered or ordered)
    const ul = line.match(/^\s*-\s+(.*)$/)
    const ol = line.match(/^\s*\d+\.\s+(.*)$/)
    if (ul || ol) {
      const type = ul ? 'ul' : 'ol'
      if (listType !== type) { closeList(); out.push(`<${type}>`); listType = type }
      out.push('<li>' + inline(escapeHtml((ul || ol)[1])) + '</li>')
      i++
      continue
    }

    // blank line
    if (line.trim() === '') { closeList(); i++; continue }

    // paragraph
    closeList()
    out.push('<p>' + inline(escapeHtml(line)) + '</p>')
    i++
  }
  closeList()
  return out.join('\n')
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/markdown.test.ts && npm run typecheck`
Expected: all pass. (TypeScript typechecks `.js` under `allowJs`? It is not in `include` as `.ts`; vitest runs it directly. If typecheck errors on the `.js`, it is excluded from `tsc` by extension — confirm `npm run typecheck` stays clean.)

- [ ] **Step 5: Commit**

```bash
git add src/markdown.js test/markdown.test.ts
git commit -m "feat: dependency-free markdown renderer (escape-first)"
```

---

### Task 7: Serve /markdown.js

**Files:**
- Modify: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Produces: `GET /markdown.js` serves `src/markdown.js` from the module directory with `content-type: application/javascript`, so the dashboard can `import './markdown.js'`.

- [ ] **Step 1: Write the failing test**

Add to `test/server.test.ts`:

```ts
  it('serves the markdown module as javascript', async () => {
    const res = await fetch(`${base}/markdown.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(await res.text()).toContain('renderMarkdown')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use && npx vitest run test/server.test.ts`
Expected: FAIL (404).

- [ ] **Step 3: Implement in `src/server.ts`**

Add near the `GET /` route (which already computes the module dir via `dirname(fileURLToPath(import.meta.url))`):

```ts
  app.get('/markdown.js', (_req, res) => {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'markdown.js')
    res.type('application/javascript').send(readFileSync(file, 'utf8'))
  })
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: serve the markdown module to the dashboard"
```

---

### Task 8: Dashboard — split list + detail, repo multi-select, model dropdown, smart prompt

**Files:**
- Modify: `src/dashboard.html` (full rebuild)

**Interfaces:**
- Consumes: `GET /api/repos`, `GET /api/tasks`, `GET /api/tasks/:id`, `GET /api/tasks/:id/logs`, `POST /api/tasks` (with `model`), `import './markdown.js'`.

This is a browser-only file with no vitest harness (consistent with Phase 1). It is verified by the manual smoke test in Step 3.

- [ ] **Step 1: Rebuild `src/dashboard.html`**

```html
<title>Petree</title>
<style>
  body { font-family: ui-monospace, monospace; margin: 1.5rem; background: #fafaf7; color: #222; }
  h1 { font-size: 1.3rem; }
  .layout { display: flex; gap: 1.5rem; align-items: flex-start; }
  .left { flex: 1 1 45%; min-width: 0; }
  .right { flex: 1 1 55%; min-width: 0; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border-bottom: 1px solid #ddd; padding: .35rem .5rem; text-align: left; }
  tr.sel { background: #eef6ff; }
  .state { padding: .1rem .5rem; border-radius: 1rem; font-size: .8em; background: #eee; }
  .state.running { background: #cfe8ff; } .state.done { background: #d3f2d3; }
  .state.failed { background: #ffd6d6; } .state[class*="paused"], .state.waiting-for-you { background: #ffe9b8; }
  form { margin: 1rem 0; display: flex; flex-direction: column; gap: .5rem; max-width: 640px; }
  textarea { padding: .5rem; font: inherit; resize: none; overflow: hidden; min-height: 3rem; }
  .repos { display: flex; flex-wrap: wrap; gap: .75rem; }
  .detail { border: 1px solid #ddd; border-radius: 6px; padding: 1rem; background: #fff; }
  .detail dt { color: #666; font-size: .8em; margin-top: .5rem; }
  .result { background: #f7f7f4; border-radius: 6px; padding: .75rem 1rem; margin-top: .5rem; }
  .result h1,.result h2,.result h3 { font-size: 1rem; margin: .6rem 0 .3rem; }
  .result pre { background: #111; color: #ddd; padding: .75rem; overflow: auto; }
  .result code { background: #eee; padding: 0 .2rem; }
  .err { color: #b00; white-space: pre-wrap; }
  pre.log { background: #111; color: #ddd; padding: .75rem; overflow: auto; max-height: 40vh; font-size: .8em; }
  button { padding: .4rem .8rem; align-self: flex-start; }
</style>
<h1>🧫 Petree</h1>
<form id="create">
  <textarea name="prompt" id="prompt" placeholder="task prompt (Cmd/Ctrl+Enter to start)" required></textarea>
  <div><strong>repos:</strong> <span class="repos" id="repos"></span></div>
  <div><strong>model:</strong>
    <select name="model" id="model">
      <option value="default">default</option>
      <option value="haiku">haiku</option>
      <option value="sonnet">sonnet</option>
      <option value="opus">opus</option>
    </select>
  </div>
  <button>Start task</button>
</form>
<div class="layout">
  <div class="left">
    <table>
      <thead><tr><th>id</th><th>state</th><th>repos</th><th>tokens</th></tr></thead>
      <tbody id="tasks"></tbody>
    </table>
  </div>
  <div class="right"><div class="detail" id="detail">Select a task to see details.</div></div>
</div>
<script type="module">
  import { renderMarkdown } from './markdown.js'
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  let selected = null

  // repo checkboxes
  const reposEl = document.getElementById('repos')
  fetch('/api/repos').then((r) => r.json()).then((repos) => {
    reposEl.innerHTML = repos.map((r) =>
      `<label><input type="checkbox" name="repo" value="${esc(r.name)}"> ${esc(r.name)}</label>`).join('')
  })

  // smart prompt: autosize + draft persistence + Cmd/Ctrl+Enter
  const prompt = document.getElementById('prompt')
  const autosize = () => { prompt.style.height = 'auto'; prompt.style.height = prompt.scrollHeight + 'px' }
  prompt.value = localStorage.getItem('petree-draft') || ''
  autosize()
  prompt.addEventListener('input', () => { localStorage.setItem('petree-draft', prompt.value); autosize() })
  prompt.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); document.getElementById('create').requestSubmit() }
  })

  document.getElementById('create').addEventListener('submit', async (e) => {
    e.preventDefault()
    const repos = [...document.querySelectorAll('input[name=repo]:checked')].map((c) => c.value)
    if (repos.length === 0) { alert('select at least one repo'); return }
    await fetch('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: prompt.value, repos, model: document.getElementById('model').value }),
    })
    prompt.value = ''; localStorage.removeItem('petree-draft'); autosize(); refresh()
  })

  function row(t) {
    return `<tr class="${t.id === selected ? 'sel' : ''}" onclick="petreeSelect('${esc(t.id)}')">
      <td>${esc(t.id)}</td><td><span class="state ${esc(t.state)}">${esc(t.state)}</span></td>
      <td>${esc(t.repos.join(', '))}</td><td>${esc(t.tokensUsed)}</td></tr>`
  }

  async function renderDetail() {
    if (!selected) return
    const t = await (await fetch('/api/tasks/' + selected)).json()
    const logs = await (await fetch('/api/tasks/' + selected + '/logs')).text()
    const resume = ['paused-limit', 'paused-rate-limit', 'waiting-for-you', 'failed'].includes(t.state)
      ? `<button onclick="petreeResume('${esc(t.id)}')">resume</button>` : ''
    const body = t.state === 'done' && t.result
      ? `<dt>result</dt><div class="result">${renderMarkdown(t.result)}</div>`
      : t.state === 'failed' && t.error
        ? `<dt>error</dt><div class="err">${esc(t.error)}</div>` : ''
    document.getElementById('detail').innerHTML = `
      <div><span class="state ${esc(t.state)}">${esc(t.state)}</span> ${resume}</div>
      <dt>prompt</dt><div>${esc(t.prompt)}</div>
      <dt>repos</dt><div>${esc(t.repos.join(', '))}</div>
      <dt>model</dt><div>${esc(t.model || 'default')}</div>
      <dt>tokens</dt><div>${esc(t.tokensUsed)} / ${esc(t.tokenBudget)}</div>
      <dt>session</dt><div>${esc(t.sessionId || '—')}</div>
      <dt>created / updated</dt><div>${esc(t.createdAt)} · ${esc(t.updatedAt)}</div>
      ${body}
      <dt>log</dt><pre class="log">${esc(logs)}</pre>`
  }

  window.petreeSelect = (id) => { selected = id; refresh() }
  window.petreeResume = async (id) => { await fetch('/api/tasks/' + id + '/resume', { method: 'POST' }); refresh() }

  async function refresh() {
    const tasks = await (await fetch('/api/tasks')).json()
    document.getElementById('tasks').innerHTML = tasks.map(row).join('')
    await renderDetail()
  }
  setInterval(refresh, 3000); refresh()
</script>
```

- [ ] **Step 2: Typecheck (HTML is not compiled, but confirm nothing else broke)**

Run: `nvm use && npm run typecheck && npm test`
Expected: typecheck clean; full suite green.

- [ ] **Step 3: Manual smoke test** (Docker + real `~/.petree/token` required)

1. `npm run dev`, open http://localhost:4100.
2. Confirm the repo checkboxes populate from the registry, the model dropdown shows the four options, and the prompt box grows as you type and survives a refresh (draft persistence).
3. Create a task with a prompt, one repo checked, model `haiku`; press Cmd/Ctrl+Enter.
4. Click the task row: the detail panel shows prompt, repos, model `haiku`, tokens, session, and the live log; on completion the **result renders as formatted markdown**; a failed task shows its **error** text instead.

Expected: all of the above; the task's `model` in `GET /api/tasks/:id` is `haiku`.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard.html
git commit -m "feat: split list+detail dashboard with repo multi-select, model dropdown, smart prompt, markdown results"
```
