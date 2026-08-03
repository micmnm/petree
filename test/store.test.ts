import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
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
