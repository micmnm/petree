import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { CliRunner } from '../src/runner.js'
import type { RunnerEvent } from '../src/stream.js'

const fake = (mode: string): string[] => [
  process.execPath,
  fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url)),
  mode,
]

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
    const { events, runner } = await run({ command: fake('ok'), timeoutMs: 5000, tokenBudget: 500000 })
    expect(events).toContainEqual({ type: 'session', sessionId: 'sess-123' })
    expect(events).toContainEqual({ type: 'done', result: 'all tests pass' })
    expect(runner.tokensUsed()).toBe(150)
  })

  it('kills the child and emits limit when the token budget is exceeded', async () => {
    const { events } = await run({ command: fake('big-usage'), timeoutMs: 5000, tokenBudget: 1000 })
    expect(events).toContainEqual({ type: 'limit', reason: 'token-budget' })
    expect(events.find((e) => e.type === 'done')).toBeUndefined()
  })

  it('kills the child and emits limit on timeout', async () => {
    const { events } = await run({ command: fake('slow'), timeoutMs: 200, tokenBudget: 500000 })
    expect(events).toContainEqual({ type: 'limit', reason: 'timeout' })
  })

  it('emits error on nonzero exit without a result', async () => {
    const { events } = await run({ command: fake('crash'), timeoutMs: 5000, tokenBudget: 500000 })
    expect(events).toContainEqual({ type: 'error', message: 'exit code 3' })
  })

  it('counts duplicated usage messages (same message id) only once', async () => {
    const { runner } = await run({ command: fake('dup-usage'), timeoutMs: 5000, tokenBudget: 500000 })
    expect(runner.tokensUsed()).toBe(150)
  })

  it('emits an error and closes when the child fails to spawn', async () => {
    const { events } = await run({
      command: ['definitely-not-a-real-binary-petree'],
      timeoutMs: 5000,
      tokenBudget: 500000,
    })
    expect(events.some((e) => e.type === 'error')).toBe(true)
  })

  it('suppresses events emitted after done (settle gate) and does not pollute usage counting', async () => {
    const { events, runner } = await run({ command: fake('chatty-after-done'), timeoutMs: 5000, tokenBudget: 500000 })
    const doneIndex = events.findIndex((e) => e.type === 'done')
    expect(doneIndex).toBeGreaterThanOrEqual(0)
    const after = events.slice(doneIndex + 1)
    expect(after.some((e) => e.type === 'usage')).toBe(false)
    expect(after.some((e) => e.type === 'session')).toBe(false)
    expect(runner.tokensUsed()).toBe(150)
  })

  it('seeds tokensUsed from alreadyUsed', async () => {
    const { runner } = await run({ command: fake('ok'), timeoutMs: 5000, tokenBudget: 500000, alreadyUsed: 100 })
    expect(runner.tokensUsed()).toBe(250)
  })

  it('emits limit immediately without spawning when the budget is already exhausted', async () => {
    const { events } = await run({
      command: fake('ok'),
      timeoutMs: 5000,
      tokenBudget: 500000,
      alreadyUsed: 500000,
    })
    expect(events).toContainEqual({ type: 'limit', reason: 'token-budget' })
  })
})
