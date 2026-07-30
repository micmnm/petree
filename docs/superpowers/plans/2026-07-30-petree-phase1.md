# Petree Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working orchestrator that queues tasks, runs each unattended inside a Docker sandbox via headless Claude Code, enforces timeout/token limits, and shows progress on a minimal local web dashboard.

**Architecture:** One Node/TypeScript process on the host: YAML repo registry → SQLite task store with a guarded state machine → scheduler (concurrency 3) → launcher that clones repos on the host, builds a `docker run … claude -p --output-format stream-json` command, and parses the event stream through a `CliRunner`. An Express server exposes a JSON API plus a single-page dashboard. The runner is isolated behind events so the Phase 2 SDK runner can replace it without touching anything else.

**Tech Stack:** Node ≥ 22, TypeScript (strict, ESM), better-sqlite3, express, js-yaml, vitest, tsx. Docker CLI invoked as a subprocess (no docker SDK dependency).

## Global Constraints

- Runtime deps ONLY: `express`, `better-sqlite3`, `js-yaml`. Dev deps: `typescript`, `tsx`, `vitest`, `@types/*`.
- Defaults verbatim from spec: `timeout_minutes: 30`, `token_budget: 500000`, `concurrency: 3`.
- Container env MUST include `CLAUDE_CODE_OAUTH_TOKEN` and MUST NEVER set `ANTHROPIC_API_KEY` (would bill the API instead of the Max subscription).
- All mutable state lives under `~/.petree/` (tests override with the `PETREE_HOME` env var / constructor args). The petree repo itself stays read-only at runtime.
- No `git push` anywhere — pushing is manual, by the user, from the host.
- Tests never invoke the real `claude` binary or Docker; they use `test/fixtures/fake-claude.js`. Docker is needed only in Task 8 (image build) and the final manual smoke test.
- Every commit message follows `feat:|test:|chore:` prefix style.
- Deliberately deferred to Phase 2 (spec sections 4/7): interactive checkpoints, rate-limit auto-detection (`paused-rate-limit` exists in the state machine but nothing sets it yet — the resume endpoint covers it manually), container re-attach after orchestrator restart, per-repo `setup`/`test` command execution inside the sandbox (Phase 1 relies on the task prompt to run tests), and macOS notifications.

## File Structure

```
petree/
  package.json  tsconfig.json
  src/
    config.ts      # load/validate ~/.petree/repos.yaml
    store.ts       # SQLite task store + state machine
    scheduler.ts   # concurrency-limited launch loop
    git.ts         # host-side clone into workspace
    stream.ts      # stream-json line -> RunnerEvent[]
    runner.ts      # CliRunner: spawn, limits, events
    sandbox.ts     # docker run command builder + token file
    launcher.ts    # glue: workspace + runner + store updates
    server.ts      # express API
    dashboard.html # single-page UI
    index.ts       # entrypoint
  images/node.Dockerfile  images/dotnet.Dockerfile
  scripts/build-images.sh
  test/            # *.test.ts per src module + fixtures/
```

---

### Task 1: Project scaffold + config loader

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(home?: string): PetreeConfig` where `PetreeConfig = { home: string; defaults: { timeoutMinutes: number; tokenBudget: number; concurrency: number }; repos: Record<string, RepoConfig>; allowClone: string[] }` and `RepoConfig = { url: string; defaultBranch: string; image: string; setup: string[]; test: string[]; skills: string[] }`. Later tasks consume `PetreeConfig` everywhere.

- [ ] **Step 1: Scaffold the project**

`package.json`:

```json
{
  "name": "petree",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc -p . --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "express": "^5.0.0",
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/express": "^5.0.0",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`.gitignore`:

```
node_modules/
dist/
```

Run: `npm install`

- [ ] **Step 2: Write the failing config test**

`test/config.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

function petreeHome(yamlText: string): string {
  const home = mkdtempSync(join(tmpdir(), 'petree-'))
  writeFileSync(join(home, 'repos.yaml'), yamlText)
  return home
}

describe('loadConfig', () => {
  it('parses repos and fills defaults', () => {
    const home = petreeHome(`
repos:
  demo:
    url: file:///tmp/demo
    image: sandbox-node
`)
    const cfg = loadConfig(home)
    expect(cfg.defaults).toEqual({ timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3 })
    expect(cfg.repos.demo.url).toBe('file:///tmp/demo')
    expect(cfg.repos.demo.defaultBranch).toBe('main')
    expect(cfg.repos.demo.setup).toEqual([])
    expect(cfg.allowClone).toEqual([])
  })

  it('honors explicit defaults (snake_case keys as in the spec)', () => {
    const home = petreeHome(`
defaults:
  timeout_minutes: 10
  token_budget: 1000
  concurrency: 1
repos:
  demo: { url: x, image: sandbox-node }
`)
    const cfg = loadConfig(home)
    expect(cfg.defaults).toEqual({ timeoutMinutes: 10, tokenBudget: 1000, concurrency: 1 })
  })

  it('rejects a repo without an image', () => {
    const home = petreeHome(`
repos:
  bad: { url: x }
`)
    expect(() => loadConfig(home)).toThrow(/image/)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — cannot find `../src/config.js`

- [ ] **Step 4: Implement `src/config.ts`**

```ts
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

export interface RepoConfig {
  url: string
  defaultBranch: string
  image: string
  setup: string[]
  test: string[]
  skills: string[]
}

export interface Defaults {
  timeoutMinutes: number
  tokenBudget: number
  concurrency: number
}

export interface PetreeConfig {
  home: string
  defaults: Defaults
  repos: Record<string, RepoConfig>
  allowClone: string[]
}

export function loadConfig(
  home: string = process.env.PETREE_HOME ?? join(homedir(), '.petree'),
): PetreeConfig {
  const raw = (yaml.load(readFileSync(join(home, 'repos.yaml'), 'utf8')) ?? {}) as Record<string, unknown>
  const d = (raw.defaults ?? {}) as Record<string, number>
  const repos: Record<string, RepoConfig> = {}
  for (const [name, value] of Object.entries((raw.repos ?? {}) as Record<string, Record<string, unknown>>)) {
    if (!value?.url) throw new Error(`repo ${name}: url is required`)
    if (!value?.image) throw new Error(`repo ${name}: image is required`)
    repos[name] = {
      url: String(value.url),
      defaultBranch: String(value.default_branch ?? 'main'),
      image: String(value.image),
      setup: (value.setup as string[]) ?? [],
      test: (value.test as string[]) ?? [],
      skills: (value.skills as string[]) ?? [],
    }
  }
  return {
    home,
    defaults: {
      timeoutMinutes: d.timeout_minutes ?? 30,
      tokenBudget: d.token_budget ?? 500_000,
      concurrency: d.concurrency ?? 3,
    },
    repos,
    allowClone: (raw.allow_clone as string[]) ?? [],
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/config.test.ts` — Expected: 3 passed.
Run: `npm run typecheck` — Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/config.ts test/config.test.ts
git commit -m "feat: project scaffold and repos.yaml config loader"
```

---

### Task 2: Task store with guarded state machine

**Files:**
- Create: `src/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Produces: `TaskState`, `TaskRecord`, and `class TaskStore` with `create({prompt, repos, tokenBudget, timeoutMinutes}): TaskRecord`, `get(id): TaskRecord | undefined`, `list(): TaskRecord[]`, `transition(id, to, patch?: {error?: string | null}): TaskRecord` (throws on illegal transition), `patch(id, {sessionId?}): TaskRecord`, `addUsage(id, tokens): TaskRecord`, `countByState(state): number`, `nextQueued(): TaskRecord | undefined`. All later tasks rely on these exact names.

- [ ] **Step 1: Write the failing tests**

`test/store.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { TaskStore } from '../src/store.js'

let store: TaskStore
beforeEach(() => {
  store = new TaskStore(join(mkdtempSync(join(tmpdir(), 'petree-db-')), 'petree.db'))
})

const input = { prompt: 'do it', repos: ['demo'], tokenBudget: 1000, timeoutMinutes: 30 }

describe('TaskStore', () => {
  it('creates tasks in queued state', () => {
    const t = store.create(input)
    expect(t.state).toBe('queued')
    expect(t.repos).toEqual(['demo'])
    expect(t.tokensUsed).toBe(0)
    expect(store.get(t.id)?.id).toBe(t.id)
  })

  it('allows legal transitions and records errors', () => {
    const t = store.create(input)
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    const done = store.transition(t.id, 'paused-limit', { error: 'timeout' })
    expect(done.state).toBe('paused-limit')
    expect(done.error).toBe('timeout')
  })

  it('rejects illegal transitions', () => {
    const t = store.create(input)
    expect(() => store.transition(t.id, 'done')).toThrow(/illegal transition/)
  })

  it('accumulates usage and stores session id', () => {
    const t = store.create(input)
    store.addUsage(t.id, 100)
    store.addUsage(t.id, 50)
    store.patch(t.id, { sessionId: 'sess-1' })
    const got = store.get(t.id)!
    expect(got.tokensUsed).toBe(150)
    expect(got.sessionId).toBe('sess-1')
  })

  it('counts by state and pops queued FIFO', () => {
    const a = store.create(input)
    store.create(input)
    expect(store.countByState('queued')).toBe(2)
    expect(store.nextQueued()?.id).toBe(a.id)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL — cannot find `../src/store.js`

- [ ] **Step 3: Implement `src/store.ts`**

```ts
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export type TaskState =
  | 'queued' | 'provisioning' | 'running'
  | 'paused-limit' | 'paused-rate-limit' | 'waiting-for-you'
  | 'done' | 'failed'

export interface TaskRecord {
  id: string
  prompt: string
  repos: string[]
  mode: 'unattended'
  state: TaskState
  sessionId: string | null
  tokensUsed: number
  tokenBudget: number
  timeoutMinutes: number
  error: string | null
  createdAt: string
  updatedAt: string
}

const TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued: ['provisioning', 'failed'],
  provisioning: ['running', 'failed'],
  running: ['done', 'failed', 'paused-limit', 'paused-rate-limit', 'waiting-for-you'],
  'paused-limit': ['queued', 'failed'],
  'paused-rate-limit': ['queued', 'failed'],
  'waiting-for-you': ['queued', 'failed'],
  done: [],
  failed: ['queued'],
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToTask(r: any): TaskRecord {
  return {
    id: r.id, prompt: r.prompt, repos: JSON.parse(r.repos), mode: r.mode,
    state: r.state, sessionId: r.session_id, tokensUsed: r.tokens_used,
    tokenBudget: r.token_budget, timeoutMinutes: r.timeout_minutes,
    error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

export class TaskStore {
  private db: Database.Database

  constructor(file: string) {
    this.db = new Database(file)
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, repos TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'unattended', state TEXT NOT NULL,
      session_id TEXT, tokens_used INTEGER NOT NULL DEFAULT 0,
      token_budget INTEGER NOT NULL, timeout_minutes INTEGER NOT NULL,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
  }

  create(input: { prompt: string; repos: string[]; tokenBudget: number; timeoutMinutes: number }): TaskRecord {
    const now = new Date().toISOString()
    const id = randomUUID().slice(0, 8)
    this.db.prepare(`INSERT INTO tasks
      (id, prompt, repos, mode, state, token_budget, timeout_minutes, created_at, updated_at)
      VALUES (?, ?, ?, 'unattended', 'queued', ?, ?, ?, ?)`)
      .run(id, input.prompt, JSON.stringify(input.repos), input.tokenBudget, input.timeoutMinutes, now, now)
    return this.get(id)!
  }

  get(id: string): TaskRecord | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    return r ? rowToTask(r) : undefined
  }

  list(): TaskRecord[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC, id').all().map(rowToTask)
  }

  transition(id: string, to: TaskState, patch: { error?: string | null } = {}): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    if (!TRANSITIONS[t.state].includes(to)) throw new Error(`illegal transition ${t.state} -> ${to}`)
    this.db.prepare('UPDATE tasks SET state = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(to, patch.error !== undefined ? patch.error : t.error, new Date().toISOString(), id)
    return this.get(id)!
  }

  patch(id: string, fields: { sessionId?: string }): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    this.db.prepare('UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?')
      .run(fields.sessionId ?? t.sessionId, new Date().toISOString(), id)
    return this.get(id)!
  }

  addUsage(id: string, tokens: number): TaskRecord {
    this.db.prepare('UPDATE tasks SET tokens_used = tokens_used + ?, updated_at = ? WHERE id = ?')
      .run(tokens, new Date().toISOString(), id)
    return this.get(id)!
  }

  countByState(state: TaskState): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE state = ?').get(state) as { c: number }
    return r.c
  }

  nextQueued(): TaskRecord | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE state = 'queued' ORDER BY created_at ASC, id LIMIT 1").get()
    return r ? rowToTask(r) : undefined
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/store.test.ts` — Expected: 5 passed.
Run: `npm run typecheck` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store.test.ts
git commit -m "feat: sqlite task store with guarded state machine"
```

---

### Task 3: Scheduler

**Files:**
- Create: `src/scheduler.ts`
- Test: `test/scheduler.test.ts`

**Interfaces:**
- Consumes: `TaskStore` (`countByState`, `nextQueued`, `transition`) from Task 2.
- Produces: `class Scheduler` with `constructor(store: TaskStore, concurrency: number, launch: (t: TaskRecord) => Promise<void>)` and `tick(): Promise<void>`. The `launch` promise resolves when the task's run ends; the launch function itself owns all state transitions after `provisioning`.

- [ ] **Step 1: Write the failing tests**

`test/scheduler.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { TaskStore, type TaskRecord } from '../src/store.js'
import { Scheduler } from '../src/scheduler.js'

const input = { prompt: 'p', repos: ['demo'], tokenBudget: 1000, timeoutMinutes: 30 }

function makeStore(): TaskStore {
  return new TaskStore(join(mkdtempSync(join(tmpdir(), 'petree-sched-')), 'db'))
}

describe('Scheduler', () => {
  it('launches up to the concurrency limit, FIFO', async () => {
    const store = makeStore()
    const launched: string[] = []
    const scheduler = new Scheduler(store, 2, async (t: TaskRecord) => { launched.push(t.id) })
    const a = store.create(input); const b = store.create(input); store.create(input)
    await scheduler.tick()
    expect(launched).toEqual([a.id, b.id])
    expect(store.countByState('queued')).toBe(1)
  })

  it('launches more when capacity frees up', async () => {
    const store = makeStore()
    const scheduler = new Scheduler(store, 1, async (t) => { store.transition(t.id, 'running'); store.transition(t.id, 'done') })
    store.create(input); store.create(input)
    await scheduler.tick()
    // first launch completed synchronously enough: give the microtask a beat
    await new Promise((r) => setTimeout(r, 10))
    await scheduler.tick()
    await new Promise((r) => setTimeout(r, 10))
    expect(store.countByState('done')).toBe(2)
  })

  it('marks a task failed if launch throws', async () => {
    const store = makeStore()
    const scheduler = new Scheduler(store, 1, async () => { throw new Error('boom') })
    const t = store.create(input)
    await scheduler.tick()
    await new Promise((r) => setTimeout(r, 10))
    expect(store.get(t.id)?.state).toBe('failed')
    expect(store.get(t.id)?.error).toMatch(/boom/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/scheduler.test.ts`
Expected: FAIL — cannot find `../src/scheduler.js`

- [ ] **Step 3: Implement `src/scheduler.ts`**

```ts
import type { TaskRecord, TaskStore } from './store.js'

export class Scheduler {
  private ticking = false

  constructor(
    private store: TaskStore,
    private concurrency: number,
    private launch: (t: TaskRecord) => Promise<void>,
  ) {}

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      while (
        this.store.countByState('running') + this.store.countByState('provisioning') < this.concurrency
      ) {
        const next = this.store.nextQueued()
        if (!next) break
        const t = this.store.transition(next.id, 'provisioning')
        this.launch(t).catch((err) => {
          try {
            this.store.transition(t.id, 'failed', { error: String(err) })
          } catch {
            // task already reached a terminal state; nothing to record
          }
        })
      }
    } finally {
      this.ticking = false
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/scheduler.test.ts` — Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts test/scheduler.test.ts
git commit -m "feat: concurrency-limited scheduler"
```

---

### Task 4: Host-side git workspace preparation

**Files:**
- Create: `src/git.ts`
- Test: `test/git.test.ts`

**Interfaces:**
- Consumes: `PetreeConfig` from Task 1.
- Produces: `prepareWorkspace(cfg: PetreeConfig, repoNames: string[], workDir: string): void` — clones each named repo (host credentials, shallow, default branch) into `<workDir>/<name>`; throws on unknown repo name.

- [ ] **Step 1: Write the failing tests**

`test/git.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import { prepareWorkspace } from '../src/git.js'

function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'petree-fixture-'))
  execFileSync('git', ['init', '-b', 'main', dir])
  writeFileSync(join(dir, 'README.md'), 'hello')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'])
  return dir
}

function cfgWith(url: string): PetreeConfig {
  return {
    home: '/unused',
    defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3 },
    repos: { demo: { url, defaultBranch: 'main', image: 'sandbox-node', setup: [], test: [], skills: [] } },
    allowClone: [],
  }
}

describe('prepareWorkspace', () => {
  it('clones named repos into workDir/<name>', () => {
    const fixture = makeFixtureRepo()
    const workDir = join(mkdtempSync(join(tmpdir(), 'petree-work-')), 'w')
    prepareWorkspace(cfgWith(`file://${fixture}`), ['demo'], workDir)
    expect(existsSync(join(workDir, 'demo', 'README.md'))).toBe(true)
  })

  it('throws on unknown repo names', () => {
    expect(() => prepareWorkspace(cfgWith('file:///x'), ['nope'], '/tmp/unused-dir')).toThrow(/unknown repo/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/git.test.ts`
Expected: FAIL — cannot find `../src/git.js`

- [ ] **Step 3: Implement `src/git.ts`**

```ts
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PetreeConfig } from './config.js'

export function prepareWorkspace(cfg: PetreeConfig, repoNames: string[], workDir: string): void {
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
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/git.test.ts` — Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/git.ts test/git.test.ts
git commit -m "feat: host-side workspace clone (no credentials enter sandboxes)"
```

---

### Task 5: stream-json parser

**Files:**
- Create: `src/stream.ts`
- Test: `test/stream.test.ts`

**Interfaces:**
- Produces: `RunnerEvent` union (`{type:'session';sessionId}`, `{type:'log';line}`, `{type:'usage';tokens}`, `{type:'done';result}`, `{type:'limit';reason:'timeout'|'token-budget'}`, `{type:'error';message}`) and `parseStreamLine(line: string): RunnerEvent[]`. Every raw line yields a `log` event; recognized messages add typed events. Usage counts assistant messages only (the final `result` usage is cumulative — counting it would double-count).

- [ ] **Step 1: Write the failing tests**

`test/stream.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseStreamLine } from '../src/stream.js'

describe('parseStreamLine', () => {
  it('extracts session id from the init message', () => {
    const events = parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }))
    expect(events).toContainEqual({ type: 'session', sessionId: 's-1' })
  })

  it('extracts usage from assistant messages', () => {
    const line = JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } })
    expect(parseStreamLine(line)).toContainEqual({ type: 'usage', tokens: 150 })
  })

  it('emits done for the result message without counting its cumulative usage', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 999, output_tokens: 999 } })
    const events = parseStreamLine(line)
    expect(events).toContainEqual({ type: 'done', result: 'ok' })
    expect(events.filter((e) => e.type === 'usage')).toEqual([])
  })

  it('treats non-JSON lines as plain logs', () => {
    expect(parseStreamLine('warming up...')).toEqual([{ type: 'log', line: 'warming up...' }])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/stream.test.ts`
Expected: FAIL — cannot find `../src/stream.js`

- [ ] **Step 3: Implement `src/stream.ts`**

```ts
export type RunnerEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'log'; line: string }
  | { type: 'usage'; tokens: number }
  | { type: 'done'; result: string }
  | { type: 'limit'; reason: 'timeout' | 'token-budget' }
  | { type: 'error'; message: string }

export function parseStreamLine(line: string): RunnerEvent[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let msg: any
  try {
    msg = JSON.parse(line)
  } catch {
    return [{ type: 'log', line }]
  }
  const events: RunnerEvent[] = [{ type: 'log', line }]
  if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
    events.push({ type: 'session', sessionId: msg.session_id })
  }
  if (msg.type === 'assistant' && msg.message?.usage) {
    const u = msg.message.usage
    events.push({ type: 'usage', tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) })
  }
  if (msg.type === 'result') {
    events.push({ type: 'done', result: msg.result ?? '' })
  }
  return events
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/stream.test.ts` — Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/stream.ts test/stream.test.ts
git commit -m "feat: claude stream-json line parser"
```

---

### Task 6: CliRunner with timeout and token budget

**Files:**
- Create: `src/runner.ts`, `test/fixtures/fake-claude.js`
- Test: `test/runner.test.ts`

**Interfaces:**
- Consumes: `parseStreamLine`, `RunnerEvent` from Task 5.
- Produces: `class CliRunner extends EventEmitter` with `constructor({command: string[]; timeoutMs: number; tokenBudget: number; alreadyUsed?: number})`, `start(): void`, `stop(): Promise<void>`, `tokensUsed(): number`. Emits `'event'` with a `RunnerEvent` per event and `'closed'` when the child exits. On timeout or budget it emits `{type:'limit', reason}` and kills the child.

- [ ] **Step 1: Create the fake claude fixture**

`test/fixtures/fake-claude.js`:

```js
// Emulates `claude -p --output-format stream-json`. First arg picks a scenario.
const mode = process.argv[2] ?? 'ok'
const out = (o) => console.log(JSON.stringify(o))

out({ type: 'system', subtype: 'init', session_id: 'sess-123' })
out({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } })

if (mode === 'ok') {
  out({ type: 'result', subtype: 'success', result: 'all tests pass' })
} else if (mode === 'big-usage') {
  out({ type: 'assistant', message: { usage: { input_tokens: 900000, output_tokens: 0 } } })
  setTimeout(() => out({ type: 'result', subtype: 'success', result: 'too late' }), 2000)
} else if (mode === 'slow') {
  setTimeout(() => out({ type: 'result', subtype: 'success', result: 'too late' }), 2000)
} else if (mode === 'crash') {
  process.exit(3)
}
```

- [ ] **Step 2: Write the failing tests**

`test/runner.test.ts`:

```ts
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { CliRunner } from '../src/runner.js'
import type { RunnerEvent } from '../src/stream.js'

const fake = (mode: string): string[] => [
  process.execPath,
  fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url)),
  mode,
]

function run(opts: ConstructorParameters<typeof CliRunner>[0]): Promise<{ events: RunnerEvent[]; runner: CliRunner }> {
  return new Promise((resolve) => {
    const runner = new CliRunner(opts)
    const events: RunnerEvent[] = []
    runner.on('event', (e: RunnerEvent) => events.push(e))
    runner.on('closed', () => resolve({ events, runner }))
    runner.start()
  })
}

describe('CliRunner', () => {
  it('emits session, usage and done for a clean run', async () => {
    const { events, runner } = await run({ command: fake('ok'), timeoutMs: 5000, tokenBudget: 500000 })
    expect(events).toContainEqual({ type: 'session', sessionId: 'sess-123' })
    expect(events).toContainEqual({ type: 'done', result: 'all tests pass' })
    expect(runner.tokensUsed()).toBe(150)
  })

  it('kills the child and emits limit when the token budget is exceeded', async () => {
    const { events } = await run({ command: fake('big-usage'), timeoutMs: 5000, tokenBudget: 1000 })
    expect(events).toContainEqual({ type: 'limit', reason: 'token-budget' })
    expect(events.find((e) => e.type === 'done')).toBeUndefined()
  })

  it('kills the child and emits limit on timeout', async () => {
    const { events } = await run({ command: fake('slow'), timeoutMs: 200, tokenBudget: 500000 })
    expect(events).toContainEqual({ type: 'limit', reason: 'timeout' })
  })

  it('emits error on nonzero exit without a result', async () => {
    const { events } = await run({ command: fake('crash'), timeoutMs: 5000, tokenBudget: 500000 })
    expect(events).toContainEqual({ type: 'error', message: 'exit code 3' })
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/runner.test.ts`
Expected: FAIL — cannot find `../src/runner.js`

- [ ] **Step 4: Implement `src/runner.ts`**

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { parseStreamLine, type RunnerEvent } from './stream.js'

export interface CliRunnerOptions {
  command: string[]
  timeoutMs: number
  tokenBudget: number
  alreadyUsed?: number
}

export class CliRunner extends EventEmitter {
  private child?: ChildProcess
  private tokens: number
  private settled = false

  constructor(private opts: CliRunnerOptions) {
    super()
    this.tokens = opts.alreadyUsed ?? 0
  }

  tokensUsed(): number {
    return this.tokens
  }

  start(): void {
    const [cmd, ...args] = this.opts.command
    this.child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => this.interrupt('timeout'), this.opts.timeoutMs)

    const rl = createInterface({ input: this.child.stdout! })
    rl.on('line', (line) => {
      for (const event of parseStreamLine(line)) {
        if (this.settled && event.type !== 'log') continue
        if (event.type === 'done') this.settled = true
        this.emit('event', event)
        if (event.type === 'usage') {
          this.tokens += event.tokens
          if (this.tokens >= this.opts.tokenBudget) this.interrupt('token-budget')
        }
      }
    })
    this.child.stderr!.on('data', (d) => {
      this.emit('event', { type: 'log', line: String(d).trimEnd() } satisfies RunnerEvent)
    })
    this.child.on('close', (code) => {
      clearTimeout(timer)
      if (!this.settled && code !== 0) {
        this.emit('event', { type: 'error', message: `exit code ${code}` } satisfies RunnerEvent)
      }
      this.emit('closed')
    })
  }

  private interrupt(reason: 'timeout' | 'token-budget'): void {
    if (this.settled) return
    this.settled = true
    this.emit('event', { type: 'limit', reason } satisfies RunnerEvent)
    this.child?.kill('SIGTERM')
  }

  async stop(): Promise<void> {
    this.settled = true
    this.child?.kill('SIGTERM')
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/runner.test.ts` — Expected: 4 passed.
Run: `npm run typecheck` — Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/runner.ts test/runner.test.ts test/fixtures/fake-claude.js
git commit -m "feat: CliRunner with timeout and token-budget limits"
```

---

### Task 7: Docker command builder + token file

**Files:**
- Create: `src/sandbox.ts`
- Test: `test/sandbox.test.ts`

**Interfaces:**
- Consumes: `PetreeConfig` (Task 1), `TaskRecord` (Task 2).
- Produces: `buildDockerCommand(task: TaskRecord, cfg: PetreeConfig, workDir: string, oauthToken: string): string[]` and `readToken(home: string): string` (reads `<home>/token`, throws with setup instructions if missing).

- [ ] **Step 1: Write the failing tests**

`test/sandbox.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import type { TaskRecord } from '../src/store.js'
import { buildDockerCommand, readToken } from '../src/sandbox.js'

const cfg: PetreeConfig = {
  home: '/petree-home',
  defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3 },
  repos: { demo: { url: 'x', defaultBranch: 'main', image: 'sandbox-node', setup: [], test: [], skills: [] } },
  allowClone: [],
}

const task: TaskRecord = {
  id: 'abc123', prompt: 'fix the bug', repos: ['demo'], mode: 'unattended',
  state: 'provisioning', sessionId: null, tokensUsed: 0, tokenBudget: 500000,
  timeoutMinutes: 30, error: null, createdAt: '', updatedAt: '',
}

describe('buildDockerCommand', () => {
  it('builds a docker run command with token env, mounts and stream output', () => {
    const cmd = buildDockerCommand(task, cfg, '/tmp/work/abc123', 'tok-1')
    expect(cmd.slice(0, 3)).toEqual(['docker', 'run', '--rm'])
    expect(cmd).toContain('sandbox-node')
    expect(cmd.join(' ')).toContain('-e CLAUDE_CODE_OAUTH_TOKEN=tok-1')
    expect(cmd.join(' ')).toContain('/tmp/work/abc123:/work')
    expect(cmd.join(' ')).toContain('/petree-home/shared/skills:/petree/skills:ro')
    expect(cmd.join(' ')).toContain('--output-format stream-json')
    expect(cmd.join(' ')).not.toContain('ANTHROPIC_API_KEY')
  })

  it('adds --resume when the task has a session id', () => {
    const cmd = buildDockerCommand({ ...task, sessionId: 'sess-9' }, cfg, '/w', 't')
    expect(cmd.join(' ')).toContain('--resume sess-9')
  })
})

describe('readToken', () => {
  it('reads and trims the token file', () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-tok-'))
    writeFileSync(join(home, 'token'), 'tok-abc\n')
    expect(readToken(home)).toBe('tok-abc')
  })

  it('throws with setup instructions when missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-tok-'))
    expect(() => readToken(home)).toThrow(/claude setup-token/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/sandbox.test.ts`
Expected: FAIL — cannot find `../src/sandbox.js`

- [ ] **Step 3: Implement `src/sandbox.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PetreeConfig } from './config.js'
import type { TaskRecord } from './store.js'

export function readToken(home: string): string {
  const file = join(home, 'token')
  if (!existsSync(file)) {
    throw new Error(
      `missing ${file} — run \`claude setup-token\` on the host and save the printed token to that file (chmod 600)`,
    )
  }
  return readFileSync(file, 'utf8').trim()
}

export function buildDockerCommand(
  task: TaskRecord,
  cfg: PetreeConfig,
  workDir: string,
  oauthToken: string,
): string[] {
  const image = cfg.repos[task.repos[0]].image
  const cmd = [
    'docker', 'run', '--rm',
    '--name', `petree-${task.id}`,
    '-v', `${workDir}:/work`,
    '-v', `${join(cfg.home, 'shared', 'skills')}:/petree/skills:ro`,
    '-v', `${join(cfg.home, 'shared', 'findings')}:/petree/findings`,
    '-e', `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`,
    '-w', '/work',
    image,
    'claude', '-p', task.prompt,
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions',
  ]
  if (task.sessionId) cmd.push('--resume', task.sessionId)
  return cmd
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/sandbox.test.ts` — Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox.ts test/sandbox.test.ts
git commit -m "feat: docker sandbox command builder and oauth token loading"
```

---

### Task 8: Sandbox images

**Files:**
- Create: `images/node.Dockerfile`, `images/dotnet.Dockerfile`, `scripts/build-images.sh`

**Interfaces:**
- Produces: local Docker images tagged `sandbox-node` and `sandbox-dotnet`, each with `claude` on PATH and a non-root `dev` user (required for `--dangerously-skip-permissions`).

- [ ] **Step 1: Write the Dockerfiles**

`images/node.Dockerfile`:

```dockerfile
FROM node:22-bookworm
RUN npm install -g @anthropic-ai/claude-code
RUN useradd -m dev
USER dev
WORKDIR /work
```

`images/dotnet.Dockerfile`:

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:8.0
RUN apt-get update && apt-get install -y curl git ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
RUN useradd -m dev
USER dev
WORKDIR /work
```

`scripts/build-images.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker build -f images/node.Dockerfile -t sandbox-node images
docker build -f images/dotnet.Dockerfile -t sandbox-dotnet images
```

Run: `chmod +x scripts/build-images.sh`

- [ ] **Step 2: Build and verify (requires Docker running)**

Run: `./scripts/build-images.sh`
Then: `docker run --rm sandbox-node claude --version` and `docker run --rm sandbox-dotnet sh -c "claude --version && dotnet --version"`
Expected: version strings print, no errors. (Manual verification — no automated test for image contents in Phase 1.)

- [ ] **Step 3: Commit**

```bash
git add images scripts/build-images.sh
git commit -m "feat: sandbox-node and sandbox-dotnet images"
```

---

### Task 9: Launcher (glue: workspace → runner → store)

**Files:**
- Create: `src/launcher.ts`
- Test: `test/launcher.test.ts`

**Interfaces:**
- Consumes: `prepareWorkspace` (Task 4), `CliRunner` (Task 6), `buildDockerCommand`/`readToken` (Task 7), `TaskStore` (Task 2).
- Produces: `makeLauncher(cfg: PetreeConfig, store: TaskStore, opts?: {buildCommand?: (task: TaskRecord, workDir: string) => string[]}): (task: TaskRecord) => Promise<void>`. The returned function is what the `Scheduler` (Task 3) receives as `launch`. `opts.buildCommand` is the test seam; production default builds the docker command.

- [ ] **Step 1: Write the failing test**

`test/launcher.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import { TaskStore } from '../src/store.js'
import { makeLauncher } from '../src/launcher.js'

const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url))

function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'petree-fixture-'))
  execFileSync('git', ['init', '-b', 'main', dir])
  writeFileSync(join(dir, 'README.md'), 'hello')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'])
  return dir
}

describe('makeLauncher', () => {
  it('runs a task end to end: clone, run, record usage and result', async () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-home-'))
    mkdirSync(join(home, 'logs'), { recursive: true })
    const cfg: PetreeConfig = {
      home,
      defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3 },
      repos: { demo: { url: `file://${makeFixtureRepo()}`, defaultBranch: 'main', image: 'sandbox-node', setup: [], test: [], skills: [] } },
      allowClone: [],
    }
    const store = new TaskStore(join(home, 'petree.db'))
    const created = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 500000, timeoutMinutes: 30 })
    const task = store.transition(created.id, 'provisioning')

    const launch = makeLauncher(cfg, store, {
      buildCommand: () => [process.execPath, fakeClaude, 'ok'],
    })
    await launch(task)

    const finished = store.get(task.id)!
    expect(finished.state).toBe('done')
    expect(finished.tokensUsed).toBe(150)
    expect(finished.sessionId).toBe('sess-123')
    expect(existsSync(join(home, 'work', task.id, 'demo', 'README.md'))).toBe(true)
    expect(readFileSync(join(home, 'logs', `${task.id}.log`), 'utf8')).toContain('sess-123')
  })

  it('pauses the task when a limit is hit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-home-'))
    const cfg: PetreeConfig = {
      home,
      defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3 },
      repos: { demo: { url: `file://${makeFixtureRepo()}`, defaultBranch: 'main', image: 'sandbox-node', setup: [], test: [], skills: [] } },
      allowClone: [],
    }
    const store = new TaskStore(join(home, 'petree.db'))
    const created = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1000, timeoutMinutes: 30 })
    const task = store.transition(created.id, 'provisioning')

    const launch = makeLauncher(cfg, store, {
      buildCommand: () => [process.execPath, fakeClaude, 'big-usage'],
    })
    await launch(task)

    expect(store.get(task.id)?.state).toBe('paused-limit')
    expect(store.get(task.id)?.error).toBe('token-budget')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/launcher.test.ts`
Expected: FAIL — cannot find `../src/launcher.js`

- [ ] **Step 3: Implement `src/launcher.ts`**

```ts
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PetreeConfig } from './config.js'
import { prepareWorkspace } from './git.js'
import { CliRunner } from './runner.js'
import { buildDockerCommand, readToken } from './sandbox.js'
import type { TaskRecord, TaskStore } from './store.js'

export interface LauncherOptions {
  buildCommand?: (task: TaskRecord, workDir: string) => string[]
}

export function makeLauncher(cfg: PetreeConfig, store: TaskStore, opts: LauncherOptions = {}) {
  const buildCommand =
    opts.buildCommand ??
    ((task: TaskRecord, workDir: string) => buildDockerCommand(task, cfg, workDir, readToken(cfg.home)))

  return async function launch(task: TaskRecord): Promise<void> {
    const workDir = join(cfg.home, 'work', task.id)
    const logFile = join(cfg.home, 'logs', `${task.id}.log`)
    mkdirSync(join(cfg.home, 'logs'), { recursive: true })

    prepareWorkspace(cfg, task.repos, workDir)
    const runner = new CliRunner({
      command: buildCommand(task, workDir),
      timeoutMs: task.timeoutMinutes * 60_000,
      tokenBudget: task.tokenBudget,
      alreadyUsed: task.tokensUsed,
    })
    store.transition(task.id, 'running')

    const safely = (fn: () => void) => {
      try { fn() } catch { /* event arrived after a terminal transition; ignore */ }
    }

    await new Promise<void>((resolve) => {
      runner.on('event', (e) => {
        if (e.type === 'log') appendFileSync(logFile, e.line + '\n')
        else if (e.type === 'session') safely(() => store.patch(task.id, { sessionId: e.sessionId }))
        else if (e.type === 'usage') safely(() => store.addUsage(task.id, e.tokens))
        else if (e.type === 'done') safely(() => store.transition(task.id, 'done'))
        else if (e.type === 'limit') safely(() => store.transition(task.id, 'paused-limit', { error: e.reason }))
        else if (e.type === 'error') safely(() => store.transition(task.id, 'failed', { error: e.message }))
      })
      runner.on('closed', resolve)
      runner.start()
    })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/launcher.test.ts` — Expected: 2 passed.
Run: `npm test` — Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add src/launcher.ts test/launcher.test.ts
git commit -m "feat: task launcher wiring workspace, runner and store"
```

---

### Task 10: HTTP API + dashboard

**Files:**
- Create: `src/server.ts`, `src/dashboard.html`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `PetreeConfig` (Task 1), `TaskStore` (Task 2), `Scheduler` (Task 3).
- Produces: `makeApp(cfg, store, scheduler): express.Express` with routes `POST /api/tasks {prompt, repos[]}`, `GET /api/tasks`, `GET /api/tasks/:id`, `GET /api/tasks/:id/logs` (text), `POST /api/tasks/:id/resume`, `GET /` (dashboard HTML).

- [ ] **Step 1: Write the failing tests**

`test/server.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import { TaskStore } from '../src/store.js'
import { Scheduler } from '../src/scheduler.js'
import { makeApp } from '../src/server.js'

let server: Server
let base: string
let store: TaskStore
let home: string

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'petree-srv-'))
  const cfg: PetreeConfig = {
    home,
    defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3 },
    repos: { demo: { url: 'x', defaultBranch: 'main', image: 'sandbox-node', setup: [], test: [], skills: [] } },
    allowClone: [],
  }
  store = new TaskStore(join(home, 'db'))
  const scheduler = new Scheduler(store, 0, async () => {}) // concurrency 0: nothing launches during API tests
  const app = makeApp(cfg, store, scheduler)
  await new Promise<void>((r) => { server = app.listen(0, r) })
  const address = server.address() as { port: number }
  base = `http://127.0.0.1:${address.port}`
})

afterEach(() => server.close())

describe('API', () => {
  it('creates and lists tasks', async () => {
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'fix bug', repos: ['demo'] }),
    })
    expect(res.status).toBe(201)
    const task = await res.json()
    expect(task.state).toBe('queued')
    const list = await (await fetch(`${base}/api/tasks`)).json()
    expect(list).toHaveLength(1)
  })

  it('rejects unknown repos', async () => {
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', repos: ['nope'] }),
    })
    expect(res.status).toBe(400)
  })

  it('serves task logs as text', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    mkdirSync(join(home, 'logs'), { recursive: true })
    writeFileSync(join(home, 'logs', `${t.id}.log`), 'line one\n')
    const res = await fetch(`${base}/api/tasks/${t.id}/logs`)
    expect(await res.text()).toContain('line one')
  })

  it('resumes a paused task and 409s on non-resumable states', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.transition(t.id, 'paused-limit')
    const ok = await fetch(`${base}/api/tasks/${t.id}/resume`, { method: 'POST' })
    expect((await ok.json()).state).toBe('queued')
    const t2 = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    const bad = await fetch(`${base}/api/tasks/${t2.id}/resume`, { method: 'POST' })
    expect(bad.status).toBe(409)
  })

  it('serves the dashboard page', async () => {
    const res = await fetch(base)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Petree')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL — cannot find `../src/server.js`

- [ ] **Step 3: Implement `src/server.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { PetreeConfig } from './config.js'
import type { Scheduler } from './scheduler.js'
import type { TaskStore } from './store.js'

export function makeApp(cfg: PetreeConfig, store: TaskStore, scheduler: Scheduler): express.Express {
  const app = express()
  app.use(express.json())

  app.post('/api/tasks', (req, res) => {
    const { prompt, repos } = (req.body ?? {}) as { prompt?: string; repos?: string[] }
    if (!prompt || !Array.isArray(repos) || repos.length === 0) {
      res.status(400).json({ error: 'prompt and repos[] are required' })
      return
    }
    for (const r of repos) {
      if (!cfg.repos[r]) {
        res.status(400).json({ error: `unknown repo: ${r}` })
        return
      }
    }
    const task = store.create({
      prompt,
      repos,
      tokenBudget: cfg.defaults.tokenBudget,
      timeoutMinutes: cfg.defaults.timeoutMinutes,
    })
    void scheduler.tick()
    res.status(201).json(task)
  })

  app.get('/api/tasks', (_req, res) => { res.json(store.list()) })

  app.get('/api/tasks/:id', (req, res) => {
    const t = store.get(req.params.id)
    if (t) res.json(t)
    else res.sendStatus(404)
  })

  app.get('/api/tasks/:id/logs', (req, res) => {
    const file = join(cfg.home, 'logs', `${req.params.id}.log`)
    res.type('text/plain').send(existsSync(file) ? readFileSync(file, 'utf8') : '')
  })

  app.post('/api/tasks/:id/resume', (req, res) => {
    const t = store.get(req.params.id)
    if (!t) {
      res.sendStatus(404)
      return
    }
    try {
      res.json(store.transition(t.id, 'queued'))
      void scheduler.tick()
    } catch {
      res.status(409).json({ error: `cannot resume from state ${t.state}` })
    }
  })

  app.get('/', (_req, res) => {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dashboard.html'), 'utf8')
    res.type('html').send(html)
  })

  return app
}
```

- [ ] **Step 4: Write `src/dashboard.html`**

```html
<title>Petree</title>
<style>
  body { font-family: ui-monospace, monospace; margin: 2rem; background: #fafaf7; color: #222; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border-bottom: 1px solid #ddd; padding: .4rem .6rem; text-align: left; }
  .state { padding: .1rem .5rem; border-radius: 1rem; font-size: .85em; background: #eee; }
  .state.running { background: #cfe8ff; } .state.done { background: #d3f2d3; }
  .state.failed { background: #ffd6d6; } .state[class*="paused"], .state.waiting-for-you { background: #ffe9b8; }
  pre { background: #111; color: #ddd; padding: 1rem; overflow: auto; max-height: 50vh; }
  form { margin: 1rem 0; display: flex; gap: .5rem; }
  input { padding: .4rem; } input[name=prompt] { flex: 1; }
</style>
<h1>🧫 Petree</h1>
<form id="create">
  <input name="prompt" placeholder="task prompt" required>
  <input name="repos" placeholder="repos (comma-separated)" required>
  <button>Start task</button>
</form>
<table>
  <thead><tr><th>id</th><th>state</th><th>repos</th><th>tokens</th><th>error</th><th></th></tr></thead>
  <tbody id="tasks"></tbody>
</table>
<h2 id="logtitle" hidden></h2>
<pre id="logs" hidden></pre>
<script>
  let selected = null
  async function refresh() {
    const tasks = await (await fetch('/api/tasks')).json()
    document.getElementById('tasks').innerHTML = tasks.map(t => `
      <tr>
        <td><a href="#" onclick="showLogs('${t.id}');return false">${t.id}</a></td>
        <td><span class="state ${t.state}">${t.state}</span></td>
        <td>${t.repos.join(', ')}</td>
        <td>${t.tokensUsed} / ${t.tokenBudget}</td>
        <td>${t.error ?? ''}</td>
        <td>${['paused-limit','paused-rate-limit','waiting-for-you','failed'].includes(t.state)
          ? `<button onclick="resume('${t.id}')">resume</button>` : ''}</td>
      </tr>`).join('')
    if (selected) {
      document.getElementById('logs').textContent = await (await fetch(`/api/tasks/${selected}/logs`)).text()
    }
  }
  function showLogs(id) {
    selected = id
    document.getElementById('logtitle').textContent = `logs: ${id}`
    document.getElementById('logtitle').hidden = false
    document.getElementById('logs').hidden = false
    refresh()
  }
  async function resume(id) { await fetch(`/api/tasks/${id}/resume`, { method: 'POST' }); refresh() }
  document.getElementById('create').addEventListener('submit', async (e) => {
    e.preventDefault()
    const data = new FormData(e.target)
    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: data.get('prompt'), repos: String(data.get('repos')).split(',').map(s => s.trim()) }),
    })
    e.target.reset(); refresh()
  })
  setInterval(refresh, 3000); refresh()
</script>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/server.test.ts` — Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/dashboard.html test/server.test.ts
git commit -m "feat: http api and minimal dashboard"
```

---

### Task 11: Entrypoint + README + full-suite check

**Files:**
- Create: `src/index.ts`, `README.md`

**Interfaces:**
- Consumes: everything above, exact names as produced.

- [ ] **Step 1: Write `src/index.ts`**

```ts
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { makeLauncher } from './launcher.js'
import { Scheduler } from './scheduler.js'
import { makeApp } from './server.js'
import { TaskStore } from './store.js'

const cfg = loadConfig()
for (const dir of ['logs', 'work', 'shared/skills', 'shared/findings']) {
  mkdirSync(join(cfg.home, dir), { recursive: true })
}
const store = new TaskStore(join(cfg.home, 'petree.db'))
const scheduler = new Scheduler(store, cfg.defaults.concurrency, makeLauncher(cfg, store))
setInterval(() => void scheduler.tick(), 2000)

const app = makeApp(cfg, store, scheduler)
const port = Number(process.env.PORT ?? 4100)
app.listen(port, () => {
  console.log(`petree dashboard: http://localhost:${port}`)
})
```

- [ ] **Step 2: Write `README.md`**

```markdown
# 🧫 Petree

Local sandbox orchestrator for Claude Code: queue tasks, run each unattended
in a Docker sandbox, watch progress on a local dashboard.
Spec: docs/superpowers/specs/2026-07-30-petree-sandbox-orchestrator-design.md

## Setup

1. `npm install`
2. Build sandbox images: `./scripts/build-images.sh`
3. Create `~/.petree/repos.yaml` (see the spec, section 3.2)
4. Auth: run `claude setup-token` on the host, save the printed token to
   `~/.petree/token` and `chmod 600 ~/.petree/token`.
   Never put ANTHROPIC_API_KEY in the environment — it would bypass your
   Max subscription and bill the API directly.

## Run

    npm run dev          # dashboard on http://localhost:4100

Create a task from the dashboard (prompt + repo names). Tasks run unattended
inside containers; diffs stay in ~/.petree/work/<task-id>/ for your review.
Pushing is always manual, from the host.

## Test

    npm test
```

- [ ] **Step 3: Run the whole suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all suites pass, no type errors.

- [ ] **Step 4: Manual smoke test (requires Docker + token)**

1. `npm run dev`
2. Open http://localhost:4100, create a task `"Add a comment to README.md explaining the project"` on a small real repo from your `repos.yaml`.
3. Watch it move `queued → provisioning → running → done`; check the log stream; inspect the diff under `~/.petree/work/<id>/`.

Expected: task completes; `~/.petree/work/<id>/<repo>` contains the change; no prompt was shown anywhere.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts README.md
git commit -m "feat: entrypoint and README"
```
