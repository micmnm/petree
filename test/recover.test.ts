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
