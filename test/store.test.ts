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
