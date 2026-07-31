import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import { TaskStore } from '../src/store.js'
import type { TaskRecord } from '../src/store.js'
import { makeLauncher } from '../src/launcher.js'

const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url))

function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'petree-fixture-'))
  execFileSync('git', ['init', '-b', 'main', dir])
  writeFileSync(join(dir, 'README.md'), 'hello')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'])
  return dir
}

function setup(input: { tokenBudget?: number; timeoutMinutes?: number } = {}): {
  home: string
  cfg: PetreeConfig
  store: TaskStore
  task: TaskRecord
} {
  const home = mkdtempSync(join(tmpdir(), 'petree-home-'))
  const cfg: PetreeConfig = {
    home,
    defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null },
    repos: { demo: { url: `file://${makeFixtureRepo()}`, defaultBranch: 'main', image: 'sandbox-node', setup: [], test: [], skills: [], defaultModel: null } },
    allowClone: [],
  }
  const store = new TaskStore(join(home, 'petree.db'))
  const created = store.create({
    prompt: 'p',
    repos: ['demo'],
    tokenBudget: input.tokenBudget ?? 500000,
    timeoutMinutes: input.timeoutMinutes ?? 30,
  })
  const task = store.transition(created.id, 'provisioning')
  return { home, cfg, store, task }
}

describe('makeLauncher', () => {
  it('runs a task end to end: clone, run, record usage and result', async () => {
    const { home, cfg, store, task } = setup()
    mkdirSync(join(home, 'logs'), { recursive: true })

    const launch = makeLauncher(cfg, store, {
      buildCommand: () => [process.execPath, fakeClaude, 'ok'],
    })
    await launch(task)

    const finished = store.get(task.id)!
    expect(finished.state).toBe('done')
    expect(finished.tokensUsed).toBe(150)
    expect(finished.sessionId).toBe('sess-123')
    expect(existsSync(join(home, 'work', task.id, 'demo', 'README.md'))).toBe(true)
    expect(readFileSync(join(home, 'logs', `${task.id}.log`), 'utf8')).toContain('sess-123')
  })

  it('pauses the task when a limit is hit', async () => {
    const { cfg, store, task } = setup({ tokenBudget: 1000 })

    const launch = makeLauncher(cfg, store, {
      buildCommand: () => [process.execPath, fakeClaude, 'big-usage'],
    })
    await launch(task)

    expect(store.get(task.id)?.state).toBe('paused-limit')
    expect(store.get(task.id)?.error).toBe('token-budget')
  })

  it('fails the task when the sandbox process crashes with a nonzero exit code', async () => {
    const { cfg, store, task } = setup()

    const launch = makeLauncher(cfg, store, {
      buildCommand: () => [process.execPath, fakeClaude, 'crash'],
    })
    await launch(task)

    expect(store.get(task.id)?.state).toBe('failed')
    expect(store.get(task.id)?.error).toBe('exit code 3')
  })

  it('reconciles to failed when the process exits cleanly without a terminal event', async () => {
    const { cfg, store, task } = setup()

    const launch = makeLauncher(cfg, store, {
      buildCommand: () => [process.execPath, fakeClaude, 'silent'],
    })
    await launch(task)

    expect(store.get(task.id)?.state).toBe('failed')
    expect(store.get(task.id)?.error).toMatch(/without terminal event/)
  })

  it('fails the task when the sandbox command fails to spawn, without hanging', async () => {
    const { cfg, store, task } = setup()

    const launch = makeLauncher(cfg, store, {
      buildCommand: () => ['no-such-binary-petree'],
    })
    await launch(task)

    expect(store.get(task.id)?.state).toBe('failed')
    expect(store.get(task.id)?.error).toBeTruthy()
  })

  it('pauses the task on timeout', async () => {
    const { cfg, store, task } = setup({ timeoutMinutes: 0.005 })

    const launch = makeLauncher(cfg, store, {
      buildCommand: () => [process.execPath, fakeClaude, 'slow'],
    })
    await launch(task)

    expect(store.get(task.id)?.state).toBe('paused-limit')
    expect(store.get(task.id)?.error).toBe('timeout')
  })

  it('captures the result text on a successful run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-home-'))
    mkdirSync(join(home, 'logs'), { recursive: true })
    const cfg: PetreeConfig = {
      home,
      defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null },
      repos: { demo: { url: `file://${makeFixtureRepo()}`, defaultBranch: 'main', image: 'sandbox-node', setup: [], test: [], skills: [], defaultModel: null } },
      allowClone: [],
    }
    const store = new TaskStore(join(home, 'petree.db'))
    const created = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 500000, timeoutMinutes: 30 })
    const task = store.transition(created.id, 'provisioning')
    const launch = makeLauncher(cfg, store, { buildCommand: () => [process.execPath, fakeClaude, 'ok'] })
    await launch(task)
    expect(store.get(task.id)?.state).toBe('done')
    expect(store.get(task.id)?.result).toBe('all tests pass')
  })

  it('stores the final result of a multi-result run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-home-'))
    mkdirSync(join(home, 'logs'), { recursive: true })
    const cfg: PetreeConfig = {
      home,
      defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null },
      repos: { demo: { url: `file://${makeFixtureRepo()}`, defaultBranch: 'main', image: 'sandbox-node', setup: [], test: [], skills: [], defaultModel: null } },
      allowClone: [],
    }
    const store = new TaskStore(join(home, 'petree.db'))
    const created = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 500000, timeoutMinutes: 30 })
    const task = store.transition(created.id, 'provisioning')
    const launch = makeLauncher(cfg, store, { buildCommand: () => [process.execPath, fakeClaude, 'two-results'] })
    await launch(task)
    expect(store.get(task.id)?.state).toBe('done')
    expect(store.get(task.id)?.result).toBe('final answer')
  })

  it('commits the agent changes on the task branch after a run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-home-'))
    mkdirSync(join(home, 'logs'), { recursive: true })
    const cfg = {
      home,
      defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null },
      repos: { demo: { url: `file://${makeFixtureRepo()}`, defaultBranch: 'main', image: 'sandbox-node', setup: [], test: [], skills: [], defaultModel: null } },
      allowClone: [],
    }
    const store = new TaskStore(join(home, 'petree.db'))
    const created = store.create({ prompt: 'edit the readme', repos: ['demo'], tokenBudget: 500000, timeoutMinutes: 30 })
    const task = store.transition(created.id, 'provisioning')
    // fake "claude" that writes a file into /work/demo then emits a clean done
    const writer = [process.execPath, '-e',
      `const fs=require('fs');fs.writeFileSync(process.env.WD+'/demo/added.txt','x');` +
      `console.log(JSON.stringify({type:'result',subtype:'success',result:'done'}))`]
    const launch = makeLauncher(cfg, store, { buildCommand: (t, workDir) => { process.env.WD = workDir; return writer } })
    await launch(task)
    const repoDir = join(home, 'work', task.id, 'demo')
    const msg = execFileSync('git', ['-C', repoDir, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim()
    expect(msg).toContain(`petree ${task.id}`)
    const branch = execFileSync('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(branch).toBe(`petree/${task.id}`)
  })
})
