import { describe, it, expect } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import { cardFor } from '../src/inbox.js'
import type { ThreadStatus } from '../src/notes.js'
import type { TaskRecord } from '../src/store.js'

const cfg = {
  home: '/h',
  defaults: { timeoutMinutes: 30, tokenBudget: 1, concurrency: 1, defaultModel: null, instructions: '' },
  repos: { demo: { tags: ['work'], url: 'https://github.com/o/r.git' }, az: { tags: [], url: 'https://dev.azure.com/o/p/_git/r' } },
  allowClone: [],
} as unknown as PetreeConfig

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'abc123', prompt: 'fix the bug\nmore', repos: ['demo'], mode: 'unattended',
    state: 'waiting-for-you', sessionId: null, tokensUsed: 0, tokenBudget: 1,
    timeoutMinutes: 30, error: null, result: null, model: null, turns: [], createdAt: '', updatedAt: '',
    restarts: 0, retryAt: null, startedAt: null, logOffset: 0, stage: 'investigate', comments: [], delivery: {}, party: true, autoPlay: false,
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

  const built = (delivery: TaskRecord['delivery']) => task({ stage: 'build', state: 'done', delivery })
  const gh = 'https://github.com/o/r/pull/7'
  const open = { ahead: 2, head: 'a', target: 'feat', url: gh, number: 7, pr: 'open' as const, prHead: 'a' }
  const ship = (d: TaskRecord['delivery']) => marks(built(d)).slice(3)

  it.each([
    ['no delivery record', {}, ['skipped', 'skipped']],
    ['no commits', { demo: { ahead: 0, head: 'a' } }, ['skipped', 'skipped']],
    ['commits, no PR', { demo: { ahead: 1, head: 'a' } }, ['current', 'todo']],
    ['pushed to an untracked host', { demo: { ahead: 1, head: 'a', target: 'f', untracked: 'gh not installed' } }, ['done', 'todo']],
    ['PR open', { demo: open }, ['done', 'current']],
    ['PR merged', { demo: { ...open, pr: 'merged' as const } }, ['done', 'done']],
    ['PR closed', { demo: { ...open, pr: 'closed' as const } }, ['done', 'todo']],
    ['one repo shipped, one not', { demo: open, b: { ahead: 1, head: 'b' } }, ['current', 'current']],
  ])('SHIP/VICTORY: %s', (_n, d, expected) => {
    expect(ship(d)).toEqual(expected)
  })

  it('SHIP/VICTORY stay todo until the build is done', () => {
    expect(marks(task({ stage: 'build', state: 'running', delivery: { demo: open } })).slice(3)).toEqual(['todo', 'todo'])
  })

  it.each([
    ['unshipped commits', { demo: { ahead: 1, head: 'a' } }, 'Open the PR', 'Build finished'],
    ['PR head behind local head', { demo: { ...open, head: 'b' } }, 'Push the update to PR #7', 'PR #7 open — waiting for merge'],
    ['open PR on GitHub', { demo: open }, 'Merge PR #7 on GitHub', 'PR #7 open — waiting for merge'],
    ['open PR on Azure', { az: { ...open, url: 'https://dev.azure.com/o/p/_git/r/pullrequest/7' } }, 'Merge PR #7 on Azure DevOps', 'PR #7 open — waiting for merge'],
  ])('PR action and line: %s', (_n, d, label, line) => {
    const c = cardFor(built(d), null, cfg)
    expect(c).toMatchObject({ group: 'your-move', action: { label }, line })
  })

  it('lists PRs on the card, and a pushed-only repo has none', () => {
    const c = cardFor(built({ demo: open, b: { ahead: 1, head: 'b', target: 'x' } }), null, cfg)
    expect(c.prs).toEqual([{ repo: 'demo', url: gh, pr: 'open', number: 7 }])
  })

  it('moving back resets later steps to todo', () => {
    expect(marks(task({ stage: 'spec', state: 'running', turns: [turn('investigate'), turn('spec'), turn('build')] })))
      .toEqual(['done', 'current', 'todo', 'todo', 'todo'])
  })
})
