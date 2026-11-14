import { describe, it, expect } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import { cardFor } from '../src/inbox.js'
import type { Questionnaire } from '../src/interview.js'
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
    seq: 21, bin: null, binReason: null, binnedAt: null, archivedAt: null,
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

  it('a turn that timed out is a move to resume, not out of tokens', () => {
    const withBuild = { ...cfg, defaults: { ...cfg.defaults, buildTimeoutMinutes: 180 } } as PetreeConfig
    expect(cardFor(task({ state: 'paused-limit', stage: 'build', error: 'timeout' }), null, withBuild)).toMatchObject({
      line: 'Timed out in CRAFT', group: 'your-move', action: { label: 'The CRAFT turn hit its time limit — RESUME gives it 180 min' },
    })
    expect(cardFor(task({ state: 'paused-limit', stage: 'spec', error: 'timeout' }), null, withBuild).action?.label).toBe('The PLAN turn hit its time limit — RESUME gives it 30 min')
  })

  it('shows paused-by-you as a move and out-of-tokens as game over', () => {
    expect(cardFor(task({ state: 'cancelled' }), null, cfg)).toMatchObject({
      line: 'Paused by you', group: 'your-move', action: { label: 'Paused — resume or send a note' },
    })
  })

  it('takes bin, reason and Q-number from the columns, with no action', () => {
    const binned = task({ state: 'paused-limit', bin: 'game-over', binReason: 'out of tokens' })
    expect(cardFor(binned, status, cfg)).toMatchObject({ q: 21, group: 'game-over', reason: 'out of tokens', line: 'out of tokens', action: null })
    const hof = task({ state: 'done', stage: 'build', bin: 'hall-of-fame', binReason: 'merged · PR #7' })
    expect(cardFor(hof, null, cfg)).toMatchObject({ group: 'hall-of-fame', reason: 'merged · PR #7', action: null })
  })

  it('says Preparing questions while an ask-phase turn runs', () => {
    const now = new Date('2026-01-01T00:03:00Z')
    const t = task({ state: 'running', stage: 'spec', interview: true, startedAt: '2026-01-01T00:00:00Z' })
    expect(cardFor(t, null, cfg, now)).toMatchObject({ line: 'Preparing questions · PLAN · 3m', group: 'questing' })
    expect(cardFor({ ...t, interview: false }, null, cfg, now).line).toBe('Running PLAN · 3m')
    expect(cardFor({ ...t, stage: 'build' }, null, cfg, now).line).toBe('Running CRAFT · 3m')
  })

  it('carries the first question, its guess and allGuessed in card.ask', () => {
    const asked: Questionnaire = {
      round: 2, intro: '', whyMore: '', outlook: null, dropped: [],
      questions: [
        { id: 'a', kind: 'choice', q: 'Which?', why: '', options: [{ id: 'x', label: 'Ex' }, { id: 'y', label: 'Why' }], guess: 'y' },
        { id: 'b', kind: 'yesno', q: 'Sure?', why: '', guess: null },
      ],
    }
    const w = task({ stage: 'spec' })
    expect(cardFor(w, null, cfg, undefined, asked).ask).toEqual({ round: 2, count: 2, first: { q: 'Which?', guess: 'Why' }, allGuessed: false })
    const all = { ...asked, questions: [asked.questions[0]] }
    expect(cardFor(w, null, cfg, undefined, all).ask).toMatchObject({ count: 1, allGuessed: true })
    expect(cardFor(w, null, cfg, undefined, { ...all, questions: [{ ...all.questions[0], guess: null }] }).ask?.first.guess).toBeNull()
    expect(cardFor(w, null, cfg).ask).toBeNull()
    expect(cardFor({ ...w, bin: 'game-over' }, null, cfg, undefined, asked).ask).toBeNull()
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
    expect(cardFor(task({ bin: 'hall-of-fame', binReason: 'finished · findings kept' }), null, cfg).progress[0]).toEqual({ step: 'investigate', mark: 'current' })
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

  it('offers the PR again when the push landed but PR creation failed, unless the host is untracked', () => {
    expect(cardFor(built({ demo: { ahead: 1, head: 'a', target: 'feat' } }), null, cfg).action?.label).toBe('Open the PR')
    const local = { ...cfg, repos: { ...cfg.repos, local: { tags: [], url: 'file:///x' } } } as unknown as PetreeConfig
    expect(cardFor(built({ local: { ahead: 1, head: 'a', target: 'feat', untracked: 'unsupported host' } }), null, local).action).toBeNull()
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

describe('prLabel with multi-host repos', () => {
  const cfgMultiHost = {
    home: '/h',
    defaults: { timeoutMinutes: 30, tokenBudget: 1, concurrency: 1, defaultModel: null, instructions: '' },
    repos: {
      github: { tags: [], url: 'https://github.com/org/repo.git' },
      azure: { tags: [], url: 'https://dev.azure.com/org/project/_git/repo' },
      github2: { tags: [], url: 'https://github.com/org/repo2.git' },
    },
    allowClone: [],
  } as unknown as PetreeConfig

  const built = (delivery: TaskRecord['delivery']) => task({ stage: 'build', state: 'done', delivery, repos: Object.keys(delivery) as any })

  it('single-host task shows label unchanged', () => {
    const d = { github: { ahead: 1, head: 'a' } }
    const c = cardFor(built(d), null, cfgMultiHost)
    expect(c.action?.label).toBe('Open the PR')
  })

  it('multi-host task with different hosts shows combined hosts in label', () => {
    const d = {
      github: { ahead: 1, head: 'a' },
      azure: { ahead: 1, head: 'b' },
    }
    const c = cardFor(built(d), null, cfgMultiHost)
    expect(c.action?.label).toBe('Open the PR (azure+github)')
  })

  it('multi-host task with all GitHub repos shows label unchanged', () => {
    const d = {
      github: { ahead: 1, head: 'a' },
      github2: { ahead: 1, head: 'b' },
    }
    const c = cardFor(built(d), null, cfgMultiHost)
    expect(c.action?.label).toBe('Open the PR')
  })

  it('multi-host for "Merge PR" label appends combined hosts', () => {
    const gh = 'https://github.com/org/repo/pull/1'
    const az = 'https://dev.azure.com/org/project/_git/repo/pullrequest/2'
    const d = {
      github: { ahead: 1, head: 'a', url: gh, number: 1, pr: 'open' as const, prHead: 'a' },
      azure: { ahead: 1, head: 'b', url: az, number: 2, pr: 'open' as const, prHead: 'b' },
    }
    const c = cardFor(built(d), null, cfgMultiHost)
    expect(c.action?.label).toBe('Merge PR #1 on (azure+github)')
  })

  it('multi-host for "Push the update" label appends combined hosts', () => {
    const gh = 'https://github.com/org/repo/pull/1'
    const az = 'https://dev.azure.com/org/project/_git/repo/pullrequest/2'
    const d = {
      github: { ahead: 1, head: 'a', url: gh, number: 1, pr: 'open' as const, prHead: 'a', target: 'feat' },
      azure: { ahead: 1, head: 'b', url: az, number: 2, pr: 'open' as const, prHead: 'b', target: 'feat' },
    }
    const c = cardFor(built(d), null, cfgMultiHost)
    // When there's a stale PR (prHead !== head), it uses "Push the update" label
    const c2 = cardFor(built({ ...d, github: { ...d.github, head: 'c' } } as any), null, cfgMultiHost)
    expect(c2.action?.label).toBe('Push the update to PR #1 (azure+github)')
  })
})
