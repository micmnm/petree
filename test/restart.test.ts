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
