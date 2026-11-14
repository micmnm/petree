import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import { TaskStore } from '../src/store.js'
import type { TaskRecord } from '../src/store.js'
import { emptyStats, mergeStats, nowPlaying, questStats, sliceStats } from '../src/stats.js'
import type { TurnStats } from '../src/stats.js'
import { hud, repoUsage } from '../src/usage.js'

const j = (o: unknown) => JSON.stringify(o)
const use = (name: string, input: unknown, id: string, extra = {}) =>
  j({ type: 'assistant', message: { id, content: [{ type: 'tool_use', id: `t_${id}`, name, input }], usage: { input_tokens: 1, output_tokens: 2 } }, ...extra })

// One process: init, tool calls (incl. a subagent), two results whose cost/usage are cumulative.
const LOG = [
  j({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', session_id: 's' }),
  use('Bash', { command: 'npm test -- --run' }, 'm1'),
  use('Bash', { command: 'ls' }, 'm2'),
  use('Read', { file_path: '/a/b.ts' }, 'm3'),
  use('Task', { subagent_type: 'Explore', prompt: 'x' }, 'm4'),
  'not json noise',
  j({ type: 'result', duration_ms: 1000, num_turns: 3, total_cost_usd: 0.5, usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 } }),
  j({
    type: 'result', duration_ms: 500, num_turns: 1, total_cost_usd: 0.75,
    usage: { input_tokens: 10, output_tokens: 40 },
    modelUsage: {
      a: { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 300, cacheCreationInputTokens: 50 },
      b: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
    },
  }),
].join('\n')

describe('sliceStats', () => {
  it('derives each field from canned stream-json', () => {
    const s = sliceStats(LOG, ['npm test'], 0, [{ repo: 'demo', files: 2, add: 5, del: 1 }])
    expect(s).toEqual({
      model: 'claude-sonnet-5', wallMs: 1500, turns: 4,
      // last result's modelUsage (covers subagents) wins over result.usage
      tokensIn: 100 + 50 + 300 + 1 + 4 + 3, tokensOut: 202, cacheRead: 303,
      costUsd: 0.75, subagents: { Explore: 1 }, tools: { Bash: 2, Read: 1, Task: 1 }, testRuns: 1,
      files: [{ repo: 'demo', files: 2, add: 5, del: 1 }],
    })
  })

  it('falls back to result.usage, then to per-message usage', () => {
    const noModel = LOG.split('\n').slice(0, 7).join('\n')
    expect(sliceStats(noModel, [], 0)).toMatchObject({ tokensIn: 60, tokensOut: 40, cacheRead: 30 })
    const noResult = LOG.split('\n').slice(0, 5).join('\n')
    expect(sliceStats(noResult, [], 7)).toMatchObject({ tokensIn: 4, tokensOut: 8, wallMs: 7, costUsd: null })
  })

  it('counts subagent messages in the per-message fallback', () => {
    const log = [use('Read', {}, 'p'), use('Read', {}, 'c', { parent_tool_use_id: 't_p' })].join('\n')
    expect(sliceStats(log, [], 0)).toMatchObject({ tokensIn: 2, tokensOut: 4 })
  })

  it('gives zeros for an empty slice', () => {
    expect(sliceStats('', [], 0)).toEqual(emptyStats())
  })
})

describe('accumulation', () => {
  const run = (n: number): TurnStats => ({ ...emptyStats(), wallMs: n, turns: n, costUsd: n, tools: { Bash: n }, files: [{ repo: 'demo', files: n, add: n, del: 0 }] })

  it('mergeStats sums numbers, maps and per-repo files', () => {
    const m = mergeStats(run(1), run(2))
    expect(m).toMatchObject({ wallMs: 3, turns: 3, costUsd: 3, tools: { Bash: 3 }, files: [{ repo: 'demo', files: 3, add: 3, del: 0 }] })
  })

  it('resumes accumulate in turn_stats; followUp archives it and clears it', () => {
    const store = new TaskStore(join(mkdtempSync(join(tmpdir(), 'petree-stats-')), 'db'))
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1 })
    store.addTurnStats(t.id, run(1))
    store.addTurnStats(t.id, run(2))
    expect(store.get(t.id)!.turnStats).toMatchObject({ wallMs: 3, turns: 3 })
    store.transition(t.id, 'provisioning')
    store.transition(t.id, 'running')
    store.transition(t.id, 'waiting-for-you')
    const f = store.followUp(t.id, 'next', undefined, 'spec')
    expect(f.turnStats).toBeNull()
    expect(f.turns[0].stats).toMatchObject({ wallMs: 3 })
  })

  it('questStats groups by stage and adds the live slice to the running turn', () => {
    const q = questStats(
      { stage: 'spec', turnStats: run(2), turns: [{ prompt: '', result: null, tokensUsed: 0, endedAt: '', stage: 'investigate', stats: run(1) }, { prompt: '', result: null, tokensUsed: 0, endedAt: '' , stage: 'investigate' }] },
      run(4),
    )
    expect(q.stages.map((s) => [s.stage, s.wallMs, s.live])).toEqual([['investigate', 1, false], ['spec', 6, true]])
    expect(q.total.wallMs).toBe(7)
    expect(questStats({ stage: 'build', turnStats: null, turns: [] }, null)).toEqual({ total: emptyStats(), stages: [] })
  })
})

const base = { prompt: 'p', mode: 'unattended', sessionId: null, tokensUsed: 0, tokenBudget: 1, timeoutMinutes: 1, error: null, result: null, model: null, restarts: 0, retryAt: null, startedAt: null, logOffset: 0, comments: [], delivery: {}, party: true, autoPlay: false, turnStats: null, seq: 1, bin: null, binReason: null, binnedAt: null, archivedAt: null }
const task = (over: Partial<TaskRecord>) => ({ ...base, id: 'x', repos: ['demo'], state: 'running', stage: 'investigate', turns: [], createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z', ...over }) as TaskRecord

describe('repoUsage', () => {
  const cfg = { home: '/h', defaults: {}, repos: { demo: { tags: [] }, idle: { tags: [] } }, allowClone: [] } as unknown as PetreeConfig
  const now = new Date('2026-11-14T12:00:00Z')
  const s =(over: Partial<TurnStats>) => ({ ...emptyStats(), ...over })

  it('aggregates fixture rows per repo', () => {
    const rows = [
      task({ id: 'a', state: 'paused-limit', bin: 'game-over', binReason: 'out of tokens', stage: 'spec', turnStats: s({ wallMs: 60, turns: 4, model: 'opus' }), turns: [{ prompt: '', result: null, tokensUsed: 0, endedAt: '2026-10-01T00:00:00Z', stage: 'investigate', stats: s({ wallMs: 999, turns: 2, model: 'opus' }) }] }),
      task({ id: 'b', stage: 'build', createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', turnStats: s({ wallMs: 40, turns: 6, model: 'haiku' }) }),
      task({ id: 'c', repos: ['demo', 'idle'], createdAt: '2026-01-01T00:00:00Z' }),
    ]
    const u = repoUsage(rows, cfg, now)
    expect(u.demo).toMatchObject({
      quests: 3, won: 0, lost: 1, inPlay: 2, lastQuestAt: '2026-11-13T00:00:00Z',
      monthMs: 100, ended: { investigate: 1, spec: 1, build: 1 }, avgTurns: 6, topModel: 'opus',
    })
    expect(u.demo.weekly).toEqual([1, 0, 0, 0, 0, 0, 0, 1])
    expect(u.idle).toMatchObject({ quests: 1, avgTurns: 0, topModel: null })
  })

  it('wins are merges only; archived rows are not in play', () => {
    const rows = [
      task({ id: 'm', state: 'done', bin: 'hall-of-fame', binReason: 'merged · PR #1' }),
      task({ id: 'f', state: 'waiting-for-you', bin: 'hall-of-fame', binReason: 'finished · findings kept' }),
      task({ id: 'o', state: 'done', archivedAt: '2026-11-01T00:00:00Z' }),
    ]
    expect(repoUsage(rows, cfg, now).demo).toMatchObject({ quests: 3, won: 1, lost: 0, inPlay: 0 })
  })
})

describe('hud', () => {
  // Local-time constructors so day boundaries hold in any TZ.
  const at = (day: number, h = 12) => new Date(2026, 10, day, h).toISOString()
  const won = (id: string, mergedAt: string | null, binnedAt = at(1)) => task({
    id, state: 'done', bin: 'hall-of-fame', binReason: 'merged · PR #1', binnedAt,
    delivery: mergedAt ? { demo: { ahead: 1, head: 'h', pr: 'merged', mergedAt } } : {},
  })
  const today = new Date(2026, 10, 14, 0, 5)

  it('is level 1 with nothing merged', () => {
    expect(hud([], today)).toEqual({ xp: 0, lv: 1, bar: 0, streak: 0 })
  })

  it('counts merges only: LV every 5, bar is the remainder', () => {
    const rows = [...'abcdefg'].map((id) => won(id, at(1)))
    rows.push(task({ id: 'f', bin: 'hall-of-fame', binReason: 'finished · findings kept' }), task({ id: 'o', bin: 'game-over', binReason: 'dropped by you' }))
    expect(hud(rows, today)).toMatchObject({ xp: 7, lv: 2, bar: 2 })
  })

  it('streak runs over local days ending today, by latest mergedAt else binnedAt', () => {
    // 14th just after midnight, 13th via binnedAt, 12th late evening; the 10th is past a gap
    const rows = [won('a', at(14, 0)), won('b', null, at(13)), won('c', at(12, 23)), won('d', at(10))]
    expect(hud(rows, today).streak).toBe(3)
    // a later merge of another repo moves the day
    const two = task({ ...won('e', null), delivery: { a: { ahead: 1, head: 'h', mergedAt: at(9) }, b: { ahead: 1, head: 'h', mergedAt: at(11) } } })
    expect(hud([...rows, two], today).streak).toBe(5)
  })

  it('a streak ending yesterday still counts; one ending earlier is broken', () => {
    expect(hud([won('a', at(13, 23)), won('b', at(12))], today).streak).toBe(2)
    expect(hud([won('a', at(12))], today).streak).toBe(0)
  })
})

describe('nowPlaying', () => {
  it('is the latest tool call, or null without one', () => {
    expect(nowPlaying(LOG)).toBe('Task · x')
    expect(nowPlaying(LOG.split('\n').slice(0, 4).join('\n'))).toBe('Read · a/b.ts')
    expect(nowPlaying('noise\n' + j({ type: 'result' }))).toBeNull()
  })
})
