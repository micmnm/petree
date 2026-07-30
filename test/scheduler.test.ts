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
