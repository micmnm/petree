import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, it, expect } from 'vitest'
import { CliRunner, type SandboxProcessCommands } from '../src/runner.js'
import type { RunnerEvent } from '../src/stream.js'

const shim = fileURLToPath(new URL('./fixtures/fake-docker.js', import.meta.url))
let home: string
let seq = 0

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'petree-runner-'))
  process.env.FAKE_DOCKER_HOME = home
})

function commands(scenario: string, name = `c${++seq}`): SandboxProcessCommands & { name: string } {
  const d = (...a: string[]) => [process.execPath, shim, ...a]
  return {
    name,
    create: d('run', name, scenario),
    stream: d('logs', '-f', name),
    wait: d('wait', name),
    kill: d('stop', name),
  }
}

function run(opts: ConstructorParameters<typeof CliRunner>[0]): Promise<{ events: RunnerEvent[]; runner: CliRunner }> {
  return new Promise((resolve) => {
    const runner = new CliRunner(opts)
    const events: RunnerEvent[] = []
    runner.on('event', (e: RunnerEvent) => events.push(e))
    runner.on('closed', () => resolve({ events, runner }))
    runner.start()
  })
}

describe('CliRunner', () => {
  it('emits session, usage and done for a clean run', async () => {
    const { events, runner } = await run({ commands: commands('ok'), timeoutMs: 10_000, tokenBudget: 500000 })
    expect(events).toContainEqual({ type: 'session', sessionId: 'sess-123' })
    expect(events).toContainEqual({ type: 'done', result: 'all tests pass' })
    expect(runner.tokensUsed()).toBe(150)
  })

  it('stops the container and emits limit when the token budget is exceeded', async () => {
    const c = commands('big-usage')
    const { events } = await run({ commands: c, timeoutMs: 10_000, tokenBudget: 1000 })
    expect(events).toContainEqual({ type: 'limit', reason: 'token-budget' })
    expect(events.find((e) => e.type === 'done')).toBeUndefined()
    expect(existsSync(join(home, `${c.name}.exit`))).toBe(true)
  })

  it('stops the container and emits limit on timeout', async () => {
    const { events } = await run({ commands: commands('slow'), timeoutMs: 300, tokenBudget: 500000 })
    expect(events).toContainEqual({ type: 'limit', reason: 'timeout' })
  })

  it('emits error with the container exit code on a crash', async () => {
    const { events } = await run({ commands: commands('crash'), timeoutMs: 10_000, tokenBudget: 500000 })
    expect(events).toContainEqual({ type: 'error', message: 'exit code 3' })
  })

  it('counts duplicated usage messages (same message id) only once', async () => {
    const { runner } = await run({ commands: commands('dup-usage'), timeoutMs: 10_000, tokenBudget: 500000 })
    expect(runner.tokensUsed()).toBe(150)
  })

  it('emits an error when the create command fails (name conflict)', async () => {
    const first = commands('slow', 'conflict-1')
    execFileSync(process.execPath, first.create!.slice(1), { env: process.env as NodeJS.ProcessEnv })
    const { events } = await run({ commands: commands('ok', 'conflict-1'), timeoutMs: 10_000, tokenBudget: 500000 })
    expect(events.some((e) => e.type === 'error' && e.message.includes('in use'))).toBe(true)
    execFileSync(process.execPath, [shim, 'stop', 'conflict-1'])
  })

  it('emits the LAST result as done and counts usage across all turns', async () => {
    const { events, runner } = await run({ commands: commands('two-results'), timeoutMs: 10_000, tokenBudget: 500000 })
    const dones = events.filter((e) => e.type === 'done')
    expect(dones).toHaveLength(1)
    expect(dones[0]).toEqual({ type: 'done', result: 'final answer' })
    expect(runner.tokensUsed()).toBe(210)
  })

  it('seeds tokensUsed from alreadyUsed', async () => {
    const { runner } = await run({ commands: commands('ok'), timeoutMs: 10_000, tokenBudget: 500000, alreadyUsed: 100 })
    expect(runner.tokensUsed()).toBe(250)
  })

  it('emits limit immediately without any container when the budget is already exhausted', async () => {
    const c = commands('ok')
    const { events } = await run({ commands: c, timeoutMs: 10_000, tokenBudget: 500000, alreadyUsed: 500000 })
    expect(events).toContainEqual({ type: 'limit', reason: 'token-budget' })
    expect(existsSync(join(home, `${c.name}.pid`))).toBe(false)
  })

  it('re-attaches without a create command to a container started elsewhere', async () => {
    const pre = commands('ok', 'reattach-1')
    execFileSync(process.execPath, pre.create!.slice(1))
    const { events } = await run({
      commands: { stream: pre.stream, wait: pre.wait, kill: pre.kill },
      timeoutMs: 10_000, tokenBudget: 500000,
    })
    expect(events).toContainEqual({ type: 'done', result: 'all tests pass' })
  })

  it('re-attaches to an already-exited container and still finalizes', async () => {
    const pre = commands('ok', 'reattach-2')
    execFileSync(process.execPath, pre.create!.slice(1))
    execFileSync(process.execPath, [shim, 'wait', 'reattach-2'])
    const { events } = await run({
      commands: { stream: pre.stream, wait: pre.wait, kill: pre.kill },
      timeoutMs: 10_000, tokenBudget: 500000,
    })
    expect(events).toContainEqual({ type: 'done', result: 'all tests pass' })
  })

  it('skipLines replays without re-emitting or double-counting', async () => {
    // 'ok' emits 3 stdout lines: init, usage(m1: 150), result.
    // Pretend the first 2 were processed before a restart (tokens persisted).
    const pre = commands('ok', 'replay-1')
    execFileSync(process.execPath, pre.create!.slice(1))
    execFileSync(process.execPath, [shim, 'wait', 'replay-1'])
    const { events, runner } = await run({
      commands: { stream: pre.stream, wait: pre.wait, kill: pre.kill },
      timeoutMs: 10_000, tokenBudget: 500000, alreadyUsed: 150, skipLines: 2,
    })
    expect(runner.tokensUsed()).toBe(150) // not 300
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'log')).toHaveLength(1) // only the result line
    expect(events).toContainEqual({ type: 'done', result: 'all tests pass' })
  })

  it('session events are re-emitted even during replay (idempotent patch)', async () => {
    const pre = commands('ok', 'replay-2')
    execFileSync(process.execPath, pre.create!.slice(1))
    execFileSync(process.execPath, [shim, 'wait', 'replay-2'])
    const { events } = await run({
      commands: { stream: pre.stream, wait: pre.wait, kill: pre.kill },
      timeoutMs: 10_000, tokenBudget: 500000, alreadyUsed: 150, skipLines: 3,
    })
    expect(events).toContainEqual({ type: 'session', sessionId: 'sess-123' })
  })
})
