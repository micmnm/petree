import { describe, it, expect } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import { cardFor } from '../src/inbox.js'
import type { ThreadStatus } from '../src/notes.js'
import type { TaskRecord } from '../src/store.js'

const cfg = {
  home: '/h',
  defaults: { timeoutMinutes: 30, tokenBudget: 1, concurrency: 1, defaultModel: null, instructions: '' },
  repos: { demo: { tags: ['work'] } },
  allowClone: [],
} as unknown as PetreeConfig

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'abc123', prompt: 'fix the bug\nmore', repos: ['demo'], mode: 'unattended',
    state: 'waiting-for-you', sessionId: null, tokensUsed: 0, tokenBudget: 1,
    timeoutMinutes: 30, error: null, result: null, model: null, turns: [], createdAt: '', updatedAt: '',
    restarts: 0, retryAt: null, startedAt: null, logOffset: 0, stage: 'investigate', comments: [],
    ...over,
  }
}

const status: ThreadStatus = { topic: 'Auth bug', status: 'Found the cause.', needsYou: 'Pick option A or B.' }
const marks = (t: TaskRecord) => cardFor(t, null, cfg).progress.map((p) => p.mark)

describe('cardFor', () => {
  it('uses fresh agent text for topic, summary and action detail', () => {
    const c = cardFor(task(), status, cfg)
    expect(c).toMatchObject({
      topic: 'Auth bug', summary: 'Found the cause.', line: 'Found the cause.', group: 'your-move',
      action: { label: 'Read the findings, then approve or comment', detail: 'Pick option A or B.' },
      repos: [{ name: 'demo', tags: ['work'] }],
    })
  })

  it('falls back to the thread title and engine text without a status', () => {
    const c = cardFor(task({ stage: 'spec' }), null, cfg)
    expect(c).toMatchObject({ topic: 'fix the bug', summary: 'Spec ready', line: 'Spec ready' })
    expect(c.action).toEqual({ label: 'Read the spec, then approve or comment', detail: null })
  })

  it('shows engine state for active threads, in QUESTING', () => {
    const now = new Date('2026-01-01T00:12:00Z')
    const run = cardFor(task({ state: 'running', stage: 'build', startedAt: '2026-01-01T00:00:00Z' }), status, cfg, now)
    expect(run).toMatchObject({ line: 'Running CRAFT · 12m', group: 'questing', action: null })
    expect(cardFor(task({ state: 'queued' }), null, cfg).line).toBe('Queued')
    expect(cardFor(task({ state: 'provisioning' }), null, cfg).line).toBe('Preparing workspace')
    expect(cardFor(task({ state: 'paused-rate-limit' }), null, cfg)).toMatchObject({ line: 'Waiting out a rate limit', group: 'questing' })
  })

  it('keeps failed in YOUR MOVE with the failure action', () => {
    const c = cardFor(task({ state: 'failed', stage: 'spec', error: 'boom\nstack' }), null, cfg)
    expect(c).toMatchObject({
      line: 'Failed: boom', group: 'your-move',
      action: { label: 'Failed in PLAN — retry the stage or drop it' },
    })
    expect(c.progress[1]).toMatchObject({ mark: 'current', tone: 'failed' })
  })

  it('shows paused-by-you as a move and out-of-tokens as game over', () => {
    expect(cardFor(task({ state: 'cancelled' }), null, cfg)).toMatchObject({
      line: 'Paused by you', group: 'your-move', action: { label: 'Paused — resume or send a note' },
    })
    expect(cardFor(task({ state: 'paused-limit' }), null, cfg)).toMatchObject({ group: 'game-over', reason: 'out of tokens' })
  })

  it('finished build: Reply only when the agent asks something', () => {
    const done = task({ state: 'done', stage: 'build' })
    expect(cardFor(done, null, cfg)).toMatchObject({ line: 'Build finished', group: 'your-move', action: null })
    expect(cardFor(done, status, cfg).action).toEqual({ label: 'Reply', detail: 'Pick option A or B.' })
  })
})

describe('cardFor progress', () => {
  const turn = (stage: 'investigate' | 'spec' | 'build') => ({ prompt: '', result: null, tokensUsed: 0, endedAt: '', stage })

  it('marks the current stage with its tone and later steps todo', () => {
    expect(cardFor(task(), null, cfg).progress).toEqual([
      { step: 'investigate', mark: 'current', tone: 'needs-you' },
      { step: 'spec', mark: 'todo' }, { step: 'build', mark: 'todo' },
      { step: 'pr', mark: 'todo' }, { step: 'merged', mark: 'todo' },
    ])
    expect(cardFor(task({ state: 'running' }), null, cfg).progress[0].tone).toBe('running')
  })

  it('earlier stages are done if a turn ran there, else skipped', () => {
    expect(marks(task({ stage: 'build', state: 'running', turns: [turn('spec')] })))
      .toEqual(['skipped', 'done', 'current', 'todo', 'todo'])
  })

  it('build becomes done once its turn is done', () => {
    const p = cardFor(task({ stage: 'build', state: 'done', turns: [turn('investigate'), turn('spec')] }), null, cfg).progress
    expect(p[2]).toEqual({ step: 'build', mark: 'done' })
  })

  it('moving back resets later steps to todo', () => {
    expect(marks(task({ stage: 'spec', state: 'running', turns: [turn('investigate'), turn('spec'), turn('build')] })))
      .toEqual(['done', 'current', 'todo', 'todo', 'todo'])
  })
})
