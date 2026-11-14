import { existsSync, readFileSync } from 'node:fs'
import { summarizeLog } from './activity.js'
import type { Stage, TaskRecord } from './store.js'

export interface TurnStats {
  model: string | null
  wallMs: number
  turns: number
  tokensIn: number
  tokensOut: number
  cacheRead: number
  costUsd: number | null
  subagents: Record<string, number>
  tools: Record<string, number>
  testRuns: number
  files: { repo: string; files: number; add: number; del: number }[]
}

export const emptyStats = (): TurnStats => ({
  model: null, wallMs: 0, turns: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, costUsd: null,
  subagents: {}, tools: {}, testRuns: 0, files: [],
})

// The log is append-only across runs; a run's slice starts at the byte offset recorded at launch.
export function readSlice(logFile: string, offset: number): string {
  return existsSync(logFile) ? readFileSync(logFile).subarray(offset).toString('utf8') : ''
}

export function sliceStats(
  text: string, testCommands: string[], fallbackMs: number, files: TurnStats['files'] = [],
): TurnStats {
  const { stats: s } = summarizeLog(text, { testCommands })
  return {
    model: s.model, wallMs: s.wallMs || fallbackMs, turns: s.turnsSum, tokensIn: s.tokensIn,
    tokensOut: s.tokensOut, cacheRead: s.cacheRead, costUsd: s.costUsd, subagents: s.subagents,
    tools: s.toolCounts, testRuns: s.testRuns, files,
  }
}

// NOW PLAYING: the latest tool call. Only the tail is parsed; a cut first line is just noise.
export function nowPlaying(text: string): string | null {
  const e = summarizeLog(text.slice(-200_000)).entries.reverse().find((x) => x.kind === 'tool' && x.name !== 'tool result')
  return e ? [e.name, e.summary].filter(Boolean).join(' · ') : null
}

const sumMaps =(a: Record<string, number>, b: Record<string, number>) => {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v
  return out
}

// Adds one run (or one turn) onto a running total; resumes accumulate through this.
export function mergeStats(a: TurnStats | null | undefined, b: TurnStats): TurnStats {
  if (!a) return b
  const files = [...a.files]
  for (const f of b.files) {
    const i = files.findIndex((x) => x.repo === f.repo)
    files[i < 0 ? files.length : i] = i < 0 ? f : { repo: f.repo, files: files[i].files + f.files, add: files[i].add + f.add, del: files[i].del + f.del }
  }
  return {
    model: b.model ?? a.model, wallMs: a.wallMs + b.wallMs, turns: a.turns + b.turns,
    tokensIn: a.tokensIn + b.tokensIn, tokensOut: a.tokensOut + b.tokensOut, cacheRead: a.cacheRead + b.cacheRead,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
    subagents: sumMaps(a.subagents, b.subagents), tools: sumMaps(a.tools, b.tools),
    testRuns: a.testRuns + b.testRuns, files,
  }
}

export interface QuestStats {
  total: TurnStats
  stages: (TurnStats & { stage: Stage; live: boolean })[]
}

// `live` is the running turn's not-yet-stored slice, when there is one.
export function questStats(t: Pick<TaskRecord, 'turns' | 'turnStats' | 'stage'>, live: TurnStats | null): QuestStats {
  const by = new Map<Stage, { s: TurnStats; live: boolean }>()
  const put = (stage: Stage, s: TurnStats, isLive = false) => {
    const cur = by.get(stage)
    by.set(stage, { s: mergeStats(cur?.s ?? null, s), live: (cur?.live ?? false) || isLive })
  }
  for (const turn of t.turns) if (turn.stats) put(turn.stage, turn.stats)
  const current = live ? mergeStats(t.turnStats, live) : t.turnStats
  if (current) put(t.stage, current, live !== null)
  const stages = [...by].map(([stage, { s, live: l }]) => ({ stage, ...s, live: l }))
  return { total: stages.reduce((a, s) => mergeStats(a, s), emptyStats()), stages }
}
