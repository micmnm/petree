import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, it, expect } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import { prepareWorkspace } from '../src/git.js'
import { TaskStore } from '../src/store.js'
import type { TaskRecord } from '../src/store.js'
import { makeLauncher } from '../src/launcher.js'
import type { SandboxCommands } from '../src/sandbox.js'
import { inspectContainerState } from '../src/sandbox.js'

const shim = fileURLToPath(new URL('./fixtures/fake-docker.js', import.meta.url))

function shimCommands(scenario: string, name: string): SandboxCommands {
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
    defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null, instructions: '' },
    repos: { demo: { url: `file://${makeFixtureRepo()}`, defaultBranch: 'main', image: 'sandbox-node', instructions: '', setup: [], build: [], test: [], skills: [], defaultModel: null } },
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

beforeEach(() => {
  process.env.FAKE_DOCKER_HOME = mkdtempSync(join(tmpdir(), 'fdock-'))
})

describe('makeLauncher', () => {
  it('runs a task end to end: clone, run, record usage and result', async () => {
    const { home, cfg, store, task } = setup()
    mkdirSync(join(home, 'logs'), { recursive: true })

    const launch = makeLauncher(cfg, store, {
      buildCommands: (t) => shimCommands('ok', `petree-${t.id}`),
    })
    await launch(task)

    const finished = store.get(task.id)!
    expect(finished.state).toBe('done')
    expect(finished.tokensUsed).toBe(150)
    expect(finished.sessionId).toBe('sess-123')
    expect(existsSync(join(home, 'work', task.id, 'demo', 'README.md'))).toBe(true)
    expect(readFileSync(join(home, 'logs', `${task.id}.log`), 'utf8')).toContain('sess-123')
    expect(existsSync(join(home, 'sessions', task.id))).toBe(true)
  })

  it('pauses the task when a limit is hit', async () => {
    const { cfg, store, task } = setup({ tokenBudget: 1000 })

    const launch = makeLauncher(cfg, store, {
      buildCommands: (t) => shimCommands('big-usage', `petree-${t.id}`),
    })
    await launch(task)

    expect(store.get(task.id)?.state).toBe('paused-limit')
    expect(store.get(task.id)?.error).toBe('token-budget')
  })

  it('fails the task when the sandbox process crashes with a nonzero exit code', async () => {
    const { cfg, store, task } = setup()

    const launch = makeLauncher(cfg, store, {
      buildCommands: (t) => shimCommands('crash', `petree-${t.id}`),
    })
    await launch(task)

    expect(store.get(task.id)?.state).toBe('failed')
    expect(store.get(task.id)?.error).toBe('exit code 3')
  })

  it('reconciles to failed when the process exits cleanly without a terminal event', async () => {
    const { cfg, store, task } = setup()

    const launch = makeLauncher(cfg, store, {
      buildCommands: (t) => shimCommands('silent', `petree-${t.id}`),
    })
    await launch(task)

    expect(store.get(task.id)?.state).toBe('failed')
    expect(store.get(task.id)?.error).toMatch(/without terminal event/)
  })

  it('fails the task when the sandbox command fails to spawn, without hanging', async () => {
    const { cfg, store, task } = setup()

    const launch = makeLauncher(cfg, store, {
      buildCommands: (t) => ({ ...shimCommands('ok', `petree-${t.id}`), create: ['no-such-binary-petree'] }),
    })
    await launch(task)

    expect(store.get(task.id)?.state).toBe('failed')
    expect(store.get(task.id)?.error).toBeTruthy()
  })

  it('stops a running task on request, marking it cancelled rather than failed', async () => {
    const { home, cfg, store, task } = setup()
    mkdirSync(join(home, 'logs'), { recursive: true })

    const launch = makeLauncher(cfg, store, {
      buildCommands: (t) => shimCommands('slow', `petree-${t.id}`), // emits its result after 2s
    })
    const running = launch(task)
    // give the container a moment to start before killing it
    await new Promise((r) => setTimeout(r, 200))
    const stopped = await launch.stop(task.id)
    expect(stopped).toBe(true)
    await running

    expect(store.get(task.id)?.state).toBe('cancelled')
  })

  it('stop() returns false once the task has already finished', async () => {
    const { home, cfg, store, task } = setup()
    mkdirSync(join(home, 'logs'), { recursive: true })

    const launch = makeLauncher(cfg, store, {
      buildCommands: (t) => shimCommands('ok', `petree-${t.id}`),
    })
    await launch(task)
    expect(await launch.stop(task.id)).toBe(false)
  })

  it('pauses the task on timeout', async () => {
    const { cfg, store, task } = setup({ timeoutMinutes: 0.005 })

    const launch = makeLauncher(cfg, store, {
      buildCommands: (t) => shimCommands('slow', `petree-${t.id}`),
    })
    await launch(task)

    expect(store.get(task.id)?.state).toBe('paused-limit')
    expect(store.get(task.id)?.error).toBe('timeout')
  })

  it('captures the result text on a successful run', async () => {
    const { home, cfg, store, task } = setup()
    mkdirSync(join(home, 'logs'), { recursive: true })
    const launch = makeLauncher(cfg, store, { buildCommands: (t) => shimCommands('ok', `petree-${t.id}`) })
    await launch(task)
    expect(store.get(task.id)?.state).toBe('done')
    expect(store.get(task.id)?.result).toBe('all tests pass')
  })

  it('stores the final result of a multi-result run', async () => {
    const { home, cfg, store, task } = setup()
    mkdirSync(join(home, 'logs'), { recursive: true })
    const launch = makeLauncher(cfg, store, { buildCommands: (t) => shimCommands('two-results', `petree-${t.id}`) })
    await launch(task)
    expect(store.get(task.id)?.state).toBe('done')
    expect(store.get(task.id)?.result).toBe('final answer')
  })

  it('persists startedAt and logOffset when launching', async () => {
    const { home, cfg, store, task } = setup()
    mkdirSync(join(home, 'logs'), { recursive: true })
    const launch = makeLauncher(cfg, store, { buildCommands: (t) => shimCommands('ok', `petree-${t.id}`) })
    await launch(task)
    const finished = store.get(task.id)!
    expect(finished.startedAt).toBeTruthy()
    expect(finished.logOffset).toBe(0)
  })

  it('removes the container after the run', async () => {
    const { home, cfg, store, task } = setup()
    mkdirSync(join(home, 'logs'), { recursive: true })
    const dockerHome = process.env.FAKE_DOCKER_HOME!
    const launch = makeLauncher(cfg, store, { buildCommands: (t) => shimCommands('ok', `petree-${t.id}`) })
    await launch(task)
    expect(existsSync(join(dockerHome, `petree-${task.id}.pid`))).toBe(false)
  })

  it('commits the agent changes on the task branch after a run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-home-'))
    mkdirSync(join(home, 'logs'), { recursive: true })
    const cfg = {
      home,
      defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null, instructions: '' },
      repos: { demo: { url: `file://${makeFixtureRepo()}`, defaultBranch: 'main', image: 'sandbox-node', instructions: '', setup: [], build: [], test: [], skills: [], defaultModel: null } },
      allowClone: [],
    }
    const store = new TaskStore(join(home, 'petree.db'))
    const created = store.create({ prompt: 'edit the readme', repos: ['demo'], tokenBudget: 500000, timeoutMinutes: 30 })
    const task = store.transition(created.id, 'provisioning')
    // fake "claude" that writes a file into /work/demo then emits a clean done
    process.env.FAKE_CONTAINER_EXEC = JSON.stringify([process.execPath, '-e',
      `const fs=require('fs');fs.writeFileSync(process.env.WD+'/demo/added.txt','x');` +
      `console.log(JSON.stringify({type:'result',subtype:'success',result:'done'}))`])
    process.env.WD = join(home, 'work', task.id)
    try {
      const launch = makeLauncher(cfg, store, { buildCommands: (t) => shimCommands('ok', `petree-${t.id}`) })
      await launch(task)
    } finally {
      delete process.env.FAKE_CONTAINER_EXEC
      delete process.env.WD
    }
    const repoDir = join(home, 'work', task.id, 'demo')
    const msg = execFileSync('git', ['-C', repoDir, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim()
    expect(msg).toContain(`petree ${task.id}`)
    const branch = execFileSync('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(branch).toBe(`petree/${task.id}`)
  })

  it('surfaces a commit failure on task.error without clobbering a successful result', async () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-home-'))
    mkdirSync(join(home, 'logs'), { recursive: true })
    const cfg = {
      home,
      defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null, instructions: '' },
      repos: { demo: { url: `file://${makeFixtureRepo()}`, defaultBranch: 'main', image: 'sandbox-node', instructions: '', setup: [], build: [], test: [], skills: [], defaultModel: null } },
      allowClone: [],
    }
    const store = new TaskStore(join(home, 'petree.db'))
    const created = store.create({ prompt: 'edit the readme', repos: ['demo'], tokenBudget: 500000, timeoutMinutes: 30 })
    const task = store.transition(created.id, 'provisioning')
    // fake "claude" that wrecks the repo's .git dir before exiting cleanly, so the
    // post-run commit step fails
    process.env.FAKE_CONTAINER_EXEC = JSON.stringify([process.execPath, '-e',
      `const fs=require('fs');fs.rmSync(process.env.WD+'/demo/.git',{recursive:true,force:true});` +
      `console.log(JSON.stringify({type:'result',subtype:'success',result:'done'}))`])
    process.env.WD = join(home, 'work', task.id)
    try {
      const launch = makeLauncher(cfg, store, { buildCommands: (t) => shimCommands('ok', `petree-${t.id}`) })
      await launch(task)
    } finally {
      delete process.env.FAKE_CONTAINER_EXEC
      delete process.env.WD
    }
    const finished = store.get(task.id)!
    expect(finished.state).toBe('done')
    expect(finished.result).toBe('done')
    expect(finished.error).toMatch(/commit failed for demo/)
  })

  it('runs a follow-up turn in the same workspace, stacking commits on the task branch', async () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-home-'))
    mkdirSync(join(home, 'logs'), { recursive: true })
    const cfg: PetreeConfig = {
      home,
      defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null },
      repos: { demo: { url: `file://${makeFixtureRepo()}`, defaultBranch: 'main', image: 'sandbox-node', setup: [], test: [], skills: [], defaultModel: null } },
      allowClone: [],
    }
    const store = new TaskStore(join(home, 'petree.db'))
    const created = store.create({ prompt: 'investigate', repos: ['demo'], tokenBudget: 500000, timeoutMinutes: 30 })
    const writer = (file: string) => [process.execPath, '-e',
      `const fs=require('fs');fs.writeFileSync(process.env.WD+'/demo/${file}','x');` +
      `console.log(JSON.stringify({type:'result',subtype:'success',result:'done ${file}'}))`]
    let file = 'turn1.txt'
    process.env.WD = join(home, 'work', created.id)
    const launch = makeLauncher(cfg, store, { buildCommands: (t) => shimCommands('ok', `petree-${t.id}`) })

    try {
      process.env.FAKE_CONTAINER_EXEC = JSON.stringify(writer(file))
      await launch(store.transition(created.id, 'provisioning'))
      expect(store.get(created.id)?.state).toBe('done')

      const followed = store.followUp(created.id, 'implement it')
      expect(followed.state).toBe('queued')
      file = 'turn2.txt'
      process.env.FAKE_CONTAINER_EXEC = JSON.stringify(writer(file))
      await launch(store.transition(created.id, 'provisioning'))
    } finally {
      delete process.env.FAKE_CONTAINER_EXEC
      delete process.env.WD
    }

    const finished = store.get(created.id)!
    expect(finished.state).toBe('done')
    expect(finished.result).toBe('done turn2.txt')
    expect(finished.turns).toHaveLength(1)
    const repoDir = join(home, 'work', created.id, 'demo')
    expect(existsSync(join(repoDir, 'turn1.txt'))).toBe(true)
    expect(existsSync(join(repoDir, 'turn2.txt'))).toBe(true)
    const branch = execFileSync('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(branch).toBe(`petree/${created.id}`)
    const subjects = execFileSync('git', ['-C', repoDir, 'log', '--pretty=%s'], { encoding: 'utf8' }).trim().split('\n')
    expect(subjects.filter((s) => s.startsWith(`petree ${created.id}`)).length).toBe(2)
    expect(subjects[0]).toContain('implement it')
  })

  it('reattach on a live container finalizes the turn without double-counting', async () => {
    const { home, cfg, store, task } = setup()
    mkdirSync(join(home, 'logs'), { recursive: true })
    const dockerHome = process.env.FAKE_DOCKER_HOME!
    const name = `petree-${task.id}`
    // simulate the pre-restart server: container started, first 2 lines already
    // streamed into the petree log and their usage persisted
    execFileSync(process.execPath, [shim, 'run', name, 'slow'])
    store.transition(task.id, 'running')
    store.patch(task.id, { startedAt: new Date().toISOString(), logOffset: 0 })
    await new Promise((r) => setTimeout(r, 300)) // let init+usage lines land in the fake log
    const streamed = readFileSync(join(dockerHome, `${name}.log`), 'utf8')
    writeFileSync(join(home, 'logs', `${task.id}.log`), streamed, { mode: 0o600 })
    store.addUsage(task.id, 150)

    const launch = makeLauncher(cfg, store, {
      buildCommands: (t) => shimCommands('slow', `petree-${t.id}`),
    })
    await launch.reattach(store.get(task.id)!)

    const finished = store.get(task.id)!
    expect(finished.state).toBe('done')
    expect(finished.result).toBe('too late')
    expect(finished.tokensUsed).toBe(150)
    const log = readFileSync(join(home, 'logs', `${task.id}.log`), 'utf8')
    expect(log.match(/sess-123/g)).toHaveLength(1)
  })

  it('reattach on an exited container completes the turn and the commit capture', async () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-home-'))
    mkdirSync(join(home, 'logs'), { recursive: true })
    const cfg: PetreeConfig = {
      home,
      defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null, instructions: '' },
      repos: { demo: { url: `file://${makeFixtureRepo()}`, defaultBranch: 'main', image: 'sandbox-node', instructions: '', setup: [], build: [], test: [], skills: [], defaultModel: null } },
      allowClone: [],
    }
    const store = new TaskStore(join(home, 'petree.db'))
    const created = store.create({ prompt: 'edit the readme', repos: ['demo'], tokenBudget: 500000, timeoutMinutes: 30 })
    const name = `petree-${created.id}`
    const launch = makeLauncher(cfg, store, {
      buildCommands: (t) => shimCommands('ok', `petree-${t.id}`),
    })
    const task = store.transition(created.id, 'provisioning')
    process.env.FAKE_CONTAINER_EXEC = JSON.stringify([process.execPath, '-e',
      `const fs=require('fs');fs.writeFileSync('${join(home, 'work', created.id, 'demo')}/offline.txt','x');` +
      `console.log(JSON.stringify({type:'result',subtype:'success',result:'offline done'}))`])
    try {
      // simulate: container ran to completion while the server was down
      store.transition(task.id, 'running')
      store.patch(task.id, { startedAt: new Date().toISOString(), logOffset: 0 })
      await prepareWorkspace(cfg, task.repos, join(home, 'work', task.id), task.id)
      execFileSync(process.execPath, [shim, 'run', name, 'ok'])
      execFileSync(process.execPath, [shim, 'wait', name])
      await launch.reattach(store.get(task.id)!)
    } finally {
      delete process.env.FAKE_CONTAINER_EXEC
    }
    const finished = store.get(task.id)!
    expect(finished.state).toBe('done')
    expect(finished.result).toBe('offline done')
    const repoDir = join(home, 'work', task.id, 'demo')
    const msg = execFileSync('git', ['-C', repoDir, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim()
    expect(msg).toContain(`petree ${task.id}`)
  })

  it('reattach clamps the timeout to the persisted turn start', async () => {
    const { home, cfg, store, task } = setup({ timeoutMinutes: 0.01 }) // 600ms
    mkdirSync(join(home, 'logs'), { recursive: true })
    await prepareWorkspace(cfg, task.repos, join(home, 'work', task.id), task.id)
    const name = `petree-${task.id}`
    execFileSync(process.execPath, [shim, 'run', name, 'slow'])
    store.transition(task.id, 'running')
    store.patch(task.id, { startedAt: new Date(Date.now() - 60_000).toISOString(), logOffset: 0 })
    const launch = makeLauncher(cfg, store, {
      buildCommands: (t) => shimCommands('slow', `petree-${t.id}`),
    })
    await launch.reattach(store.get(task.id)!)
    expect(store.get(task.id)?.state).toBe('paused-limit')
    expect(store.get(task.id)?.error).toBe('timeout')
  })
})

describe('inspectContainerState via the shim', () => {
  it('reports running/exited/absent against the fake docker daemon', async () => {
    const name = 'petree-inspect-1'
    execFileSync(process.execPath, [shim, 'run', name, 'slow'])
    expect(await inspectContainerState([process.execPath, shim, 'inspect', name])).toBe('running')
    execFileSync(process.execPath, [shim, 'stop', name])
    expect(await inspectContainerState([process.execPath, shim, 'inspect', name])).toBe('exited')
    execFileSync(process.execPath, [shim, 'rm', name])
    expect(await inspectContainerState([process.execPath, shim, 'inspect', name])).toBe('absent')
  })
})
