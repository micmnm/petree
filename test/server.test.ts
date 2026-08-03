import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import type { Launcher } from '../src/launcher.js'
import { TaskStore } from '../src/store.js'
import { Scheduler } from '../src/scheduler.js'
import { makeApp } from '../src/server.js'

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

let server: Server
let base: string
let store: TaskStore
let home: string

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'petree-srv-'))
  const cfg: PetreeConfig = {
    home,
    defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null, instructions: '' },
    repos: { demo: { url: 'x', defaultBranch: 'main', image: 'sandbox-node', instructions: '', setup: [], build: [], test: [], skills: [], defaultModel: null } },
    allowClone: [],
  }
  store = new TaskStore(join(home, 'db'))
  // concurrency 0: nothing launches during API tests; stop() always reports
  // "nothing to stop" since no real process ever runs here.
  const launch: Launcher = Object.assign(async () => {}, { stop: async () => false })
  const scheduler = new Scheduler(store, 0, launch)
  const app = makeApp(cfg, store, scheduler, launch)
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

  it('refuses to resume a done task, leaving its result and turns untouched', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.setResult(t.id, 'findings')
    store.transition(t.id, 'done')
    const res = await fetch(`${base}/api/tasks/${t.id}/resume`, { method: 'POST' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'cannot resume from state done' })
    const after = store.get(t.id)!
    expect(after.state).toBe('done')
    expect(after.result).toBe('findings')
    expect(after.turns).toHaveLength(0)
  })

  it('stops a queued task directly, without touching the launcher', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    const res = await fetch(`${base}/api/tasks/${t.id}/stop`, { method: 'POST' })
    expect((await res.json()).state).toBe('cancelled')
  })

  it('stops a running task via the launcher and 404s/409s appropriately', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    const res = await fetch(`${base}/api/tasks/${t.id}/stop`, { method: 'POST' })
    // the fake launcher's stop() always returns false (no real process is running)
    expect(res.status).toBe(409)

    const t2 = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    store.transition(t2.id, 'provisioning')
    store.transition(t2.id, 'running')
    store.transition(t2.id, 'done')
    const doneStop = await fetch(`${base}/api/tasks/${t2.id}/stop`, { method: 'POST' })
    expect(doneStop.status).toBe(409)

    const missing = await fetch(`${base}/api/tasks/zzzzzzzz/stop`, { method: 'POST' })
    expect(missing.status).toBe(404)
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

  it('serves the markdown module as javascript', async () => {
    const res = await fetch(`${base}/markdown.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(await res.text()).toContain('renderMarkdown')
  })

  it('serves the activity module as javascript', async () => {
    const res = await fetch(`${base}/activity.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(await res.text()).toContain('renderActivity')
  })

  it('lists repos for the selector', async () => {
    const repos = await (await fetch(`${base}/api/repos`)).json()
    expect(repos).toContainEqual({
      name: 'demo', defaultBranch: 'main', image: 'sandbox-node', defaultModel: null,
      instructions: '', setup: [], build: [], test: [],
    })
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

  it('rejects refspec and HEAD tricks that would target the base branch', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    seedWorkRepo(home, t.id, 'demo')
    for (const target of ['refs/heads/main', 'HEAD', 'refs/tags/x']) {
      const res = await fetch(`${base}/api/tasks/${t.id}/push`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: 'demo', target }),
      })
      expect(res.status).toBe(400)
    }
  })

  it('rejects the base branch and unknown repo for PR creation, same as push', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    seedWorkRepo(home, t.id, 'demo')
    const badTarget = await fetch(`${base}/api/tasks/${t.id}/pr`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'demo', target: 'main' }),
    })
    expect(badTarget.status).toBe(400)
    const unknownRepo = await fetch(`${base}/api/tasks/${t.id}/pr`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'nope', target: 'x' }),
    })
    expect(unknownRepo.status).toBe(400)
  })

  it('pushes then attempts gh pr create, surfacing failure without crashing (no real GitHub remote in tests)', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    seedWorkRepo(home, t.id, 'demo')
    const res = await fetch(`${base}/api/tasks/${t.id}/pr`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'demo', target: `petree/${t.id}` }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.output.length).toBeGreaterThan(0)
  })

  it('queues a follow-up turn on a done task via /next', async () => {
    const t = store.create({ prompt: 'investigate', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.setResult(t.id, 'findings')
    store.transition(t.id, 'done')
    const res = await fetch(`${base}/api/tasks/${t.id}/next`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'now implement it', model: 'haiku' }),
    })
    expect(res.status).toBe(200)
    const task = await res.json()
    expect(task.state).toBe('queued')
    expect(task.prompt).toBe('now implement it')
    expect(task.model).toBe('haiku')
    expect(task.turns).toHaveLength(1)
    expect(task.turns[0].prompt).toBe('investigate')
    expect(task.turns[0].result).toBe('findings')
  })

  it('rejects /next with a missing prompt, unknown model, wrong state, or unknown id', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.transition(t.id, 'done')
    const noPrompt = await fetch(`${base}/api/tasks/${t.id}/next`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })
    expect(noPrompt.status).toBe(400)
    const badModel = await fetch(`${base}/api/tasks/${t.id}/next`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', model: 'gpt-4' }),
    })
    expect(badModel.status).toBe(400)

    const running = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    store.transition(running.id, 'provisioning')
    store.transition(running.id, 'running')
    const wrongState = await fetch(`${base}/api/tasks/${running.id}/next`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }),
    })
    expect(wrongState.status).toBe(409)

    const missing = await fetch(`${base}/api/tasks/zzzzzzzz/next`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }),
    })
    expect(missing.status).toBe(404)
  })
})
