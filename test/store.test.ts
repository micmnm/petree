import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { TaskStore, canMoveStage, threadTitle, RESUMABLE_STATES, FOLLOWUP_STATES } from '../src/store.js'

let store: TaskStore
beforeEach(() => {
  store = new TaskStore(join(mkdtempSync(join(tmpdir(), 'petree-db-')), 'petree.db'))
})

const DAY = 24 * 60 * 60 * 1000
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

  it('allows cancelling a running task and resuming it afterward', () => {
    const t = store.create(input)
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    const cancelled = store.transition(t.id, 'cancelled')
    expect(cancelled.state).toBe('cancelled')
    expect(store.transition(t.id, 'queued').state).toBe('queued')
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

  it('patch can set error directly on a terminal task without a transition', () => {
    const t = store.create(input)
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.transition(t.id, 'done')
    const patched = store.patch(t.id, { error: 'commit failed for demo: boom' })
    expect(patched.state).toBe('done')
    expect(patched.error).toBe('commit failed for demo: boom')
    // patch without touching error preserves the existing value
    store.patch(t.id, { sessionId: 'sess-2' })
    expect(store.get(t.id)?.error).toBe('commit failed for demo: boom')
  })

  it('counts by state and pops queued FIFO', () => {
    const a = store.create(input)
    store.create(input)
    expect(store.countByState('queued')).toBe(2)
    expect(store.nextQueued()?.id).toBe(a.id)
  })
})

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

describe('TaskStore retention settings & prune', () => {
  function finish(s: TaskStore, id: string): void {
    s.transition(id, 'provisioning')
    s.transition(id, 'running')
    s.transition(id, 'done')
  }
  function backdate(file: string, id: string, daysAgo: number): void {
    const raw = new Database(file)
    const iso = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
    raw.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(iso, id)
    raw.close()
  }

  function backdateBin(file: string, id: string, daysAgo: number): void {
    const raw = new Database(file)
    raw.prepare('UPDATE tasks SET binned_at = ? WHERE id = ?').run(new Date(Date.now() - daysAgo * DAY).toISOString(), id)
    raw.close()
  }

  it('defaults to 14 / 3 days and persists updates', () => {
    expect(store.getSettings()).toEqual({ binDays: 14, hallOfFameDays: 3 })
    expect(store.updateSettings({ binDays: 7 })).toEqual({ binDays: 7, hallOfFameDays: 3 })
    expect(store.updateSettings({ hallOfFameDays: 10 })).toEqual({ binDays: 7, hallOfFameDays: 10 })
  })

  it('sweeps game-over after binDays and hall-of-fame after hallOfFameDays, never deleting rows', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'petree-sweep-')), 'db')
    const s = new TaskStore(file)
    const mk = (kind: 'game-over' | 'hall-of-fame', daysAgo: number) => {
      const t = s.create(input)
      finish(s, t.id)
      s.bin(t.id, kind, 'r')
      backdateBin(file, t.id, daysAgo)
      return t.id
    }
    const goOld = mk('game-over', 15), goNew = mk('game-over', 13)
    const hofOld = mk('hall-of-fame', 4), hofNew = mk('hall-of-fame', 2)
    const unbinned = s.create(input)
    finish(s, unbinned.id)
    backdate(file, unbinned.id, 30)

    expect(s.sweep()).toBe(2)
    expect([goOld, goNew, hofOld, hofNew, unbinned.id].map((id) => !!s.get(id)!.archivedAt))
      .toEqual([true, false, true, false, false])
    expect(s.list()).toHaveLength(5)
    expect(s.sweep()).toBe(0)
  })

  it('archived threads cannot be restored', () => {
    const t = store.create(input)
    finish(store, t.id)
    store.bin(t.id, 'game-over', 'dropped by you')
    store.updateSettings({ binDays: 1 })
    expect(store.sweep(new Date(Date.now() + 2 * DAY))).toBe(1)
    expect(() => store.restore(t.id)).toThrow()
  })
})

describe('TaskStore bins and identity', () => {
  const toRunning = (id: string) => { store.transition(id, 'provisioning'); store.transition(id, 'running') }

  it('bin/unbin set and clear the bin fields', () => {
    const t = store.create(input)
    const b = store.bin(t.id, 'hall-of-fame', 'finished · findings kept')
    expect(b).toMatchObject({ bin: 'hall-of-fame', binReason: 'finished · findings kept' })
    expect(b.binnedAt).toBeTruthy()
    expect(store.unbin(t.id)).toMatchObject({ bin: null, binReason: null, binnedAt: null })
  })

  it('transition into paused-limit bins game-over "out of tokens"; failed is not binned', () => {
    const t = store.create(input)
    toRunning(t.id)
    expect(store.transition(t.id, 'paused-limit')).toMatchObject({ bin: 'game-over', binReason: 'out of tokens' })
    const f = store.create(input)
    toRunning(f.id)
    expect(store.transition(f.id, 'failed', { error: 'x' }).bin).toBeNull()
  })

  it('restore: paused-limit resets tokens and requeues; other states only unbin', () => {
    const t = store.create(input)
    toRunning(t.id)
    store.addUsage(t.id, 900)
    store.transition(t.id, 'paused-limit')
    expect(store.restore(t.id)).toMatchObject({ state: 'queued', tokensUsed: 0, bin: null })

    const g = store.create(input)
    toRunning(g.id)
    store.transition(g.id, 'waiting-for-you')
    store.bin(g.id, 'game-over', 'dropped by you')
    expect(store.restore(g.id)).toMatchObject({ state: 'waiting-for-you', bin: null })
  })

  it('binned threads refuse followUp and resume until restored', () => {
    const t = store.create(input)
    toRunning(t.id)
    store.transition(t.id, 'failed', { error: 'x' })
    store.bin(t.id, 'game-over', 'dropped by you')
    expect(() => store.followUp(t.id, 'more')).toThrow(/restore first/)
    expect(() => store.resume(t.id)).toThrow(/restore first/)
    store.restore(t.id)
    expect(store.resume(t.id).state).toBe('queued')
  })

  it('restore forgets a closed PR so the card offers it again', () => {
    const t = store.create(input)
    toRunning(t.id)
    store.transition(t.id, 'done')
    store.setDelivery(t.id, 'demo', { ahead: 1, head: 'h', target: 'f', url: 'u', number: 3, pr: 'closed', prHead: 'h' })
    store.bin(t.id, 'game-over', 'PR closed without merge')
    expect(store.restore(t.id).delivery.demo).toEqual({ ahead: 1, head: 'h', number: 3 })
  })

  it('sweep leaves a binned thread that is not settled', () => {
    const t = store.create(input)
    store.bin(t.id, 'game-over', 'dropped by you')
    store.updateSettings({ binDays: 1 })
    expect(store.sweep(new Date(Date.now() + 2 * DAY))).toBe(0)
  })

  it('a failed upgrade commits nothing, so the next open still backfills', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'petree-mig-')), 'db')
    const raw = new Database(file)
    raw.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, repos TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'unattended', state TEXT NOT NULL,
      session_id TEXT, tokens_used INTEGER NOT NULL DEFAULT 0,
      token_budget INTEGER NOT NULL, timeout_minutes INTEGER NOT NULL,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result TEXT, model TEXT)`)
    raw.prepare(`INSERT INTO tasks (id,prompt,repos,state,token_budget,timeout_minutes,created_at,updated_at)
      VALUES ('a', 'p', '["demo"]', 'done', 1, 1, 't', 't')`).run()
    raw.exec("CREATE TRIGGER boom BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'boom'); END")
    raw.close()
    expect(() => new TaskStore(file)).toThrow(/boom/)
    const fix = new Database(file)
    fix.exec('DROP TRIGGER boom')
    fix.close()
    expect(new TaskStore(file).get('a')!.seq).toBe(1)
  })

  it('restore refuses unbinned and hall-of-fame threads', () => {
    const t = store.create(input)
    expect(() => store.restore(t.id)).toThrow()
    store.bin(t.id, 'hall-of-fame', 'r')
    expect(() => store.restore(t.id)).toThrow()
  })

  it('assigns unique increasing seq at create', () => {
    const seqs = [store.create(input), store.create(input), store.create(input)].map((t) => t.seq)
    expect(seqs).toEqual([1, 2, 3])
  })

  it('migration backfills seq by created_at and applies the upgrade rule', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'petree-mig-')), 'db')
    const raw = new Database(file)
    raw.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, repos TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'unattended', state TEXT NOT NULL,
      session_id TEXT, tokens_used INTEGER NOT NULL DEFAULT 0,
      token_budget INTEGER NOT NULL, timeout_minutes INTEGER NOT NULL,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result TEXT, model TEXT)`)
    const ins = raw.prepare(`INSERT INTO tasks (id,prompt,repos,state,token_budget,timeout_minutes,created_at,updated_at)
      VALUES (?, 'p', '["demo"]', ?, 1, 1, ?, ?)`)
    const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString()
    ins.run('b', 'done', ago(10), ago(10))
    ins.run('a', 'failed', ago(20), ago(20))
    ins.run('c', 'cancelled', ago(2), ago(1))
    ins.run('d', 'failed', ago(2), ago(1))
    ins.run('e', 'paused-limit', ago(2), ago(1))
    raw.close()

    const s = new TaskStore(file)
    expect(['a', 'b', 'c', 'd', 'e'].map((id) => s.get(id)!.seq)).toEqual([1, 2, 3, 4, 5])
    expect(s.get('a')!.archivedAt).toBeTruthy()
    expect(s.get('b')!.archivedAt).toBeTruthy()
    expect(s.get('c')).toMatchObject({ bin: 'game-over', binReason: 'dropped by you', archivedAt: null })
    expect(s.get('d')).toMatchObject({ bin: null, archivedAt: null })
    expect(s.get('e')).toMatchObject({ bin: 'game-over', binReason: 'out of tokens' })
    expect(s.create(input).seq).toBe(6)
    // a second open must not re-run the one-off upgrade
    expect(new TaskStore(file).get('d')).toMatchObject({ bin: null })
  })
})

describe('restart recovery', () => {
  function toRunning(s: TaskStore, id: string) {
    s.transition(id, 'provisioning')
    s.transition(id, 'running')
  }

  it('new tasks default restarts 0, no retryAt, no startedAt, logOffset 0', () => {
    const t = store.create(input)
    expect(t.restarts).toBe(0)
    expect(t.retryAt).toBeNull()
    expect(t.startedAt).toBeNull()
    expect(t.logOffset).toBe(0)
  })

  it('patch persists startedAt and logOffset', () => {
    const t = store.create(input)
    const patched = store.patch(t.id, { startedAt: '2026-08-03T10:00:00.000Z', logOffset: 4096 })
    expect(patched.startedAt).toBe('2026-08-03T10:00:00.000Z')
    expect(patched.logOffset).toBe(4096)
  })

  it('recoveryRequeue from running: queued, restarts 1, retryAt ~now+30s', () => {
    const t = store.create(input)
    toRunning(store, t.id)
    const now = new Date('2026-08-03T10:00:00.000Z')
    const r = store.recoveryRequeue(t.id, now)
    expect(r.state).toBe('queued')
    expect(r.restarts).toBe(1)
    expect(r.retryAt).toBe('2026-08-03T10:00:30.000Z')
  })

  it('backoff grows 30s, 2m, 8m and caps at 15m', () => {
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
    const t = store.create(input)
    store.transition(t.id, 'provisioning')
    expect(store.recoveryRequeue(t.id).state).toBe('queued')
    expect(() => store.recoveryRequeue(t.id)).toThrow(/cannot recovery-requeue/)
  })

  it('nextQueued skips tasks whose retryAt is in the future', () => {
    const t = store.create(input)
    toRunning(store, t.id)
    const now = new Date('2026-08-03T10:00:00.000Z')
    store.recoveryRequeue(t.id, now)
    expect(store.nextQueued(new Date('2026-08-03T10:00:10.000Z'))).toBeUndefined()
    expect(store.nextQueued(new Date('2026-08-03T10:00:31.000Z'))?.id).toBe(t.id)
  })

  it('a turn ending normally resets restarts and retryAt', () => {
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

  it('followUp clears the previous turn error', () => {
    const t = store.create(input)
    toRunning(store, t.id)
    store.transition(t.id, 'waiting-for-you', { error: 'investigate turn changed files in demo' })
    expect(store.get(t.id)?.error).toContain('changed files')
    expect(store.followUp(t.id, 'next').error).toBeNull()
  })
})

describe('threads', () => {
  function waiting(): string {
    const t = store.create(input)
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.transition(t.id, 'waiting-for-you')
    return t.id
  }

  it('creates tasks at the investigate stage with no comments', () => {
    const t = store.create(input)
    expect(t.stage).toBe('investigate')
    expect(t.comments).toEqual([])
    expect(store.create({ ...input, stage: 'build' }).stage).toBe('build')
  })

  it('reads rows from a pre-threads database as build with no comments', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'petree-db-')), 'old.db')
    const old = new Database(file)
    old.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, repos TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'unattended', state TEXT NOT NULL,
      session_id TEXT, tokens_used INTEGER NOT NULL DEFAULT 0,
      token_budget INTEGER NOT NULL, timeout_minutes INTEGER NOT NULL,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result TEXT, model TEXT)`)
    old.prepare(`INSERT INTO tasks (id, prompt, repos, state, token_budget, timeout_minutes, created_at, updated_at)
      VALUES ('old1', 'p', '["demo"]', 'done', 1, 1, 'x', 'x')`).run()
    old.close()
    const t = new TaskStore(file).get('old1')!
    expect(t.stage).toBe('build')
    expect(t.comments).toEqual([])
  })

  it('adds the delivery column to an old database and merges per-repo entries', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'petree-db-')), 'old.db')
    const old = new Database(file)
    old.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, repos TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'unattended', state TEXT NOT NULL,
      session_id TEXT, tokens_used INTEGER NOT NULL DEFAULT 0,
      token_budget INTEGER NOT NULL, timeout_minutes INTEGER NOT NULL,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result TEXT, model TEXT)`)
    old.prepare(`INSERT INTO tasks (id, prompt, repos, state, token_budget, timeout_minutes, created_at, updated_at)
      VALUES ('old1', 'p', '["a","b"]', 'done', 1, 1, 'x', 'x')`).run()
    old.close()
    const s = new TaskStore(file)
    expect(s.get('old1')!.delivery).toEqual({})
    s.setDelivery('old1', 'a', { ahead: 1, head: 'h1' })
    s.setDelivery('old1', 'b', { ahead: 0, head: 'h2' })
    const t = s.setDelivery('old1', 'a', { target: 'feat', pr: 'open' })
    expect(t.delivery).toEqual({ a: { ahead: 1, head: 'h1', target: 'feat', pr: 'open' }, b: { ahead: 0, head: 'h2' } })
  })

  it('setDelivery moves updated_at only when something changed', async () => {
    const t = store.create(input)
    const a = store.setDelivery(t.id, 'demo', { ahead: 1, head: 'h' })
    await new Promise((r) => setTimeout(r, 5))
    const b = store.setDelivery(t.id, 'demo', { ahead: 1, head: 'h' })
    expect(b.updatedAt).toBe(a.updatedAt)
    expect(() => store.setDelivery('nope', 'demo', {})).toThrow()
  })

  it('addComment keeps state and prompt', () => {
    const t = store.create(input)
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    const c = store.addComment(t.id, 'hey')
    expect(c.state).toBe('running')
    expect(c.prompt).toBe('do it')
    expect(c.comments).toHaveLength(1)
    expect(c.comments[0]).toMatchObject({ text: 'hey', consumed: false })
  })

  it('followUp folds pending comments into the prompt, consumes them and advances the stage', () => {
    const id = waiting()
    store.addComment(id, 'c1')
    store.addComment(id, 'c2')
    const f = store.followUp(id, 'more', undefined, 'spec')
    expect(f.prompt).toBe('more\n\n## Comments from the user since the last turn\n\n- c1\n- c2')
    expect(f.comments.map((c) => c.consumed)).toEqual([true, true])
    expect(f.stage).toBe('spec')
    expect(f.state).toBe('queued')
    expect(f.turns.at(-1)?.stage).toBe('investigate')
  })

  it('followUp with an empty prompt and no comments leaves the prompt empty', () => {
    const id = waiting()
    const f = store.followUp(id, '', undefined, 'build')
    expect(f.prompt).toBe('')
    expect(f.stage).toBe('build')
  })

  it('comments added after followUp stay pending and out of the prompt', () => {
    const id = waiting()
    store.followUp(id, 'go', undefined, 'spec')
    const c = store.addComment(id, 'late')
    expect(c.comments[0].consumed).toBe(false)
    expect(c.prompt).toBe('go')
  })

  it('canMoveStage gates forward moves on waiting-for-you', () => {
    expect(canMoveStage('waiting-for-you', 'investigate', 'build')).toBe(true)
    expect(canMoveStage('waiting-for-you', 'spec', 'investigate')).toBe(false)
    expect(canMoveStage('done', 'build', 'spec')).toBe(true)
    expect(canMoveStage('done', 'spec', 'build')).toBe(false)
    expect(canMoveStage('running', 'spec', 'build')).toBe(false)
    expect(canMoveStage('running', 'spec', 'spec')).toBe(true)
  })

  it('followUp rejects an illegal stage move', () => {
    const id = waiting()
    store.followUp(id, 'go', undefined, 'spec')
    store.transition(id, 'provisioning')
    store.transition(id, 'running')
    store.transition(id, 'waiting-for-you')
    expect(() => store.followUp(id, 'back', undefined, 'investigate')).toThrow(/illegal stage move/)
  })

  it('waiting-for-you can be cancelled and is not resumable', () => {
    const id = waiting()
    expect(store.transition(id, 'cancelled').state).toBe('cancelled')
    expect(RESUMABLE_STATES).not.toContain('waiting-for-you')
    expect(FOLLOWUP_STATES).toContain('waiting-for-you')
  })

  it('threadTitle is the first line of the first turn prompt, cut to 72 chars', () => {
    const id = waiting()
    expect(threadTitle(store.get(id)!)).toBe('do it')
    store.followUp(id, 'second', undefined, 'spec')
    expect(threadTitle(store.get(id)!)).toBe('do it')
    const long = store.create({ ...input, prompt: `${'x'.repeat(100)}\nrest` })
    expect(threadTitle(long)).toBe('x'.repeat(72))
  })
})

describe('TaskStore.resume', () => {
  it('requeues with a new model, same prompt, same turns/tokensUsed', () => {
    const t = store.create({ ...input, model: 'haiku' })
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.addUsage(t.id, 42)
    store.patch(t.id, { sessionId: 'sess-1' })
    store.transition(t.id, 'paused-limit')
    store.unbin(t.id)
    const r = store.resume(t.id, 'opus')
    expect(r.state).toBe('queued')
    expect(r.model).toBe('opus')
    expect(r.prompt).toBe('do it')
    expect(r.tokensUsed).toBe(42)
    expect(r.turns).toHaveLength(0)
    expect(r.sessionId).toBe('sess-1')
  })

  it('keeps the current model when none is given', () => {
    const t = store.create({ ...input, model: 'haiku' })
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.transition(t.id, 'failed', { error: 'boom' })
    const r = store.resume(t.id)
    expect(r.state).toBe('queued')
    expect(r.model).toBe('haiku')
  })

  it('clears restarts and retryAt on resume, like a manual requeue', () => {
    const t = store.create(input)
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.recoveryRequeue(t.id)
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'cancelled')
    const r = store.resume(t.id, 'sonnet')
    expect(r.restarts).toBe(0)
    expect(r.retryAt).toBeNull()
  })

  it('throws when resuming from a non-resumable state', () => {
    const t = store.create(input)
    expect(() => store.resume(t.id, 'opus')).toThrow(/cannot resume from state/)
  })

  it('throws for an unknown task id', () => {
    expect(() => store.resume('zzzzzzzz', 'opus')).toThrow(/no task/)
  })

  for (const state of RESUMABLE_STATES) {
    it(`updates the model when resuming from ${state}`, () => {
      const t = store.create({ ...input, model: 'haiku' })
      store.transition(t.id, 'provisioning')
      store.transition(t.id, 'running')
      store.transition(t.id, state)
      store.unbin(t.id) // paused-limit bins; only restore() lifts that
      const r = store.resume(t.id, 'opus')
      expect(r.state).toBe('queued')
      expect(r.model).toBe('opus')
    })
  }
})
