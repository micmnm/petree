import type { PetreeConfig } from './config.js'
import { cardFor } from './inbox.js'
import { STAGES } from './store.js'
import type { Stage, TaskRecord } from './store.js'
import type { TurnStats } from './stats.js'

export interface RepoUsage {
  quests: number
  won: number
  lost: number
  inPlay: number
  lastQuestAt: string | null
  monthMs: number
  weekly: number[] // quests created per week, oldest first, 8 weeks
  ended: Record<Stage, number> // highest level each quest reached
  avgTurns: number
  topModel: string | null
}

const WEEK_MS = 7 * 86_400_000

// A win is a merge; findings kept or pushed-untracked are hall-of-fame but not wins.
const merged = (t: TaskRecord) => t.bin === 'hall-of-fame' && !!t.binReason?.startsWith('merged')

export interface Hud { xp: number; lv: number; bar: number; streak: number }

// Spec §5.11. Days are the server's local days; a merge's day is its latest mergedAt, else binnedAt.
export function hud(tasks: TaskRecord[], now: Date = new Date()): Hud {
  const days = new Set<string>()
  let xp = 0
  for (const t of tasks.filter(merged)) {
    xp++
    const at = Object.values(t.delivery).map((d) => d.mergedAt).filter(Boolean).sort().at(-1) ?? t.binnedAt
    if (at) days.add(new Date(at).toDateString())
  }
  const d = new Date(now)
  if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1) // today without a merge yet keeps yesterday's streak
  let streak = 0
  while (days.has(d.toDateString())) { streak++; d.setDate(d.getDate() - 1) }
  return { xp, lv: 1 + Math.floor(xp / 5), bar: xp % 5, streak }
}

// Per-repo aggregates over every row; a few hundred rows in JS per request, no cache.
export function repoUsage(tasks: TaskRecord[], cfg: PetreeConfig, now: Date = new Date()): Record<string, RepoUsage> {
  const month = now.toISOString().slice(0, 7)
  const out: Record<string, RepoUsage> = {}
  const turnSums: Record<string, { turns: number; n: number }> = {}
  const models: Record<string, Record<string, number>> = {}
  for (const name of Object.keys(cfg.repos)) {
    out[name] = {
      quests: 0, won: 0, lost: 0, inPlay: 0, lastQuestAt: null, monthMs: 0, weekly: Array(8).fill(0),
      ended: { investigate: 0, spec: 0, build: 0 }, avgTurns: 0, topModel: null,
    }
    turnSums[name] = { turns: 0, n: 0 }
    models[name] = {}
  }

  for (const t of tasks) {
    const group = cardFor(t, null, cfg, now).group
    const runs: { s: TurnStats; at: string }[] = [
      ...t.turns.flatMap((x) => (x.stats ? [{ s: x.stats, at: x.endedAt }] : [])),
      ...(t.turnStats ? [{ s: t.turnStats, at: t.updatedAt }] : []),
    ]
    const level = Math.max(STAGES.indexOf(t.stage), ...t.turns.map((x) => STAGES.indexOf(x.stage)))
    const week = Math.floor((now.getTime() - Date.parse(t.createdAt)) / WEEK_MS)
    for (const name of t.repos) {
      const u = out[name]
      if (!u) continue
      u.quests++
      if (group === 'hall-of-fame') { if (merged(t)) u.won++ }
      else if (group === 'game-over') u.lost++
      else if (!t.archivedAt) u.inPlay++
      if (!u.lastQuestAt || t.createdAt > u.lastQuestAt) u.lastQuestAt = t.createdAt
      if (week >= 0 && week < 8) u.weekly[7 - week]++
      u.ended[STAGES[level]]++
      if (runs.length) { turnSums[name].turns += runs.reduce((n, r) => n + r.s.turns, 0); turnSums[name].n++ }
      for (const { s, at } of runs) {
        if (at.startsWith(month)) u.monthMs += s.wallMs
        if (s.model) models[name][s.model] = (models[name][s.model] ?? 0) + 1
      }
    }
  }

  for (const [name, u] of Object.entries(out)) {
    const { turns, n } = turnSums[name]
    u.avgTurns = n ? turns / n : 0
    u.topModel = Object.entries(models[name]).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }
  return out
}
