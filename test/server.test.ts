import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import Database from 'better-sqlite3'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import type { Launcher } from '../src/launcher.js'
import { TaskStore } from '../src/store.js'
import { Scheduler } from '../src/scheduler.js'
import { makeApp } from '../src/server.js'
import { saveGitConfig } from '../src/gitops.js'

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
  saveGitConfig(workDir)
  cfgRepos[repo].url = bare
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
let cfgRepos: PetreeConfig['repos']

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'petree-srv-'))
  const cfg: PetreeConfig = {
    home,
    defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null, instructions: '' },
    repos: {
      demo: { url: 'x', defaultBranch: 'main', image: 'sandbox-node', instructions: '', setup: [], build: [], test: [], run: ['npm start'], skills: [], tags: [], defaultModel: null },
      odd: { url: 'x', defaultBranch: 'main', image: 'custom-img', instructions: '', setup: [], build: [], test: [], run: [], skills: [], tags: [], defaultModel: null },
    },
    allowClone: [],
  }
  cfgRepos = cfg.repos
  store = new TaskStore(join(home, 'db'))
  // concurrency 0: nothing launches during API tests; stop() always reports
  // "nothing to stop" since no real process ever runs here.
  const launch: Launcher = Object.assign(async () => {}, { stop: async () => false, reattach: async () => {} })
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
    store.unbin(t.id)
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

  it('resumes with a valid model, updating the task model and requeuing', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1, model: 'haiku' })
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.transition(t.id, 'paused-limit')
    store.unbin(t.id)
    const res = await fetch(`${base}/api/tasks/${t.id}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'opus' }),
    })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.state).toBe('queued')
    expect(body.model).toBe('opus')
  })

  it('resumes with no model key exactly as before (same model, same prompt, requeued)', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1, model: 'haiku' })
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.transition(t.id, 'paused-limit')
    store.unbin(t.id)
    const res = await fetch(`${base}/api/tasks/${t.id}/resume`, { method: 'POST' })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.state).toBe('queued')
    expect(body.model).toBe('haiku')
    expect(body.prompt).toBe('p')
  })

  it('rejects an unknown model on resume with 400 and leaves state unchanged', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1, model: 'haiku' })
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.transition(t.id, 'paused-limit')
    store.unbin(t.id)
    const res = await fetch(`${base}/api/tasks/${t.id}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'unknown model: gpt-4' })
    const after = store.get(t.id)!
    expect(after.state).toBe('paused-limit')
    expect(after.model).toBe('haiku')
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
      instructions: '', setup: [], build: [], test: [], run: ['npm start'], tags: [], path: null, local: null,
      usage: expect.objectContaining({ quests: 0, weekly: Array(8).fill(0) }),
    })
  })

  it('reports unpushed and dirty state of a configured local checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'petree-local-'))
    const bare = join(root, 'origin.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', bare])
    const co = join(root, 'co')
    execFileSync('git', ['clone', bare, co])
    writeFileSync(join(co, 'a.txt'), 'a\n')
    execFileSync('git', ['-C', co, 'add', '.'])
    execFileSync('git', ['-C', co, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'a'])
    execFileSync('git', ['-C', co, 'push', 'origin', 'HEAD:main'])
    execFileSync('git', ['-C', co, 'fetch', 'origin'])
    const get = async () => (await (await fetch(`${base}/api/repos`)).json()).find((r: { name: string }) => r.name === 'demo')
    cfgRepos.demo.path = co
    expect((await get()).local).toEqual({ unpushed: 0, dirty: false })
    writeFileSync(join(co, 'b.txt'), 'b\n')
    execFileSync('git', ['-C', co, 'add', '.'])
    execFileSync('git', ['-C', co, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'b'])
    writeFileSync(join(co, 'c.txt'), 'c\n')
    expect((await get()).local).toEqual({ unpushed: 1, dirty: true })
    cfgRepos.demo.path = join(root, 'missing')
    expect((await get()).local).toBeNull()
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
    expect(arr[0].folder).toBe(join(home, 'work', t.id, 'demo'))
    expect(arr[0].run).toEqual(['npm start'])
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

  it('bins hall-of-fame when a push lands on an untracked host', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1, stage: 'build' })
    for (const s of ['provisioning', 'running', 'done'] as const) store.transition(t.id, s)
    seedWorkRepo(home, t.id, 'demo')
    store.setDelivery(t.id, 'demo', { ahead: 1, head: 'h' })
    const res = await post(`/api/tasks/${t.id}/push`, { repo: 'demo', target: `petree/${t.id}` })
    expect((await res.json()).ok).toBe(true)
    expect(store.get(t.id)).toMatchObject({ bin: 'hall-of-fame', binReason: 'pushed · merge not tracked' })
  })

  it('refuses to push or open a PR while the agent is live', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    seedWorkRepo(home, t.id, 'demo')
    store.transition(t.id, 'provisioning')
    for (const route of ['push', 'pr']) {
      expect((await post(`/api/tasks/${t.id}/${route}`, { repo: 'demo', target: `petree/${t.id}` })).status).toBe(409)
    }
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

  it('records target after the push even when PR creation fails (unsupported host, no CLI run)', async () => {
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
    expect(store.get(t.id)!.delivery.demo.target).toBe(`petree/${t.id}`)
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

  it('returns default retention settings and updates them, validating input', async () => {
    const got = await (await fetch(`${base}/api/settings`)).json()
    expect(got).toEqual({ binDays: 14, hallOfFameDays: 3 })
    const updated = await fetch(`${base}/api/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ binDays: 7, hallOfFameDays: 2 }),
    })
    expect(updated.status).toBe(200)
    const body = await updated.json()
    expect(body.binDays).toBe(7)
    expect(body.hallOfFameDays).toBe(2)
    const bad = await fetch(`${base}/api/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ binDays: 0 }),
    })
    expect(bad.status).toBe(400)
  })

  it('archives past-window bins via POST /api/prune and hides them unless ?archived=1', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    for (const s of ['provisioning', 'running', 'done'] as const) store.transition(t.id, s)
    store.bin(t.id, 'hall-of-fame', 'r')
    await fetch(`${base}/api/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hallOfFameDays: 1 }),
    })
    // not past the window yet
    expect((await (await fetch(`${base}/api/prune`, { method: 'POST' })).json()).archived).toBe(0)
    const raw = new Database(join(home, 'db'))
    raw.prepare('UPDATE tasks SET binned_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 86_400_000).toISOString(), t.id)
    raw.close()
    expect((await (await fetch(`${base}/api/prune`, { method: 'POST' })).json()).archived).toBe(1)
    expect(await (await fetch(`${base}/api/tasks`)).json()).toHaveLength(0)
    expect(await (await fetch(`${base}/api/tasks?archived=1`)).json()).toHaveLength(1)
    expect((await fetch(`${base}/api/tasks/${t.id}`)).status).toBe(200)
  })

  const post = (path: string, body: unknown = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const mk = (...states: Parameters<TaskStore['transition']>[1][]) => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    for (const s of states) store.transition(t.id, s)
    return t.id
  }

  it('drop bins game-over from gate, done, failed, cancelled and queued; 409 when running or already binned', async () => {
    for (const path of [['provisioning', 'running', 'waiting-for-you'], ['provisioning', 'running', 'done'],
      ['provisioning', 'running', 'failed'], ['provisioning', 'cancelled'], []] as const) {
      const id = mk(...path)
      const res = await post(`/api/tasks/${id}/drop`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ bin: 'game-over', binReason: 'dropped by you' })
      expect((await (await fetch(`${base}/api/tasks/${id}`)).json()).card).toMatchObject({ group: 'game-over', reason: 'dropped by you' })
    }
    const id = mk('provisioning', 'running')
    expect((await post(`/api/tasks/${id}/drop`)).status).toBe(409)
    expect(store.get(id)!.bin).toBeNull()
    const binned = mk('provisioning', 'running', 'done')
    store.bin(binned, 'game-over', 'x')
    expect((await post(`/api/tasks/${binned}/drop`)).status).toBe(409)
    expect((await post('/api/tasks/nope/drop')).status).toBe(404)
  })

  it('done bins hall-of-fame from gate and no-commit done; 409 otherwise', async () => {
    const gate = mk('provisioning', 'running', 'waiting-for-you')
    const ok = await post(`/api/tasks/${gate}/done`)
    expect(await ok.json()).toMatchObject({ state: 'waiting-for-you', bin: 'hall-of-fame', binReason: 'finished · findings kept' })
    const noCommits = mk('provisioning', 'running', 'done')
    expect((await post(`/api/tasks/${noCommits}/done`)).status).toBe(200)
    const withCommits = mk('provisioning', 'running', 'done')
    store.setDelivery(withCommits, 'demo', { ahead: 1, head: 'abc' })
    expect((await post(`/api/tasks/${withCommits}/done`)).status).toBe(409)
    expect((await post(`/api/tasks/${mk()}/done`)).status).toBe(409)
    expect((await post(`/api/tasks/${gate}/done`)).status).toBe(409)
  })

  it('restore: unbins a dropped gate thread, resets an out-of-tokens one, 409 for hall-of-fame and unbinned', async () => {
    const gate = mk('provisioning', 'running', 'waiting-for-you')
    await post(`/api/tasks/${gate}/drop`)
    expect(await (await post(`/api/tasks/${gate}/restore`)).json()).toMatchObject({ state: 'waiting-for-you', bin: null })

    const limit = mk('provisioning', 'running')
    store.addUsage(limit, 50)
    store.transition(limit, 'paused-limit')
    expect(await (await post(`/api/tasks/${limit}/restore`)).json()).toMatchObject({ state: 'queued', tokensUsed: 0, bin: null })

    const hof = mk()
    store.bin(hof, 'hall-of-fame', 'r')
    expect((await post(`/api/tasks/${hof}/restore`)).status).toBe(409)
    expect((await post(`/api/tasks/${mk()}/restore`)).status).toBe(409)
    expect((await post('/api/tasks/nope/restore')).status).toBe(404)
  })

  it('rejects /next, /resume and /comments on binned threads with "restore first"', async () => {
    const id = mk('provisioning', 'running', 'waiting-for-you')
    store.bin(id, 'game-over', 'dropped by you')
    for (const [path, body] of [['next', { prompt: 'x' }], ['resume', {}], ['comments', { text: 'x' }]] as const) {
      const res = await post(`/api/tasks/${id}/${path}`, body)
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'restore first' })
    }
  })

  it('reads and writes repos.yaml, applying edits to the running config in place', async () => {
    writeFileSync(join(home, 'repos.yaml'), 'repos:\n  demo:\n    url: x\n    image: sandbox-node\n')
    const got = await (await fetch(`${base}/api/repos-yaml`)).json()
    expect(got.content).toContain('demo')

    const newYaml = 'repos:\n  demo:\n    url: x\n    image: sandbox-node\n  extra:\n    url: y\n    image: sandbox-node\n'
    const put = await fetch(`${base}/api/repos-yaml`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: newYaml }),
    })
    expect(put.status).toBe(200)
    expect(readFileSync(join(home, 'repos.yaml'), 'utf8')).toBe(newYaml)

    const repos = await (await fetch(`${base}/api/repos`)).json()
    expect(repos.map((r: { name: string }) => r.name).sort()).toEqual(['demo', 'extra'])

    // a task created after the edit sees the new repo without a server restart
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', repos: ['extra'] }),
    })
    expect(res.status).toBe(201)
  })

  it('rejects invalid repos.yaml content without touching the running config', async () => {
    const bad = await fetch(`${base}/api/repos-yaml`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'repos:\n  bad:\n    url: x\n' }),
    })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/image/)

    // the original 'demo' repo (seeded in beforeEach) still resolves
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', repos: ['demo'] }),
    })
    expect(res.status).toBe(201)

    const empty = await fetch(`${base}/api/repos-yaml`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    })
    expect(empty.status).toBe(400)
  })

  describe('structured repo editing', () => {
    const FILE = '# keep me\nrepos:\n  demo:\n    url: x\n    image: sandbox-node\n  odd:\n    url: x\n    image: custom-img\n'
    const send = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    })
    const disk = () => readFileSync(join(home, 'repos.yaml'), 'utf8')
    const hashOf = async (name = 'demo') => (await (await fetch(`${base}/api/repos/${name}`)).json()).hash

    beforeEach(() => writeFileSync(join(home, 'repos.yaml'), FILE))

    it('edits a repo, keeping the rest of the file and updating the running config', async () => {
      const got = await (await fetch(`${base}/api/repos/demo`)).json()
      expect(got).toMatchObject({ editable: true, fields: { url: 'x', image: 'sandbox-node' } })
      const put = await send('PUT', '/api/repos/demo', { hash: got.hash, fields: { url: 'new', image: 'sandbox-node', tags: ['t'] } })
      expect(put.status).toBe(200)
      expect(disk()).toBe('# keep me\nrepos:\n  demo:\n    url: new\n    image: sandbox-node\n    tags:\n      - t\n  odd:\n    url: x\n    image: custom-img\n')
      const repos = await (await fetch(`${base}/api/repos`)).json()
      expect(repos.find((r: { name: string }) => r.name === 'demo').tags).toEqual(['t'])
    })

    it('adds, edits defaults, and deletes', async () => {
      expect((await send('POST', '/api/repos', { name: 'extra', fields: { url: 'q', image: 'i' } })).status).toBe(201)
      expect((await send('POST', '/api/repos', { name: 'extra', fields: { url: 'q', image: 'i' } })).status).toBe(409)
      expect((await send('PUT', '/api/defaults', { concurrency: 5 })).status).toBe(200)
      expect(disk()).toContain('defaults:\n  concurrency: 5\n')
      expect((await send('DELETE', `/api/repos/extra?hash=${await hashOf()}`)).status).toBe(200)
      expect(disk()).not.toContain('extra')
    })

    it('refuses anchored blocks with 422', async () => {
      writeFileSync(join(home, 'repos.yaml'), 'repos:\n  demo: &d\n    url: x\n    image: sandbox-node\n')
      const got = await (await fetch(`${base}/api/repos/demo`)).json()
      expect(got.editable).toBe(false)
      const put = await send('PUT', '/api/repos/demo', { hash: got.hash, fields: { url: 'y', image: 'i' } })
      expect(put.status).toBe(422)
    })

    it('rejects an invalid result with 400 and leaves the file untouched', async () => {
      const put = await send('PUT', '/api/repos/demo', { hash: await hashOf(), fields: { url: 'y' } })
      expect(put.status).toBe(400)
      expect((await put.json()).error).toMatch(/image/)
      expect(disk()).toBe(FILE)
    })

    it('answers 409 when the file changed since the hash was read', async () => {
      const hash = await hashOf()
      writeFileSync(join(home, 'repos.yaml'), `${FILE}# hand edit\n`)
      const put = await send('PUT', '/api/repos/demo', { hash, fields: { url: 'y', image: 'i' } })
      expect(put.status).toBe(409)
      expect(disk()).toBe(`${FILE}# hand edit\n`)
    })

    it('refuses to delete a repo an active thread uses', async () => {
      await send('POST', '/api/tasks', { prompt: 'x', repos: ['demo'] })
      const del = await send('DELETE', `/api/repos/demo?hash=${await hashOf()}`)
      expect(del.status).toBe(409)
      expect(disk()).toBe(FILE)
    })

    it('refuses to delete a repo a finished but unbinned thread uses', async () => {
      const t = store.create({ prompt: 'x', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
      for (const s of ['provisioning', 'running', 'done'] as const) store.transition(t.id, s)
      const del = await send('DELETE', `/api/repos/demo?hash=${await hashOf()}`)
      expect(del.status).toBe(409)
    })

    it('ignores binned threads when checking whether a repo is in use', async () => {
      const t = await (await send('POST', '/api/tasks', { prompt: 'x', repos: ['demo'] })).json()
      store.bin(t.id, 'game-over', 'dropped by you')
      const del = await send('DELETE', `/api/repos/demo?hash=${await hashOf()}`)
      expect(del.status).toBe(200)
    })
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

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function gated(stage?: 'investigate' | 'spec' | 'build') {
  const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1, stage })
  store.transition(t.id, 'provisioning')
  store.transition(t.id, 'running')
  store.transition(t.id, 'waiting-for-you')
  return t
}

describe('thread API', () => {
  it('creates a task at a given stage, 400 on unknown stage or unsupported image mix', async () => {
    const ok = await post('/api/tasks', { prompt: 'x', repos: ['demo'], stage: 'spec' })
    expect(ok.status).toBe(201)
    expect((await ok.json()).stage).toBe('spec')
    expect((await post('/api/tasks', { prompt: 'x', repos: ['demo'], stage: 'ship' })).status).toBe(400)
    expect((await post('/api/tasks', { prompt: 'x', repos: ['demo', 'odd'] })).status).toBe(400)
  })

  it('stores party and autoPlay from the request, defaulting to party on / auto-play off', async () => {
    expect(await (await post('/api/tasks', { prompt: 'x', repos: ['demo'] })).json()).toMatchObject({ party: true, autoPlay: false })
    const set = await (await post('/api/tasks', { prompt: 'x', repos: ['demo'], party: false, autoPlay: true })).json()
    expect(set).toMatchObject({ party: false, autoPlay: true })
    expect((await post('/api/tasks', { prompt: 'x', repos: ['demo'], party: 'no' })).status).toBe(400)
  })

  it('attaches a card to the task list and to a single task', async () => {
    const t = gated('spec')
    const one = await (await fetch(`${base}/api/tasks/${t.id}`)).json()
    expect(one.card).toMatchObject({ group: 'your-move', line: 'Spec ready' })
    const list = await (await fetch(`${base}/api/tasks`)).json()
    expect(list.find((x: { id: string }) => x.id === t.id).card.group).toBe('your-move')
  })

  it('adds comments, 400 on empty text, 404 on unknown task', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    const ok = await post(`/api/tasks/${t.id}/comments`, { text: 'hello' })
    expect(ok.status).toBe(201)
    expect((await ok.json()).comments[0]).toMatchObject({ text: 'hello', consumed: false })
    expect((await post(`/api/tasks/${t.id}/comments`, { text: '  ' })).status).toBe(400)
    expect((await post('/api/tasks/deadbeef/comments', { text: 'x' })).status).toBe(404)
  })

  it('/next: empty prompt needs pending comments or a stage change', async () => {
    const t = gated()
    expect((await post(`/api/tasks/${t.id}/next`, {})).status).toBe(400)
    expect((await post(`/api/tasks/${t.id}/next`, { stage: 'investigate' })).status).toBe(400)
    const moved = await post(`/api/tasks/${t.id}/next`, { stage: 'spec' })
    expect(moved.status).toBe(200)
    const body = await moved.json()
    expect(body.state).toBe('queued')
    expect(body.stage).toBe('spec')

    const c = gated()
    await post(`/api/tasks/${c.id}/comments`, { text: 'tweak' })
    const folded = await post(`/api/tasks/${c.id}/next`, {})
    expect(folded.status).toBe(200)
    expect((await folded.json()).prompt).toContain('tweak')
  })

  it('/next: 400 on illegal or unknown stage, 409 on non-follow-up state', async () => {
    const t = gated('spec')
    expect((await post(`/api/tasks/${t.id}/next`, { prompt: 'x', stage: 'investigate' })).status).toBe(400)
    expect((await post(`/api/tasks/${t.id}/next`, { prompt: 'x', stage: 'bogus' })).status).toBe(400)
    const q = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    expect((await post(`/api/tasks/${q.id}/next`, { prompt: 'x' })).status).toBe(409)
  })

  it('/stop drops a waiting-for-you task to cancelled', async () => {
    const t = gated()
    const res = await post(`/api/tasks/${t.id}/stop`, {})
    expect((await res.json()).state).toBe('cancelled')
  })

  it('serves quest stats: a running turn timed from startedAt, and the window budget from defaults', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.patch(t.id, { startedAt: new Date(Date.now() - 60_000).toISOString() })
    const stats = async () => (await fetch(`${base}/api/tasks/${t.id}/stats`)).json()
    const s = await stats()
    expect(s).toMatchObject({ windowUsd: null, stages: [{ stage: 'investigate', live: true }] })
    expect(s.stages[0].wallMs).toBeGreaterThanOrEqual(60_000)
    const yaml = 'defaults:\n  window_usd: 40\nrepos:\n  demo:\n    url: x\n    image: sandbox-node\n'
    await fetch(`${base}/api/repos-yaml`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: yaml }) })
    expect((await stats()).windowUsd).toBe(40)
  })

  it('serves thread files and suggestions', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    const empty = await (await fetch(`${base}/api/tasks/${t.id}/thread`)).json()
    expect(empty).toEqual({ spec: null, findings: null, suggestions: [] })
    const dir = join(home, 'work', t.id, '_thread')
    mkdirSync(join(dir, 'notes', 'demo'), { recursive: true })
    writeFileSync(join(dir, 'spec.md'), 'the spec')
    writeFileSync(join(dir, 'notes', 'demo', 'topic.md'), 'note text')
    const got = await (await fetch(`${base}/api/tasks/${t.id}/thread`)).json()
    expect(got.spec).toBe('the spec')
    expect(got.findings).toBeNull()
    expect(got.suggestions).toEqual([{ repo: 'demo', topic: 'topic', text: 'note text', exists: false }])
    expect((await fetch(`${base}/api/tasks/deadbeef/thread`)).status).toBe(404)
  })

  it('accepts and drops note suggestions, 400 on bad input', async () => {
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    const dir = join(home, 'work', t.id, '_thread', 'notes', 'demo')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.md'), 'A')
    writeFileSync(join(dir, 'b.md'), 'B')
    const acc = await post(`/api/tasks/${t.id}/notes/accept`, { repo: 'demo', topic: 'a', text: 'A', summary: 'sum' })
    expect(acc.status).toBe(200)
    expect(await acc.json()).toEqual({ ok: true })
    expect(readFileSync(join(home, 'notes', 'demo', 'a.md'), 'utf8')).toBe('A')
    const drop = await post(`/api/tasks/${t.id}/notes/drop`, { repo: 'demo', topic: 'b' })
    expect(drop.status).toBe(200)
    const left = await (await fetch(`${base}/api/tasks/${t.id}/thread`)).json()
    expect(left.suggestions).toEqual([])
    expect((await post(`/api/tasks/${t.id}/notes/accept`, { repo: 'nope', topic: 'a', text: 'A', summary: 's' })).status).toBe(400)
    expect((await post(`/api/tasks/${t.id}/notes/drop`, { repo: 'demo', topic: '../x' })).status).toBe(400)
    expect((await post('/api/tasks/deadbeef/notes/drop', { repo: 'demo', topic: 'a' })).status).toBe(404)
  })
})
