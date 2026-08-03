# Petree Restart Survival Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Petree server restarts no longer interrupt in-flight turns: containers run detached and outlive the server, startup re-attaches to surviving containers, and tasks whose container vanished auto-requeue with exponential backoff and `--resume`.

**Architecture:** Containers switch from `docker run --rm` child processes to detached daemon-owned containers (`docker run -d`, no `--rm`). `CliRunner` drives four injected command arrays (create/stream/wait/kill) instead of one process, streaming via `docker logs -f` with a replay-skip mode for re-attach. A new `recover()` startup pass inspects each orphaned `running`/`provisioning` row and re-attaches or requeues. The store gains `restarts`/`retry_at`/`started_at`/`log_offset` columns.

**Tech Stack:** Node 22 + TypeScript (ESM, `.js` import suffixes), better-sqlite3, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-03-restart-survival-design.md`

## Global Constraints

- Code style: no semicolons, single quotes, 2-space indent — match surrounding files exactly.
- ESM everywhere; the `test/fixtures/*.js` files must use ESM syntax (`package.json` has `"type": "module"`).
- Run tests with `npm test` (vitest), types with `npm run typecheck`. Both must pass before every commit.
- Backoff constants (spec §4): base 30 000 ms, factor 4, cap 900 000 ms, max 5 restarts → delays 30s, 2m, 8m, 15m, 15m, then failed.
- Container name is always `petree-<taskId>`; docker stop grace is `-t 5` (matches `KILL_GRACE_MS = 5000`).
- Accepted drift (spec §2): stream lines are assumed to be one-JSON-object-per-line on stdout (that is what `claude --output-format stream-json` emits); stderr lines may be re-logged once after a re-attach.
- Recommended agent models per task (user asked for “the right models”): Tasks 1, 2, 3, 6, 7 → sonnet; Tasks 4, 5 → opus.

---

### Task 1: Store — recovery columns, backoff requeue, retry gating

**Files:**
- Modify: `src/store.ts`
- Test: `test/store.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on these exact names):
  - `TaskRecord` gains `restarts: number`, `retryAt: string | null`, `startedAt: string | null`, `logOffset: number`.
  - `patch(id, fields: { sessionId?: string; error?: string; startedAt?: string; logOffset?: number }): TaskRecord`
  - `recoveryRequeue(id: string, now?: Date): TaskRecord`
  - `nextQueued(now?: Date): TaskRecord | undefined` (existing callers keep working via the default)
  - `MAX_RESTARTS` exported constant (= 5).
  - New legal transitions: `running → queued`, `provisioning → queued`.

- [ ] **Step 1: Write the failing tests**

Append to `test/store.test.ts`:

```ts
describe('restart recovery', () => {
  function toRunning(store: TaskStore, id: string) {
    store.transition(id, 'provisioning')
    store.transition(id, 'running')
  }

  it('new tasks default restarts 0, no retryAt, no startedAt, logOffset 0', () => {
    const store = makeStore()
    const t = store.create(input)
    expect(t.restarts).toBe(0)
    expect(t.retryAt).toBeNull()
    expect(t.startedAt).toBeNull()
    expect(t.logOffset).toBe(0)
  })

  it('patch persists startedAt and logOffset', () => {
    const store = makeStore()
    const t = store.create(input)
    const patched = store.patch(t.id, { startedAt: '2026-08-03T10:00:00.000Z', logOffset: 4096 })
    expect(patched.startedAt).toBe('2026-08-03T10:00:00.000Z')
    expect(patched.logOffset).toBe(4096)
  })

  it('recoveryRequeue from running: queued, restarts 1, retryAt ~now+30s', () => {
    const store = makeStore()
    const t = store.create(input)
    toRunning(store, t.id)
    const now = new Date('2026-08-03T10:00:00.000Z')
    const r = store.recoveryRequeue(t.id, now)
    expect(r.state).toBe('queued')
    expect(r.restarts).toBe(1)
    expect(r.retryAt).toBe('2026-08-03T10:00:30.000Z')
  })

  it('backoff grows 30s, 2m, 8m and caps at 15m', () => {
    const store = makeStore()
    const t = store.create(input)
    const now = new Date('2026-08-03T10:00:00.000Z')
    const delays: number[] = []
    for (let i = 0; i < 5; i++) {
      store.transition(t.id, 'provisioning')
      const r = store.recoveryRequeue(t.id, now)
      delays.push(Date.parse(r.retryAt!) - now.getTime())
    }
    expect(delays).toEqual([30_000, 120_000, 480_000, 900_000, 900_000])
  })

  it('fails instead of requeueing after MAX_RESTARTS', () => {
    const store = makeStore()
    const t = store.create(input)
    for (let i = 0; i < 5; i++) {
      store.transition(t.id, 'provisioning')
      store.recoveryRequeue(t.id)
    }
    store.transition(t.id, 'provisioning')
    const r = store.recoveryRequeue(t.id)
    expect(r.state).toBe('failed')
    expect(r.error).toMatch(/gave up after 5 recovery restarts/)
  })

  it('recoveryRequeue works from provisioning and rejects other states', () => {
    const store = makeStore()
    const t = store.create(input)
    store.transition(t.id, 'provisioning')
    expect(store.recoveryRequeue(t.id).state).toBe('queued')
    expect(() => store.recoveryRequeue(t.id)).toThrow(/cannot recovery-requeue/)
  })

  it('nextQueued skips tasks whose retryAt is in the future', () => {
    const store = makeStore()
    const t = store.create(input)
    toRunning(store, t.id)
    const now = new Date('2026-08-03T10:00:00.000Z')
    store.recoveryRequeue(t.id, now)
    expect(store.nextQueued(new Date('2026-08-03T10:00:10.000Z'))).toBeUndefined()
    expect(store.nextQueued(new Date('2026-08-03T10:00:31.000Z'))?.id).toBe(t.id)
  })

  it('a turn ending normally resets restarts and retryAt', () => {
    const store = makeStore()
    const t = store.create(input)
    toRunning(store, t.id)
    store.recoveryRequeue(t.id)
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    const done = store.transition(t.id, 'done')
    expect(done.restarts).toBe(0)
    expect(done.retryAt).toBeNull()
  })

  it('manual requeue (e.g. resume from failed) clears the backoff gate', () => {
    const store = makeStore()
    const t = store.create(input)
    toRunning(store, t.id)
    store.recoveryRequeue(t.id)
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'failed')
    const r = store.transition(t.id, 'queued')
    expect(r.retryAt).toBeNull()
    expect(r.restarts).toBe(0)
  })

  it('followUp resets restarts and retryAt', () => {
    const store = makeStore()
    const t = store.create(input)
    toRunning(store, t.id)
    store.recoveryRequeue(t.id)
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.transition(t.id, 'done')
    const f = store.followUp(t.id, 'next step')
    expect(f.restarts).toBe(0)
    expect(f.retryAt).toBeNull()
  })
})
```

`makeStore` and `input` already exist in the file (or mirror the pattern from `test/scheduler.test.ts`: `new TaskStore(join(mkdtempSync(join(tmpdir(), 'petree-store-')), 'db'))` and `{ prompt: 'p', repos: ['demo'], tokenBudget: 1000, timeoutMinutes: 30 }`). Reuse whatever helper the file defines.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL — `restarts`/`retryAt` undefined, `recoveryRequeue is not a function`.

- [ ] **Step 3: Implement in `src/store.ts`**

Add to `TaskRecord` (after `turns: Turn[]`):

```ts
  restarts: number
  retryAt: string | null
  startedAt: string | null
  logOffset: number
```

Export next to the other constants:

```ts
// Recovery backoff (spec §4): 30s, 2m, 8m, 15m, 15m, then give up.
export const MAX_RESTARTS = 5
const BACKOFF_BASE_MS = 30_000
const BACKOFF_FACTOR = 4
const BACKOFF_CAP_MS = 15 * 60_000
```

TRANSITIONS changes (recovery requeue paths only):

```ts
  queued: ['provisioning', 'failed', 'cancelled'],
  provisioning: ['running', 'queued', 'failed', 'cancelled'],
  running: ['done', 'queued', 'failed', 'paused-limit', 'paused-rate-limit', 'waiting-for-you', 'cancelled'],
```

`rowToTask` additions (inside the returned object):

```ts
    restarts: r.restarts ?? 0, retryAt: r.retry_at ?? null,
    startedAt: r.started_at ?? null, logOffset: r.log_offset ?? 0,
```

Constructor migration (extend the existing `cols` checks):

```ts
    if (!cols.includes('restarts')) this.db.exec('ALTER TABLE tasks ADD COLUMN restarts INTEGER NOT NULL DEFAULT 0')
    if (!cols.includes('retry_at')) this.db.exec('ALTER TABLE tasks ADD COLUMN retry_at TEXT')
    if (!cols.includes('started_at')) this.db.exec('ALTER TABLE tasks ADD COLUMN started_at TEXT')
    if (!cols.includes('log_offset')) this.db.exec('ALTER TABLE tasks ADD COLUMN log_offset INTEGER NOT NULL DEFAULT 0')
```

Replace `transition()` with:

```ts
  transition(id: string, to: TaskState, patch: { error?: string | null } = {}): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    if (!TRANSITIONS[t.state].includes(to)) throw new Error(`illegal transition ${t.state} -> ${to}`)
    // Leaving 'running' proves the task is not crash-looping; entering 'queued'
    // by hand (resume/follow-up) must not stay gated behind an old backoff.
    // recoveryRequeue() re-applies its own counter right after this call.
    const clearBackoff = t.state === 'running' || to === 'queued'
    this.db.prepare(`UPDATE tasks SET state = ?, error = ?, updated_at = ?,
        restarts = CASE WHEN ? THEN 0 ELSE restarts END,
        retry_at = CASE WHEN ? THEN NULL ELSE retry_at END
      WHERE id = ?`)
      .run(to, patch.error !== undefined ? patch.error : t.error, new Date().toISOString(),
        clearBackoff ? 1 : 0, clearBackoff ? 1 : 0, id)
    return this.get(id)!
  }
```

Replace `patch()` with:

```ts
  patch(id: string, fields: { sessionId?: string; error?: string; startedAt?: string; logOffset?: number }): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    this.db.prepare('UPDATE tasks SET session_id = ?, error = ?, started_at = ?, log_offset = ?, updated_at = ? WHERE id = ?')
      .run(fields.sessionId ?? t.sessionId, fields.error ?? t.error, fields.startedAt ?? t.startedAt,
        fields.logOffset ?? t.logOffset, new Date().toISOString(), id)
    return this.get(id)!
  }
```

Add after `followUp()`:

```ts
  // Requeue a task orphaned by a server restart (its container is gone).
  // Retries are spaced with exponential backoff so a crash-looping setup
  // cannot relaunch — and spend tokens — in a tight loop; after MAX_RESTARTS
  // the task fails instead.
  recoveryRequeue(id: string, now: Date = new Date()): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    if (t.state !== 'running' && t.state !== 'provisioning') {
      throw new Error(`cannot recovery-requeue from state ${t.state}`)
    }
    if (t.restarts >= MAX_RESTARTS) {
      return this.transition(id, 'failed', { error: `gave up after ${t.restarts} recovery restarts` })
    }
    const delay = Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** t.restarts, BACKOFF_CAP_MS)
    this.transition(id, 'queued', { error: 'recovered after server restart' })
    this.db.prepare('UPDATE tasks SET restarts = ?, retry_at = ? WHERE id = ?')
      .run(t.restarts + 1, new Date(now.getTime() + delay).toISOString(), id)
    return this.get(id)!
  }
```

Replace `nextQueued()` with:

```ts
  nextQueued(now: Date = new Date()): TaskRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM tasks WHERE state = 'queued'
      AND (retry_at IS NULL OR retry_at <= ?)
      ORDER BY created_at ASC, rowid ASC LIMIT 1`).get(now.toISOString())
    return r ? rowToTask(r) : undefined
  }
```

In `followUp()`, extend the UPDATE to also reset the backoff:

```ts
    this.db.prepare(`UPDATE tasks SET prompt = ?, model = ?, tokens_used = 0, result = NULL,
      turns = ?, state = 'queued', restarts = 0, retry_at = NULL, updated_at = ? WHERE id = ?`)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/store.test.ts && npm run typecheck`
Expected: PASS (all pre-existing store tests too).

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store.test.ts
git commit -m "feat(store): recovery columns, backoff requeue, retryAt gating"
```

---

### Task 2: Sandbox — detached container command set

**Files:**
- Modify: `src/sandbox.ts`
- Test: `test/sandbox.test.ts` (rewrite `buildDockerCommand` tests for the new shape)

**Interfaces:**
- Consumes: `TaskRecord` (Task 1 fields not required here).
- Produces (Tasks 4–6 rely on these exact names):

```ts
export interface SandboxCommands {
  containerName: string
  create: string[]   // docker run -d ... (detached, NO --rm)
  stream: string[]   // docker logs -f <name>
  wait: string[]     // docker wait <name>
  kill: string[]     // docker stop -t 5 <name>
  remove: string[]   // docker rm -f <name>
  inspect: string[]  // docker inspect -f {{.State.Status}} <name>
}
export function containerName(taskId: string): string
export function buildSandboxCommands(task: TaskRecord, cfg: PetreeConfig, workDir: string, oauthToken: string): SandboxCommands
export type ContainerState = 'running' | 'exited' | 'absent'
export function inspectContainerState(inspect: string[]): Promise<ContainerState>
```

Keep `buildDockerCommand` exactly as-is in this task (its caller `src/launcher.ts` is rewritten in Task 5, which deletes it); add the new functions alongside so the build stays green.

- [ ] **Step 1: Write the failing tests**

Replace/extend `test/sandbox.test.ts` (keep `readToken` tests and the existing setup helpers; the file already builds a `cfg` and `task` — reuse them). New assertions:

```ts
import { buildSandboxCommands, containerName, inspectContainerState } from '../src/sandbox.js'

describe('buildSandboxCommands', () => {
  it('creates a detached, named container without --rm', () => {
    const cmds = buildSandboxCommands(task, cfg, '/tmp/w', 'tok')
    expect(cmds.containerName).toBe(`petree-${task.id}`)
    expect(cmds.create.slice(0, 4)).toEqual(['docker', 'run', '-d', '--init'])
    expect(cmds.create).not.toContain('--rm')
    expect(cmds.create).toContain(`petree-${task.id}`)
    expect(cmds.create).toContain('--dangerously-skip-permissions')
  })

  it('builds the stream/wait/kill/remove/inspect commands', () => {
    const cmds = buildSandboxCommands(task, cfg, '/tmp/w', 'tok')
    const name = `petree-${task.id}`
    expect(cmds.stream).toEqual(['docker', 'logs', '-f', name])
    expect(cmds.wait).toEqual(['docker', 'wait', name])
    expect(cmds.kill).toEqual(['docker', 'stop', '-t', '5', name])
    expect(cmds.remove).toEqual(['docker', 'rm', '-f', name])
    expect(cmds.inspect).toEqual(['docker', 'inspect', '-f', '{{.State.Status}}', name])
  })
})
```

Also port the two existing `--resume` gating tests (transcript exists → `create` contains `['--resume', sessionId]`; missing transcript → it does not) to call `buildSandboxCommands(...)` and assert on `.create`.

For `inspectContainerState`, add:

```ts
describe('inspectContainerState', () => {
  const echo = (out: string) => [process.execPath, '-e', `console.log('${out}')`]
  it('maps running / exited / dead / other / command-failure', async () => {
    expect(await inspectContainerState(echo('running'))).toBe('running')
    expect(await inspectContainerState(echo('exited'))).toBe('exited')
    expect(await inspectContainerState(echo('dead'))).toBe('exited')
    expect(await inspectContainerState(echo('created'))).toBe('absent')
    expect(await inspectContainerState([process.execPath, '-e', 'process.exit(1)'])).toBe('absent')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/sandbox.test.ts`
Expected: FAIL — `buildSandboxCommands is not a function`.

- [ ] **Step 3: Implement in `src/sandbox.ts`**

```ts
import { execFile } from 'node:child_process'

export function containerName(taskId: string): string {
  return `petree-${taskId}`
}

export interface SandboxCommands {
  containerName: string
  create: string[]
  stream: string[]
  wait: string[]
  kill: string[]
  remove: string[]
  inspect: string[]
}

// Detached (-d, no --rm): the container is owned by the docker daemon and
// survives petree restarts; petree removes it explicitly once the turn is
// finalized. See docs/superpowers/specs/2026-08-03-restart-survival-design.md.
export function buildSandboxCommands(
  task: TaskRecord,
  cfg: PetreeConfig,
  workDir: string,
  oauthToken: string,
): SandboxCommands {
  const image = cfg.repos[task.repos[0]].image
  const name = containerName(task.id)
  const create = [
    'docker', 'run', '-d', '--init',
    '--name', name,
    '-v', `${workDir}:/work`,
    '-v', `${join(cfg.home, 'shared', 'skills')}:/petree/skills:ro`,
    '-v', `${join(cfg.home, 'shared', 'findings')}:/petree/findings`,
    '-v', `${join(cfg.home, 'sessions', task.id)}:/home/dev/.claude`,
    '-e', `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`,
    '-w', '/work',
    image,
    'claude', '-p', task.prompt,
    ...(task.model ? ['--model', task.model] : []),
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions',
  ]
  // Resume only when the transcript from a previous run actually exists on the
  // host (cwd inside the container is always /work, so the project key is
  // stable). A stale sessionId with no transcript must start a fresh session,
  // not crash the run.
  const transcript = task.sessionId
    ? join(cfg.home, 'sessions', task.id, 'projects', '-work', `${task.sessionId}.jsonl`)
    : null
  if (task.sessionId && transcript && existsSync(transcript)) create.push('--resume', task.sessionId)
  return {
    containerName: name,
    create,
    stream: ['docker', 'logs', '-f', name],
    wait: ['docker', 'wait', name],
    kill: ['docker', 'stop', '-t', '5', name],
    remove: ['docker', 'rm', '-f', name],
    inspect: ['docker', 'inspect', '-f', '{{.State.Status}}', name],
  }
}

export type ContainerState = 'running' | 'exited' | 'absent'

// 'created' (never started) and other odd statuses map to 'absent' so recovery
// requeues instead of waiting forever on a container that will never speak.
export function inspectContainerState(inspect: string[]): Promise<ContainerState> {
  return new Promise((resolve) => {
    const [cmd, ...args] = inspect
    execFile(cmd, args, (err, stdout) => {
      if (err) return resolve('absent')
      const status = stdout.trim()
      if (status === 'running') return resolve('running')
      if (status === 'exited' || status === 'dead') return resolve('exited')
      resolve('absent')
    })
  })
}
```

Keep `readToken` and (for now) `buildDockerCommand` untouched; Task 5 deletes `buildDockerCommand`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/sandbox.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox.ts test/sandbox.test.ts
git commit -m "feat(sandbox): detached container command set + state inspection"
```

---

### Task 3: Fake docker shim fixtures

**Files:**
- Create: `test/fixtures/fake-docker.js`
- Create: `test/fixtures/fake-container.js`
- Test: `test/fake-docker.test.ts`

**Interfaces:**
- Consumes: `test/fixtures/fake-claude.js` scenarios (`ok`, `slow`, `crash`, `big-usage`, `dup-usage`, `two-results`, `silent`).
- Produces: a docker-CLI emulator used by Tasks 4, 5, 7. CLI (state dir from env `FAKE_DOCKER_HOME`):
  - `run <name> <scenario>` — detached fake container (survives the parent), prints name. Exit 125 + stderr if name in use.
  - `logs [-f] <name>` — dump (or follow until exit) the container’s stdout.
  - `wait <name>` — block until exit, print exit code.
  - `stop <name>` — SIGTERM the container (exit code 143), block until down.
  - `rm <name>` — delete all state (flags like `-f` accepted and ignored).
  - `inspect <name>` — print `running`/`exited`, exit 1 if unknown.
  - Env `FAKE_CONTAINER_EXEC` (JSON argv) overrides the containerized command — used by launcher tests that need a file-writing “agent”.

- [ ] **Step 1: Write the fixtures**

`test/fixtures/fake-container.js`:

```js
// Plays the "container" for fake-docker.js: runs fake-claude.js (or the argv
// in FAKE_CONTAINER_EXEC), appends its stdout to <name>.log, and records the
// exit code in <name>.exit — 143 when stopped via SIGTERM, like docker stop.
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [home, name, scenario] = process.argv.slice(2)
const fakeClaude = fileURLToPath(new URL('./fake-claude.js', import.meta.url))
const argv = process.env.FAKE_CONTAINER_EXEC
  ? JSON.parse(process.env.FAKE_CONTAINER_EXEC)
  : [process.execPath, fakeClaude, scenario]
const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] })
child.stdout.on('data', (chunk) => appendFileSync(join(home, `${name}.log`), chunk))
let finished = false
const finish = (code) => {
  if (finished) return
  finished = true
  writeFileSync(join(home, `${name}.exit`), String(code))
  process.exit(0)
}
child.on('close', (code, signal) => finish(code ?? (signal === 'SIGTERM' ? 143 : 137)))
process.on('SIGTERM', () => {
  child.kill('SIGTERM')
  setTimeout(() => finish(143), 200).unref()
})
```

`test/fixtures/fake-docker.js`:

```js
// Emulates the docker CLI subset petree uses, against a state directory given
// by FAKE_DOCKER_HOME. "Containers" are detached node processes, so they
// survive the death of whoever spawned them — exactly like real containers
// survive the petree server.
// CLI: run <name> <scenario> | logs [-f] <name> | wait <name> | stop <name>
//      | rm <name> | inspect <name>
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = process.env.FAKE_DOCKER_HOME
if (!home) { console.error('FAKE_DOCKER_HOME not set'); process.exit(64) }
const argv = process.argv.slice(2)
const sub = argv[0]
const args = argv.slice(1).filter((a) => !a.startsWith('-'))
const name = args[sub === 'run' ? 0 : args.length - 1]
const p = (ext) => join(home, `${name}.${ext}`)
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

if (sub === 'run') {
  if (existsSync(p('pid')) && !existsSync(p('exit'))) { console.error(`name ${name} in use`); process.exit(125) }
  rmSync(p('exit'), { force: true })
  rmSync(p('log'), { force: true })
  const wrapper = fileURLToPath(new URL('./fake-container.js', import.meta.url))
  const child = spawn(process.execPath, [wrapper, home, name, args[1] ?? 'ok'], { detached: true, stdio: 'ignore' })
  child.unref()
  writeFileSync(p('pid'), String(child.pid))
  console.log(name)
} else if (sub === 'logs') {
  let offset = 0
  const drain = () => {
    if (!existsSync(p('log'))) return
    const size = statSync(p('log')).size
    if (size > offset) {
      const fd = openSync(p('log'), 'r')
      const buf = Buffer.alloc(size - offset)
      readSync(fd, buf, 0, buf.length, offset)
      closeSync(fd)
      process.stdout.write(buf)
      offset = size
    }
  }
  if (!argv.includes('-f')) {
    drain()
    process.exit(existsSync(p('pid')) ? 0 : 1)
  }
  const timer = setInterval(() => {
    drain()
    if (existsSync(p('exit'))) { drain(); clearInterval(timer) }
  }, 20)
} else if (sub === 'wait') {
  const timer = setInterval(() => {
    if (existsSync(p('exit'))) {
      clearInterval(timer)
      console.log(readFileSync(p('exit'), 'utf8').trim())
    }
  }, 20)
} else if (sub === 'stop') {
  if (existsSync(p('pid')) && !existsSync(p('exit'))) {
    const pid = Number(readFileSync(p('pid'), 'utf8'))
    if (alive(pid)) { try { process.kill(pid, 'SIGTERM') } catch { /* raced its exit */ } }
  }
  const timer = setInterval(() => {
    if (!existsSync(p('pid')) || existsSync(p('exit'))) { clearInterval(timer); console.log(name) }
  }, 20)
} else if (sub === 'rm') {
  for (const ext of ['pid', 'exit', 'log']) rmSync(p(ext), { force: true })
  console.log(name)
} else if (sub === 'inspect') {
  if (!existsSync(p('pid'))) { console.error('no such container'); process.exit(1) }
  if (existsSync(p('exit'))) console.log('exited')
  else if (alive(Number(readFileSync(p('pid'), 'utf8')))) console.log('running')
  else console.log('exited')
} else {
  console.error(`unknown subcommand ${sub}`)
  process.exit(64)
}
```

- [ ] **Step 2: Write the smoke tests**

`test/fake-docker.test.ts`:

```ts
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const shim = fileURLToPath(new URL('./fixtures/fake-docker.js', import.meta.url))

function docker(home: string, ...argv: string[]): string {
  return execFileSync(process.execPath, [shim, ...argv], {
    env: { ...process.env, FAKE_DOCKER_HOME: home },
    encoding: 'utf8',
  })
}

const until = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('fake-docker shim', () => {
  it('run + wait + logs: clean scenario', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fdock-'))
    expect(docker(home, 'run', 'c1', 'ok').trim()).toBe('c1')
    expect(docker(home, 'wait', 'c1').trim()).toBe('0')
    const logs = docker(home, 'logs', 'c1')
    expect(logs).toContain('sess-123')
    expect(logs).toContain('all tests pass')
  })

  it('logs -f follows until exit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fdock-'))
    docker(home, 'run', 'c2', 'slow')
    const out = execFileSync(process.execPath, [shim, 'logs', '-f', 'c2'], {
      env: { ...process.env, FAKE_DOCKER_HOME: home },
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(out).toContain('too late')
  })

  it('stop kills the container with exit code 143; inspect reports states', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fdock-'))
    docker(home, 'run', 'c3', 'slow')
    expect(docker(home, 'inspect', 'c3').trim()).toBe('running')
    docker(home, 'stop', 'c3')
    expect(docker(home, 'wait', 'c3').trim()).toBe('143')
    expect(docker(home, 'inspect', 'c3').trim()).toBe('exited')
  })

  it('containers survive their spawner: run via a child process that dies immediately', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fdock-'))
    // spawn the shim and let the parent (this callback) drop it — no waiting
    await new Promise<void>((resolve) => {
      execFile(process.execPath, [shim, 'run', 'c4', 'slow'],
        { env: { ...process.env, FAKE_DOCKER_HOME: home } }, () => resolve())
    })
    await until(() => existsSync(join(home, 'c4.exit')))
    expect(docker(home, 'logs', 'c4')).toContain('too late')
  })

  it('rm removes state; second run with same live name fails with 125', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fdock-'))
    docker(home, 'run', 'c5', 'slow')
    expect(() => docker(home, 'run', 'c5', 'ok')).toThrow()
    docker(home, 'stop', 'c5')
    docker(home, 'rm', 'c5')
    expect(() => docker(home, 'inspect', 'c5')).toThrow()
    expect(docker(home, 'run', 'c5', 'ok').trim()).toBe('c5')
  })

  it('FAKE_CONTAINER_EXEC overrides the containerized command', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fdock-'))
    execFileSync(process.execPath, [shim, 'run', 'c6', 'ok'], {
      env: {
        ...process.env,
        FAKE_DOCKER_HOME: home,
        FAKE_CONTAINER_EXEC: JSON.stringify([process.execPath, '-e', "console.log('custom-exec-ran')"]),
      },
      encoding: 'utf8',
    })
    docker(home, 'wait', 'c6')
    expect(docker(home, 'logs', 'c6')).toContain('custom-exec-ran')
  })
})
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run test/fake-docker.test.ts`
Expected: PASS. If a test hangs, the shim’s `logs -f`/`wait` poller isn’t seeing the `.exit` file — debug the fixture, not the test.

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/fake-docker.js test/fixtures/fake-container.js test/fake-docker.test.ts
git commit -m "test: fake docker shim with detached, restart-surviving containers"
```

---

### Task 4: CliRunner — container lifecycle + replay re-attach

**Files:**
- Modify: `src/runner.ts`
- Test: `test/runner.test.ts` (rewrite the spawn plumbing; keep every existing behavioral expectation)

**Interfaces:**
- Consumes: shim fixture from Task 3 (tests only).
- Produces (Task 5 relies on these exact names):

```ts
export interface SandboxProcessCommands {
  create?: string[]  // omitted on re-attach: the container already exists
  stream: string[]
  wait: string[]
  kill: string[]
}
export interface CliRunnerOptions {
  commands: SandboxProcessCommands
  timeoutMs: number
  tokenBudget: number
  alreadyUsed?: number
  skipLines?: number  // re-attach: stdout lines already processed pre-restart
}
```

`CliRunner`’s events (`session`/`log`/`usage`/`done`/`limit`/`error` + `closed`) and `tokensUsed()`/`start()`/`stop()` keep their exact semantics.

- [ ] **Step 1: Rewrite `test/runner.test.ts`**

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, it, expect } from 'vitest'
import { CliRunner, type SandboxProcessCommands } from '../src/runner.js'
import type { RunnerEvent } from '../src/stream.js'

const shim = fileURLToPath(new URL('./fixtures/fake-docker.js', import.meta.url))
let home: string
let seq = 0

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'petree-runner-'))
  process.env.FAKE_DOCKER_HOME = home
})

function commands(scenario: string, name = `c${++seq}`): SandboxProcessCommands & { name: string } {
  const d = (...a: string[]) => [process.execPath, shim, ...a]
  return {
    name,
    create: d('run', name, scenario),
    stream: d('logs', '-f', name),
    wait: d('wait', name),
    kill: d('stop', name),
  }
}

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
    const { events, runner } = await run({ commands: commands('ok'), timeoutMs: 10_000, tokenBudget: 500000 })
    expect(events).toContainEqual({ type: 'session', sessionId: 'sess-123' })
    expect(events).toContainEqual({ type: 'done', result: 'all tests pass' })
    expect(runner.tokensUsed()).toBe(150)
  })

  it('stops the container and emits limit when the token budget is exceeded', async () => {
    const c = commands('big-usage')
    const { events } = await run({ commands: c, timeoutMs: 10_000, tokenBudget: 1000 })
    expect(events).toContainEqual({ type: 'limit', reason: 'token-budget' })
    expect(events.find((e) => e.type === 'done')).toBeUndefined()
    expect(existsSync(join(home, `${c.name}.exit`))).toBe(true)
  })

  it('stops the container and emits limit on timeout', async () => {
    const { events } = await run({ commands: commands('slow'), timeoutMs: 300, tokenBudget: 500000 })
    expect(events).toContainEqual({ type: 'limit', reason: 'timeout' })
  })

  it('emits error with the container exit code on a crash', async () => {
    const { events } = await run({ commands: commands('crash'), timeoutMs: 10_000, tokenBudget: 500000 })
    expect(events).toContainEqual({ type: 'error', message: 'exit code 3' })
  })

  it('counts duplicated usage messages (same message id) only once', async () => {
    const { runner } = await run({ commands: commands('dup-usage'), timeoutMs: 10_000, tokenBudget: 500000 })
    expect(runner.tokensUsed()).toBe(150)
  })

  it('emits an error when the create command fails (name conflict)', async () => {
    const first = commands('slow', 'conflict-1')
    execFileSync(process.execPath, first.create.slice(1), { env: process.env as NodeJS.ProcessEnv })
    const { events } = await run({ commands: commands('ok', 'conflict-1'), timeoutMs: 10_000, tokenBudget: 500000 })
    expect(events.some((e) => e.type === 'error' && e.message.includes('in use'))).toBe(true)
    execFileSync(process.execPath, [shim, 'stop', 'conflict-1'])
  })

  it('emits the LAST result as done and counts usage across all turns', async () => {
    const { events, runner } = await run({ commands: commands('two-results'), timeoutMs: 10_000, tokenBudget: 500000 })
    const dones = events.filter((e) => e.type === 'done')
    expect(dones).toHaveLength(1)
    expect(dones[0]).toEqual({ type: 'done', result: 'final answer' })
    expect(runner.tokensUsed()).toBe(210)
  })

  it('seeds tokensUsed from alreadyUsed', async () => {
    const { runner } = await run({ commands: commands('ok'), timeoutMs: 10_000, tokenBudget: 500000, alreadyUsed: 100 })
    expect(runner.tokensUsed()).toBe(250)
  })

  it('emits limit immediately without any container when the budget is already exhausted', async () => {
    const c = commands('ok')
    const { events } = await run({ commands: c, timeoutMs: 10_000, tokenBudget: 500000, alreadyUsed: 500000 })
    expect(events).toContainEqual({ type: 'limit', reason: 'token-budget' })
    expect(existsSync(join(home, `${c.name}.pid`))).toBe(false)
  })

  it('re-attaches without a create command to a container started elsewhere', async () => {
    const pre = commands('ok', 'reattach-1')
    execFileSync(process.execPath, pre.create.slice(1))
    const { events } = await run({
      commands: { stream: pre.stream, wait: pre.wait, kill: pre.kill },
      timeoutMs: 10_000, tokenBudget: 500000,
    })
    expect(events).toContainEqual({ type: 'done', result: 'all tests pass' })
  })

  it('re-attaches to an already-exited container and still finalizes', async () => {
    const pre = commands('ok', 'reattach-2')
    execFileSync(process.execPath, pre.create.slice(1))
    execFileSync(process.execPath, [shim, 'wait', 'reattach-2'])
    const { events } = await run({
      commands: { stream: pre.stream, wait: pre.wait, kill: pre.kill },
      timeoutMs: 10_000, tokenBudget: 500000,
    })
    expect(events).toContainEqual({ type: 'done', result: 'all tests pass' })
  })

  it('skipLines replays without re-emitting or double-counting', async () => {
    // 'ok' emits 3 stdout lines: init, usage(m1: 150), result.
    // Pretend the first 2 were processed before a restart (tokens persisted).
    const pre = commands('ok', 'replay-1')
    execFileSync(process.execPath, pre.create.slice(1))
    execFileSync(process.execPath, [shim, 'wait', 'replay-1'])
    const { events, runner } = await run({
      commands: { stream: pre.stream, wait: pre.wait, kill: pre.kill },
      timeoutMs: 10_000, tokenBudget: 500000, alreadyUsed: 150, skipLines: 2,
    })
    expect(runner.tokensUsed()).toBe(150) // not 300
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'log')).toHaveLength(1) // only the result line
    expect(events).toContainEqual({ type: 'done', result: 'all tests pass' })
  })

  it('session events are re-emitted even during replay (idempotent patch)', async () => {
    const pre = commands('ok', 'replay-2')
    execFileSync(process.execPath, pre.create.slice(1))
    execFileSync(process.execPath, [shim, 'wait', 'replay-2'])
    const { events } = await run({
      commands: { stream: pre.stream, wait: pre.wait, kill: pre.kill },
      timeoutMs: 10_000, tokenBudget: 500000, alreadyUsed: 150, skipLines: 3,
    })
    expect(events).toContainEqual({ type: 'session', sessionId: 'sess-123' })
  })
})
```

Note: `pre.create.slice(1)` strips `process.execPath` because `execFileSync(process.execPath, [...])` re-adds it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/runner.test.ts`
Expected: FAIL — `CliRunnerOptions` has no `commands` property (type error at runtime: spawn of `undefined`).

- [ ] **Step 3: Rewrite `src/runner.ts`**

```ts
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { parseStreamLine, type RunnerEvent } from './stream.js'

export interface SandboxProcessCommands {
  // Omitted on re-attach: the container already exists (running or exited).
  create?: string[]
  stream: string[]
  wait: string[]
  kill: string[]
}

export interface CliRunnerOptions {
  commands: SandboxProcessCommands
  timeoutMs: number
  tokenBudget: number
  alreadyUsed?: number
  // Re-attach: stdout lines already processed (and persisted) before a server
  // restart. They rebuild in-memory state without re-emitting log/usage.
  skipLines?: number
}

// If the kill command (docker stop -t 5) somehow never brings the container
// down, force-close the local log stream so the runner still settles.
const STREAM_KILL_MS = 15_000
// After the stream closes, how long to keep waiting for the exit code.
const WAIT_RESULT_GRACE_MS = 5000

export class CliRunner extends EventEmitter {
  private streamChild?: ChildProcess
  private started = false
  private tokens: number
  private settled = false
  private closed = false
  private countedMessageIds = new Set<string>()
  private lastResult: string | null = null
  private replayRemaining: number
  private waitExit?: Promise<number | null>
  private timeoutTimer?: NodeJS.Timeout
  private killTimer?: NodeJS.Timeout

  constructor(private opts: CliRunnerOptions) {
    super()
    this.tokens = opts.alreadyUsed ?? 0
    this.replayRemaining = opts.skipLines ?? 0
  }

  tokensUsed(): number {
    return this.tokens
  }

  start(): void {
    if (this.started) throw new Error('runner already started')
    this.started = true

    if (this.tokens >= this.opts.tokenBudget) {
      this.settled = true
      setImmediate(() => {
        this.emit('event', { type: 'limit', reason: 'token-budget' } satisfies RunnerEvent)
        this.emitClosed()
      })
      return
    }

    this.timeoutTimer = setTimeout(() => this.interrupt('timeout'), this.opts.timeoutMs)

    if (this.opts.commands.create) {
      const [cmd, ...args] = this.opts.commands.create
      execFile(cmd, args, (err, _stdout, stderr) => {
        if (err) {
          this.clearTimers()
          if (!this.settled) {
            this.settled = true
            this.emit('event', { type: 'error', message: stderr?.trim() || err.message } satisfies RunnerEvent)
          }
          this.emitClosed()
          return
        }
        this.attach()
      })
    } else {
      this.attach()
    }
  }

  private attach(): void {
    if (this.settled) {
      // stop()/interrupt() raced the create — make sure the container dies too
      this.killContainer()
      this.emitClosed()
      return
    }
    this.waitExit = this.collectExitCode()
    const [cmd, ...args] = this.opts.commands.stream
    this.streamChild = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    const rl = createInterface({ input: this.streamChild.stdout! })
    rl.on('line', (line) => {
      if (!line.trim()) return
      const replay = this.replayRemaining > 0
      if (replay) this.replayRemaining--
      for (const event of parseStreamLine(line)) {
        if (this.settled && event.type !== 'log') continue
        if (event.type === 'usage' && event.messageId !== null) {
          // stream-json repeats a message once per content block; count each id once
          if (this.countedMessageIds.has(event.messageId)) continue
          this.countedMessageIds.add(event.messageId)
        }
        if (event.type === 'done') {
          // not terminal yet — later turns may produce more results/usage.
          // Remember the latest; the authoritative done is emitted at close.
          this.lastResult = event.result
          continue
        }
        if (replay) {
          // Replayed lines were already streamed (and persisted) before the
          // restart: rebuild dedup/result state, but re-emit no log/usage and
          // count no tokens — those are already in alreadyUsed. Session ids
          // are re-emitted; patching them again is idempotent and covers a
          // crash between the log write and the sessionId write.
          if (event.type === 'error') this.settled = true
          if (event.type === 'session') this.emit('event', event)
          continue
        }
        if (event.type === 'error') this.settled = true
        this.emit('event', event)
        if (event.type === 'usage') {
          this.tokens += event.tokens
          if (this.tokens >= this.opts.tokenBudget) this.interrupt('token-budget')
        }
      }
    })

    const errRl = createInterface({ input: this.streamChild.stderr! })
    errRl.on('line', (line) => {
      if (!line.trim()) return
      this.emit('event', { type: 'log', line } satisfies RunnerEvent)
    })

    this.streamChild.on('error', (e) => {
      this.clearTimers()
      if (!this.settled) {
        this.settled = true
        this.emit('event', { type: 'error', message: e.message } satisfies RunnerEvent)
      }
      this.emitClosed()
    })

    this.streamChild.on('close', () => {
      void this.finalize()
    })
  }

  private async finalize(): Promise<void> {
    this.clearTimers()
    const code = await this.exitCodeOrNull()
    if (!this.settled) {
      if (this.lastResult !== null) {
        this.emit('event', { type: 'done', result: this.lastResult } satisfies RunnerEvent)
      } else if (code !== 0) {
        const message = code !== null ? `exit code ${code}` : 'container exit code unavailable'
        this.emit('event', { type: 'error', message } satisfies RunnerEvent)
      }
      // clean exit (0) with no result at all → emit nothing; the launcher's
      // post-run reconciliation fails the task ("run ended without terminal event")
    }
    this.settled = true
    this.emitClosed()
  }

  private collectExitCode(): Promise<number | null> {
    return new Promise((resolve) => {
      const [cmd, ...args] = this.opts.commands.wait
      execFile(cmd, args, (err, stdout) => {
        if (err) return resolve(null)
        const code = Number.parseInt(stdout.trim(), 10)
        resolve(Number.isNaN(code) ? null : code)
      })
    })
  }

  private exitCodeOrNull(): Promise<number | null> {
    const grace = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), WAIT_RESULT_GRACE_MS).unref()
    })
    return Promise.race([this.waitExit ?? Promise.resolve(null), grace])
  }

  private clearTimers(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    if (this.killTimer) clearTimeout(this.killTimer)
  }

  private emitClosed(): void {
    if (this.closed) return
    this.closed = true
    this.emit('closed')
  }

  private killContainer(): void {
    const [cmd, ...args] = this.opts.commands.kill
    execFile(cmd, args, () => {})
    this.killTimer = setTimeout(() => this.streamChild?.kill('SIGKILL'), STREAM_KILL_MS)
    this.killTimer.unref()
  }

  private interrupt(reason: 'timeout' | 'token-budget'): void {
    if (this.settled) return
    this.settled = true
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    this.emit('event', { type: 'limit', reason } satisfies RunnerEvent)
    this.killContainer()
  }

  async stop(): Promise<void> {
    this.settled = true
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    if (this.closed) return
    if (!this.started) {
      this.emitClosed()
      return
    }
    await new Promise<void>((resolve) => {
      this.once('closed', () => resolve())
      this.killContainer()
    })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/runner.test.ts && npm run typecheck`
Expected: runner tests PASS. Typecheck will FAIL in `src/launcher.ts` (still passing `command:`) — that is expected and fixed in Task 5; if the typecheck failure blocks the commit hook, commit anyway with the failure limited to `launcher.ts` noted in the commit body, or coordinate to land Task 5 in the same session before pushing. `npx vitest run test/runner.test.ts` itself must be green.

- [ ] **Step 5: Commit**

```bash
git add src/runner.ts test/runner.test.ts
git commit -m "feat(runner): drive detached containers via create/stream/wait/kill with replay re-attach"
```

---

### Task 5: Launcher — commands seam, reattach, offsets, container removal

**Files:**
- Modify: `src/launcher.ts`
- Modify: `src/sandbox.ts` (delete `buildDockerCommand` and its tests if any remain)
- Test: `test/launcher.test.ts`

**Interfaces:**
- Consumes: Task 1 store fields/methods, Task 2 `buildSandboxCommands`/`SandboxCommands`, Task 4 `CliRunner`, Task 3 shim.
- Produces (Task 6 relies on):

```ts
export interface LauncherOptions {
  buildCommands?: (task: TaskRecord, workDir: string) => SandboxCommands
}
export interface Launcher {
  (task: TaskRecord): Promise<void>
  stop(id: string): Promise<boolean>
  reattach(task: TaskRecord): Promise<void>  // task.state === 'running', container exists (running or exited)
}
```

- [ ] **Step 1: Update `test/launcher.test.ts`**

Replace the `buildCommand` seam with `buildCommands`. Add this helper near the top (after the existing `fakeClaude` constant):

```ts
const shim = fileURLToPath(new URL('./fixtures/fake-docker.js', import.meta.url))

function shimCommands(home: string, scenario: string, name: string) {
  const d = (...a: string[]) => [process.execPath, shim, ...a]
  return {
    containerName: name,
    create: d('run', name, scenario),
    stream: d('logs', '-f', name),
    wait: d('wait', name),
    kill: d('stop', name),
    remove: d('rm', name),
    inspect: d('inspect', name),
  }
}
```

Each test sets `process.env.FAKE_DOCKER_HOME` to a fresh mkdtemp dir (the shim state dir; keep it separate from petree `home`), and converts:

- `buildCommand: () => [process.execPath, fakeClaude, 'ok']` → `buildCommands: (t) => shimCommands(dockerHome, 'ok', `petree-${t.id}`)` (same for `big-usage`, `crash`, `silent`, `slow`).
- The spawn-failure test (`['no-such-binary-petree']`) becomes a create failure: `buildCommands: (t) => ({ ...shimCommands(dockerHome, 'ok', `petree-${t.id}`), create: ['no-such-binary-petree'] })`.
- The two inline-script tests (commit capture, wreck-the-repo) keep their scripts but deliver them via the shim: set `process.env.FAKE_CONTAINER_EXEC = JSON.stringify([process.execPath, '-e', script])` before `launch(task)` and `delete` it after; `process.env.WD` continues to work because the detached wrapper inherits the environment.
- The follow-up two-turn test likewise switches scenario per turn via `FAKE_CONTAINER_EXEC`.

Add these new tests:

```ts
  it('persists startedAt and logOffset when launching', async () => {
    const { home, cfg, store, task } = setup()
    mkdirSync(join(home, 'logs'), { recursive: true })
    const dockerHome = mkdtempSync(join(tmpdir(), 'fdock-'))
    process.env.FAKE_DOCKER_HOME = dockerHome
    const launch = makeLauncher(cfg, store, {
      buildCommands: (t) => shimCommands(dockerHome, 'ok', `petree-${t.id}`),
    })
    await launch(task)
    const finished = store.get(task.id)!
    expect(finished.startedAt).toBeTruthy()
    expect(finished.logOffset).toBe(0)
  })

  it('removes the container after the run', async () => {
    const { home, cfg, store, task } = setup()
    mkdirSync(join(home, 'logs'), { recursive: true })
    const dockerHome = mkdtempSync(join(tmpdir(), 'fdock-'))
    process.env.FAKE_DOCKER_HOME = dockerHome
    const launch = makeLauncher(cfg, store, {
      buildCommands: (t) => shimCommands(dockerHome, 'ok', `petree-${t.id}`),
    })
    await launch(task)
    expect(existsSync(join(dockerHome, `petree-${task.id}.pid`))).toBe(false)
  })

  it('reattach on a live container finalizes the turn without double-counting', async () => {
    const { home, cfg, store, task } = setup()
    mkdirSync(join(home, 'logs'), { recursive: true })
    const dockerHome = mkdtempSync(join(tmpdir(), 'fdock-'))
    process.env.FAKE_DOCKER_HOME = dockerHome
    const name = `petree-${task.id}`
    // simulate the pre-restart server: container started, first 2 lines already
    // streamed into the petree log and their usage persisted
    execFileSync(process.execPath, [shim, 'run', name, 'slow'])
    store.transition(task.id, 'running')
    store.patch(task.id, { startedAt: new Date().toISOString(), logOffset: 0 })
    await new Promise((r) => setTimeout(r, 300)) // let init+usage lines land in the fake log
    const streamed = readFileSync(join(dockerHome, `${name}.log`), 'utf8')
    writeFileSync(join(home, 'logs', `${task.id}.log`), streamed, { mode: 0o600 })
    store.addUsage(task.id, 150)

    const launch = makeLauncher(cfg, store, {
      buildCommands: (t) => shimCommands(dockerHome, 'slow', `petree-${t.id}`),
    })
    await launch.reattach(store.get(task.id)!)

    const finished = store.get(task.id)!
    expect(finished.state).toBe('done')
    expect(finished.result).toBe('too late')
    expect(finished.tokensUsed).toBe(150)
    const log = readFileSync(join(home, 'logs', `${task.id}.log`), 'utf8')
    expect(log.match(/sess-123/g)).toHaveLength(1)
  })

  it('reattach on an exited container completes the turn and the commit capture', async () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-home-'))
    mkdirSync(join(home, 'logs'), { recursive: true })
    const cfg: PetreeConfig = {
      home,
      defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null, instructions: '' },
      repos: { demo: { url: `file://${makeFixtureRepo()}`, defaultBranch: 'main', image: 'sandbox-node', instructions: '', setup: [], build: [], test: [], skills: [], defaultModel: null } },
      allowClone: [],
    }
    const store = new TaskStore(join(home, 'petree.db'))
    const created = store.create({ prompt: 'edit the readme', repos: ['demo'], tokenBudget: 500000, timeoutMinutes: 30 })
    const dockerHome = mkdtempSync(join(tmpdir(), 'fdock-'))
    process.env.FAKE_DOCKER_HOME = dockerHome
    const name = `petree-${created.id}`
    const launch = makeLauncher(cfg, store, {
      buildCommands: (t) => shimCommands(dockerHome, 'ok', `petree-${t.id}`),
    })
    // first, provision the workspace via a normal launch so the repo exists
    const task = store.transition(created.id, 'provisioning')
    process.env.FAKE_CONTAINER_EXEC = JSON.stringify([process.execPath, '-e',
      `const fs=require('fs');fs.writeFileSync('${join(home, 'work', created.id, 'demo')}/offline.txt','x');` +
      `console.log(JSON.stringify({type:'result',subtype:'success',result:'offline done'}))`])
    try {
      // simulate: container ran to completion while the server was down
      store.transition(task.id, 'running')
      store.patch(task.id, { startedAt: new Date().toISOString(), logOffset: 0 })
      const { prepareWorkspace } = await import('../src/git.js')
      await prepareWorkspace(cfg, task.repos, join(home, 'work', task.id), task.id)
      execFileSync(process.execPath, [shim, 'run', name, 'ok'])
      execFileSync(process.execPath, [shim, 'wait', name])
      await launch.reattach(store.get(task.id)!)
    } finally {
      delete process.env.FAKE_CONTAINER_EXEC
    }
    const finished = store.get(task.id)!
    expect(finished.state).toBe('done')
    expect(finished.result).toBe('offline done')
    const repoDir = join(home, 'work', task.id, 'demo')
    const msg = execFileSync('git', ['-C', repoDir, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim()
    expect(msg).toContain(`petree ${task.id}`)
  })

  it('reattach clamps the timeout to the persisted turn start', async () => {
    const { home, cfg, store, task } = setup({ timeoutMinutes: 0.01 }) // 600ms
    mkdirSync(join(home, 'logs'), { recursive: true })
    const dockerHome = mkdtempSync(join(tmpdir(), 'fdock-'))
    process.env.FAKE_DOCKER_HOME = dockerHome
    const name = `petree-${task.id}`
    execFileSync(process.execPath, [shim, 'run', name, 'slow'])
    store.transition(task.id, 'running')
    store.patch(task.id, { startedAt: new Date(Date.now() - 60_000).toISOString(), logOffset: 0 })
    const launch = makeLauncher(cfg, store, {
      buildCommands: (t) => shimCommands(dockerHome, 'slow', `petree-${t.id}`),
    })
    await launch.reattach(store.get(task.id)!)
    expect(store.get(task.id)?.state).toBe('paused-limit')
    expect(store.get(task.id)?.error).toBe('timeout')
  })
```

Add the needed imports (`readFileSync`, `writeFileSync`, `execFileSync`, `fileURLToPath` are mostly present — extend as required).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/launcher.test.ts`
Expected: FAIL — `buildCommands` unknown option, `reattach` undefined.

- [ ] **Step 3: Rewrite `src/launcher.ts`**

```ts
import { execFile } from 'node:child_process'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PetreeConfig } from './config.js'
import { prepareWorkspace } from './git.js'
import { commitChanges } from './gitops.js'
import { CliRunner } from './runner.js'
import { buildSandboxCommands, readToken, type SandboxCommands } from './sandbox.js'
import type { TaskRecord, TaskStore } from './store.js'

export interface LauncherOptions {
  buildCommands?: (task: TaskRecord, workDir: string) => SandboxCommands
}

export interface Launcher {
  (task: TaskRecord): Promise<void>
  // Kills the task's in-flight container (or, if it's still cloning/provisioning
  // with no container yet, marks it so launch() cancels before creating one).
  // Resolves true once a stop was actioned, false if there was nothing to stop.
  stop(id: string): Promise<boolean>
  // Re-attach to a task whose container survived a server restart (still
  // running, or exited while petree was down); replays missed output and
  // finalizes the turn normally. task.state must already be 'running'.
  reattach(task: TaskRecord): Promise<void>
}

function runCommand(command: string[]): Promise<void> {
  return new Promise((resolve) => {
    const [cmd, ...args] = command
    execFile(cmd, args, () => resolve())
  })
}

// Lines already written to the task log for this turn (i.e. after the byte
// offset recorded at container launch) — the runner skips that many stream
// lines when replaying `docker logs` from the start.
function countLinesFrom(file: string, offset: number): number {
  if (!existsSync(file)) return 0
  const size = statSync(file).size
  if (size <= offset) return 0
  const fd = openSync(file, 'r')
  const buf = Buffer.alloc(size - offset)
  readSync(fd, buf, 0, buf.length, offset)
  closeSync(fd)
  let n = 0
  for (const b of buf) if (b === 10) n++
  return n
}

export function makeLauncher(cfg: PetreeConfig, store: TaskStore, opts: LauncherOptions = {}): Launcher {
  const buildCommands =
    opts.buildCommands ??
    ((task: TaskRecord, workDir: string) => buildSandboxCommands(task, cfg, workDir, readToken(cfg.home)))

  const runners = new Map<string, CliRunner>()
  const cancelled = new Set<string>()

  // Shared turn body: stream events into the store and the log file, reconcile
  // a run that ended without a terminal event, capture commits, and remove the
  // (detached) container once the turn is finalized.
  const runTurn = async (task: TaskRecord, runner: CliRunner, logFile: string, workDir: string, commands: SandboxCommands): Promise<void> => {
    runners.set(task.id, runner)

    // Recorded so a later failure — either a log-stream error or a swallowed
    // store-transition race — can be surfaced by the post-run reconciliation below,
    // instead of being silently lost.
    let storeError: string | undefined
    const logStream = createWriteStream(logFile, { flags: 'a', mode: 0o600 })
    logStream.on('error', (err) => {
      storeError = err.message
    })

    const safely = (fn: () => void) => {
      try {
        fn()
      } catch (err) {
        // event arrived after a terminal transition (or another store race); don't
        // throw out of the event handler, but remember it for reconciliation.
        storeError = String(err)
      }
    }

    await new Promise<void>((resolve) => {
      runner.on('event', (e) => {
        if (e.type === 'log') logStream.write(e.line + '\n')
        else if (e.type === 'session') safely(() => store.patch(task.id, { sessionId: e.sessionId }))
        else if (e.type === 'usage') safely(() => store.addUsage(task.id, e.tokens))
        else if (e.type === 'done') safely(() => { store.setResult(task.id, e.result); store.transition(task.id, 'done') })
        else if (e.type === 'limit') safely(() => store.transition(task.id, 'paused-limit', { error: e.reason }))
        else if (e.type === 'error') safely(() => store.transition(task.id, 'failed', { error: e.message }))
      })
      runner.on('closed', resolve)
      runner.start()
    })
    runners.delete(task.id)

    await new Promise<void>((resolve) => logStream.end(resolve))

    // The container can exit cleanly (code 0) without ever emitting a 'done' or
    // 'error' stream event (e.g. it printed nothing parseable as a result, or was
    // killed via stop()). Left unchecked the task would sit in 'running'/
    // 'provisioning' forever, permanently occupying a scheduler concurrency slot.
    const finished = store.get(task.id)
    if (finished && (finished.state === 'running' || finished.state === 'provisioning')) {
      if (cancelled.delete(task.id)) {
        safely(() => store.transition(task.id, 'cancelled'))
      } else {
        const error = storeError
          ? `run ended without terminal event; store error: ${storeError}`
          : 'run ended without terminal event'
        safely(() => store.transition(task.id, 'failed', { error }))
      }
    } else {
      cancelled.delete(task.id)
    }

    // Capture any file changes the agent made as a commit on the task branch,
    // per repo, on the host. Investigation tasks that changed nothing get no commit.
    const firstLine = task.prompt.split('\n')[0].slice(0, 72)
    const commitErrors: string[] = []
    for (const repo of task.repos) {
      try {
        commitChanges(join(workDir, repo), task.id, `petree ${task.id}: ${firstLine}`)
      } catch (err) {
        commitErrors.push(`commit failed for ${repo}: ${String(err)}`)
      }
    }
    // The task is already in a terminal state by now (done/failed/paused), so this
    // can't go through transition() — patch the error field directly, appending to
    // whatever's already there rather than clobbering it.
    if (commitErrors.length) {
      const current = store.get(task.id)
      const combined = [current?.error, ...commitErrors].filter(Boolean).join('; ')
      safely(() => store.patch(task.id, { error: combined }))
    }

    // The turn is finalized — the detached container is no longer needed.
    await runCommand(commands.remove)
  }

  const launch = async function launch(task: TaskRecord): Promise<void> {
    const workDir = join(cfg.home, 'work', task.id)
    const logFile = join(cfg.home, 'logs', `${task.id}.log`)
    mkdirSync(join(cfg.home, 'logs'), { recursive: true })
    mkdirSync(join(cfg.home, 'sessions', task.id), { recursive: true })

    if (cancelled.delete(task.id)) {
      store.transition(task.id, 'cancelled')
      return
    }

    await prepareWorkspace(cfg, task.repos, workDir, task.id)

    if (cancelled.delete(task.id)) {
      store.transition(task.id, 'cancelled')
      return
    }

    const commands = buildCommands(task, workDir)
    // A stale container from an interrupted previous turn may still hold the name.
    await runCommand(commands.remove)

    const logOffset = existsSync(logFile) ? statSync(logFile).size : 0
    store.patch(task.id, { logOffset, startedAt: new Date().toISOString() })

    const runner = new CliRunner({
      commands: { create: commands.create, stream: commands.stream, wait: commands.wait, kill: commands.kill },
      timeoutMs: task.timeoutMinutes * 60_000,
      tokenBudget: task.tokenBudget,
      alreadyUsed: task.tokensUsed,
    })
    store.transition(task.id, 'running')
    await runTurn(task, runner, logFile, workDir, commands)
  } as Launcher

  launch.reattach = async (task: TaskRecord): Promise<void> => {
    const workDir = join(cfg.home, 'work', task.id)
    const logFile = join(cfg.home, 'logs', `${task.id}.log`)
    const commands = buildCommands(task, workDir)
    const skipLines = countLinesFrom(logFile, task.logOffset)
    const elapsed = Date.now() - Date.parse(task.startedAt ?? task.updatedAt)
    const remaining = Math.max(0, task.timeoutMinutes * 60_000 - elapsed)
    const runner = new CliRunner({
      // no create: the container already exists (running, or exited while we were down)
      commands: { stream: commands.stream, wait: commands.wait, kill: commands.kill },
      timeoutMs: remaining,
      tokenBudget: task.tokenBudget,
      alreadyUsed: task.tokensUsed,
      skipLines,
    })
    // task is already 'running' — no transition here.
    await runTurn(task, runner, logFile, workDir, commands)
  }

  launch.stop = async (id: string): Promise<boolean> => {
    const runner = runners.get(id)
    if (runner) {
      cancelled.add(id)
      await runner.stop()
      return true
    }
    // No container yet (still cloning in prepareWorkspace, or queued and not yet
    // picked up) — mark it so launch() cancels at its next check instead of
    // creating one.
    if (store.get(id)?.state === 'provisioning') {
      cancelled.add(id)
      return true
    }
    return false
  }

  return launch
}
```

Also delete `buildDockerCommand` from `src/sandbox.ts` and any leftover tests referencing it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/launcher.test.ts test/sandbox.test.ts && npm run typecheck`
Expected: PASS, typecheck fully green again.

- [ ] **Step 5: Commit**

```bash
git add src/launcher.ts src/sandbox.ts test/launcher.test.ts test/sandbox.test.ts
git commit -m "feat(launcher): detached containers, reattach with replay, offsets and cleanup"
```

---

### Task 6: recover() startup pass + index wiring

**Files:**
- Create: `src/recover.ts`
- Modify: `src/index.ts`
- Test: `test/recover.test.ts`

**Interfaces:**
- Consumes: `TaskStore.recoveryRequeue` (Task 1), `Launcher.reattach` (Task 5), `ContainerState`/`inspectContainerState`/`containerName` (Task 2).
- Produces:

```ts
export interface RecoverOptions {
  inspect: (task: TaskRecord) => Promise<ContainerState>
}
export async function recover(store: TaskStore, launcher: Launcher, opts: RecoverOptions): Promise<void>
```

- [ ] **Step 1: Write the failing tests**

`test/recover.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { Launcher } from '../src/launcher.js'
import { recover } from '../src/recover.js'
import { TaskStore, type TaskRecord } from '../src/store.js'
import type { ContainerState } from '../src/sandbox.js'

const input = { prompt: 'p', repos: ['demo'], tokenBudget: 1000, timeoutMinutes: 30 }

function makeStore(): TaskStore {
  return new TaskStore(join(mkdtempSync(join(tmpdir(), 'petree-recover-')), 'db'))
}

function fakeLauncher(behavior: (t: TaskRecord) => Promise<void> = async () => {}): Launcher & { reattached: string[] } {
  const reattached: string[] = []
  const l = (async () => {}) as unknown as Launcher & { reattached: string[] }
  l.stop = async () => false
  l.reattach = async (t: TaskRecord) => { reattached.push(t.id); return behavior(t) }
  l.reattached = reattached
  return l
}

describe('recover', () => {
  it('re-attaches running tasks whose container is running or exited', async () => {
    const store = makeStore()
    const a = store.create(input); store.transition(a.id, 'provisioning'); store.transition(a.id, 'running')
    const b = store.create(input); store.transition(b.id, 'provisioning'); store.transition(b.id, 'running')
    const states: Record<string, ContainerState> = { [a.id]: 'running', [b.id]: 'exited' }
    const launcher = fakeLauncher()
    await recover(store, launcher, { inspect: async (t) => states[t.id] })
    expect(launcher.reattached.sort()).toEqual([a.id, b.id].sort())
    expect(store.get(a.id)?.state).toBe('running')
  })

  it('requeues with backoff when the container is absent', async () => {
    const store = makeStore()
    const t = store.create(input); store.transition(t.id, 'provisioning'); store.transition(t.id, 'running')
    const launcher = fakeLauncher()
    await recover(store, launcher, { inspect: async () => 'absent' })
    const r = store.get(t.id)!
    expect(r.state).toBe('queued')
    expect(r.restarts).toBe(1)
    expect(r.retryAt).toBeTruthy()
    expect(launcher.reattached).toEqual([])
  })

  it('requeues provisioning tasks without inspecting', async () => {
    const store = makeStore()
    const t = store.create(input); store.transition(t.id, 'provisioning')
    let inspected = 0
    await recover(store, fakeLauncher(), { inspect: async () => { inspected++; return 'running' } })
    expect(store.get(t.id)?.state).toBe('queued')
    expect(inspected).toBe(0)
  })

  it('fails the task when reattach rejects', async () => {
    const store = makeStore()
    const t = store.create(input); store.transition(t.id, 'provisioning'); store.transition(t.id, 'running')
    const launcher = fakeLauncher(async () => { throw new Error('boom') })
    await recover(store, launcher, { inspect: async () => 'running' })
    await new Promise((r) => setTimeout(r, 20))
    expect(store.get(t.id)?.state).toBe('failed')
    expect(store.get(t.id)?.error).toMatch(/re-attach failed.*boom/)
  })

  it('leaves tasks in other states untouched', async () => {
    const store = makeStore()
    const q = store.create(input)
    const d = store.create(input); store.transition(d.id, 'provisioning'); store.transition(d.id, 'running'); store.transition(d.id, 'done')
    let inspected = 0
    await recover(store, fakeLauncher(), { inspect: async () => { inspected++; return 'running' } })
    expect(inspected).toBe(0)
    expect(store.get(q.id)?.state).toBe('queued')
    expect(store.get(d.id)?.state).toBe('done')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/recover.test.ts`
Expected: FAIL — cannot resolve `../src/recover.js`.

- [ ] **Step 3: Implement `src/recover.ts`**

```ts
import type { Launcher } from './launcher.js'
import type { ContainerState } from './sandbox.js'
import type { TaskRecord, TaskStore } from './store.js'

export interface RecoverOptions {
  inspect: (task: TaskRecord) => Promise<ContainerState>
}

// One-shot startup pass: every task a previous server process left in
// 'running' or 'provisioning' is either re-attached to its surviving container
// or requeued (with backoff) to continue via --resume. Re-attaches run in the
// background; recover() resolves once every orphan has been dispatched.
export async function recover(store: TaskStore, launcher: Launcher, opts: RecoverOptions): Promise<void> {
  for (const t of store.list()) {
    if (t.state === 'provisioning') {
      // The container is only created after the transition to 'running', so a
      // provisioning task never has one; workspace prep is idempotent.
      store.recoveryRequeue(t.id)
      continue
    }
    if (t.state !== 'running') continue
    const state = await opts.inspect(t)
    if (state === 'absent') {
      store.recoveryRequeue(t.id)
      continue
    }
    void launcher.reattach(t).catch((err) => {
      try {
        store.transition(t.id, 'failed', { error: `re-attach failed: ${String(err)}` })
      } catch {
        // task already reached a terminal state; nothing to record
      }
    })
  }
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

```ts
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { makeLauncher } from './launcher.js'
import { recover } from './recover.js'
import { inspectContainerState, containerName } from './sandbox.js'
import { Scheduler } from './scheduler.js'
import { makeApp } from './server.js'
import { TaskStore } from './store.js'

const cfg = loadConfig()
for (const dir of ['logs', 'work', 'shared/skills', 'shared/findings']) {
  mkdirSync(join(cfg.home, dir), { recursive: true })
}
const store = new TaskStore(join(cfg.home, 'petree.db'))
const launcher = makeLauncher(cfg, store)
const scheduler = new Scheduler(store, cfg.defaults.concurrency, launcher)

// Re-attach to (or requeue) turns orphaned by the previous server process
// before the scheduler starts filling concurrency slots.
void recover(store, launcher, {
  inspect: (t) => inspectContainerState(['docker', 'inspect', '-f', '{{.State.Status}}', containerName(t.id)]),
}).then(() => {
  setInterval(() => void scheduler.tick(), 2000)
})

const app = makeApp(cfg, store, scheduler, launcher)
const port = Number(process.env.PORT ?? 4100)
// 127.0.0.1 explicitly: the API is unauthenticated and must never bind the LAN
app.listen(port, '127.0.0.1', () => {
  console.log(`petree dashboard: http://localhost:${port}`)
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/recover.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/recover.ts src/index.ts test/recover.test.ts
git commit -m "feat: startup recovery pass re-attaches or requeues orphaned tasks"
```

---

### Task 7: End-to-end restart tests + full sweep

**Files:**
- Create: `test/restart.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6 (real `TaskStore`, `makeLauncher`, `recover`, shim).

- [ ] **Step 1: Write the integration tests**

`test/restart.test.ts` (reuse `makeFixtureRepo` pattern from `test/launcher.test.ts`):

```ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import { prepareWorkspace } from '../src/git.js'
import { makeLauncher } from '../src/launcher.js'
import { recover } from '../src/recover.js'
import { inspectContainerState } from '../src/sandbox.js'
import { TaskStore } from '../src/store.js'

const shim = fileURLToPath(new URL('./fixtures/fake-docker.js', import.meta.url))

function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'petree-fixture-'))
  execFileSync('git', ['init', '-b', 'main', dir])
  writeFileSync(join(dir, 'README.md'), 'hello')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'])
  return dir
}

function shimCommands(scenario: string) {
  return (t: { id: string }) => {
    const name = `petree-${t.id}`
    const d = (...a: string[]) => [process.execPath, shim, ...a]
    return {
      containerName: name,
      create: d('run', name, scenario),
      stream: d('logs', '-f', name),
      wait: d('wait', name),
      kill: d('stop', name),
      remove: d('rm', name),
      inspect: d('inspect', name),
    }
  }
}

const until = async (cond: () => boolean, ms = 10_000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'petree-home-'))
  mkdirSync(join(home, 'logs'), { recursive: true })
  const dockerHome = mkdtempSync(join(tmpdir(), 'fdock-'))
  process.env.FAKE_DOCKER_HOME = dockerHome
  const cfg: PetreeConfig = {
    home,
    defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null, instructions: '' },
    repos: { demo: { url: `file://${makeFixtureRepo()}`, defaultBranch: 'main', image: 'sandbox-node', instructions: '', setup: [], build: [], test: [], skills: [], defaultModel: null } },
    allowClone: [],
  }
  const store = new TaskStore(join(home, 'petree.db'))
  return { home, dockerHome, cfg, store }
}

describe('restart survival (end to end, fake docker)', () => {
  it('a turn that finished while the server was down completes on recover', async () => {
    const { home, cfg, store } = setup()
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 500000, timeoutMinutes: 30 })
    store.transition(t.id, 'provisioning')
    await prepareWorkspace(cfg, t.repos, join(home, 'work', t.id), t.id)
    store.transition(t.id, 'running')
    store.patch(t.id, { startedAt: new Date().toISOString(), logOffset: 0 })
    execFileSync(process.execPath, [shim, 'run', `petree-${t.id}`, 'ok'])
    execFileSync(process.execPath, [shim, 'wait', `petree-${t.id}`])

    // "restart": fresh store handle + fresh launcher + recover
    const store2 = new TaskStore(join(home, 'petree.db'))
    const launcher = makeLauncher(cfg, store2, { buildCommands: shimCommands('ok') })
    await recover(store2, launcher, {
      inspect: (task) => inspectContainerState([process.execPath, shim, 'inspect', `petree-${task.id}`]),
    })
    await until(() => store2.get(t.id)?.state === 'done')
    const done = store2.get(t.id)!
    expect(done.result).toBe('all tests pass')
    expect(done.tokensUsed).toBe(150)
  })

  it('a mid-flight turn continues after restart without duplicate tokens or log lines', async () => {
    const { home, dockerHome, cfg, store } = setup()
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 500000, timeoutMinutes: 30 })
    store.transition(t.id, 'provisioning')
    await prepareWorkspace(cfg, t.repos, join(home, 'work', t.id), t.id)
    store.transition(t.id, 'running')
    store.patch(t.id, { startedAt: new Date().toISOString(), logOffset: 0 })
    execFileSync(process.execPath, [shim, 'run', `petree-${t.id}`, 'slow'])
    // pre-restart server streamed the first lines and persisted their usage
    await until(() => {
      try { return readFileSync(join(dockerHome, `petree-${t.id}.log`), 'utf8').includes('m1') } catch { return false }
    })
    writeFileSync(join(home, 'logs', `${t.id}.log`), readFileSync(join(dockerHome, `petree-${t.id}.log`)))
    store.addUsage(t.id, 150)

    const store2 = new TaskStore(join(home, 'petree.db'))
    const launcher = makeLauncher(cfg, store2, { buildCommands: shimCommands('slow') })
    await recover(store2, launcher, {
      inspect: (task) => inspectContainerState([process.execPath, shim, 'inspect', `petree-${task.id}`]),
    })
    await until(() => store2.get(t.id)?.state === 'done')
    const done = store2.get(t.id)!
    expect(done.result).toBe('too late')
    expect(done.tokensUsed).toBe(150)
    const log = readFileSync(join(home, 'logs', `${t.id}.log`), 'utf8')
    expect(log.match(/sess-123/g)).toHaveLength(1)
    expect(log.match(/too late/g)).toHaveLength(1)
  })

  it('a vanished container requeues with backoff and relaunches later', async () => {
    const { home, cfg, store } = setup()
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 500000, timeoutMinutes: 30 })
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')

    const store2 = new TaskStore(join(home, 'petree.db'))
    const launcher = makeLauncher(cfg, store2, { buildCommands: shimCommands('ok') })
    await recover(store2, launcher, {
      inspect: (task) => inspectContainerState([process.execPath, shim, 'inspect', `petree-${task.id}`]),
    })
    const r = store2.get(t.id)!
    expect(r.state).toBe('queued')
    expect(r.restarts).toBe(1)
    // gated now, eligible after the 30s backoff
    expect(store2.nextQueued(new Date())).toBeUndefined()
    expect(store2.nextQueued(new Date(Date.now() + 31_000))?.id).toBe(t.id)
  })
})
```

- [ ] **Step 2: Run the new tests**

Run: `npx vitest run test/restart.test.ts`
Expected: PASS. If the mid-flight test flakes on line counts, the `until(...m1...)` guard isn’t waiting for both init and usage lines — tighten the condition, not the assertion.

- [ ] **Step 3: Full sweep**

Run: `npm test && npm run typecheck`
Expected: entire suite green (including server/scheduler/store/gitops tests untouched by this plan).

- [ ] **Step 4: Commit**

```bash
git add test/restart.test.ts
git commit -m "test: end-to-end restart survival against the fake docker daemon"
```

---

## Verification checklist (after all tasks)

- `npm test` and `npm run typecheck` fully green.
- Manual smoke (optional, needs real docker + sandbox-node image): start a task, `kill` the petree server mid-turn, `docker ps` shows `petree-<id>` still running, restart the server, dashboard shows the task still `running`, turn finishes `done`, `docker ps -a` no longer lists the container.
- The stuck row from the original incident (`deb92764`) is NOT auto-fixed by this work (it predates the new columns and its container is gone; its state is `running` which `recover()` will now requeue on the next server start — that is the desired outcome).
