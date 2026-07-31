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
  await new Promise<void>((r) => { server = app.listen(0, () => r()) })
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

  it('rejects log ids that are not task-id shaped', async () => {
    const res = await fetch(`${base}/api/tasks/..%2f..%2fsecret/logs`)
    expect(res.status).toBe(400)
  })

  it('404s on unknown task get and resume', async () => {
    const get = await fetch(`${base}/api/tasks/zzzzzzzz`)
    expect(get.status).toBe(404)
    const resume = await fetch(`${base}/api/tasks/zzzzzzzz/resume`, { method: 'POST' })
    expect(resume.status).toBe(404)
  })

  it('serves the dashboard page', async () => {
    const res = await fetch(base)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Petree')
  })
})
