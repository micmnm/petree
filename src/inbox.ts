import type { PetreeConfig } from './config.js'
import type { ThreadStatus } from './notes.js'
import { prHost } from './prs.js'
import { STAGES, threadTitle } from './store.js'
import type { Delivery, Stage, TaskRecord } from './store.js'

export type Group = 'your-move' | 'questing' | 'hall-of-fame' | 'game-over'
export type Step = Stage | 'pr' | 'merged'
export interface ProgressStep { step: Step; mark: 'done' | 'current' | 'skipped' | 'todo'; tone?: 'running' | 'needs-you' | 'failed' }

export interface Card {
  q: number
  topic: string
  summary: string
  line: string
  group: Group
  action: { label: string; detail: string | null } | null
  reason?: string
  progress: ProgressStep[]
  repos: { name: string; tags: string[] }[]
  prs: { repo: string; url: string; pr: Delivery['pr']; number?: number }[]
}

const LEVEL: Record<Stage, string> = { investigate: 'SCOUT', spec: 'PLAN', build: 'CRAFT' }
const READY: Record<Stage, string> = { investigate: 'Findings ready', spec: 'Spec ready', build: 'Build finished' }
const ACTIVE = ['queued', 'provisioning', 'running', 'paused-rate-limit']

function progressFor(task: TaskRecord): ProgressStep[] {
  const at = STAGES.indexOf(task.stage)
  const buildDone = task.stage === 'build' && task.state === 'done'
  // A binned quest is nobody's move, so its track carries no tone.
  const tone: ProgressStep['tone'] = task.bin ? undefined : task.state === 'failed' ? 'failed'
    : task.state === 'waiting-for-you' || task.state === 'cancelled' || (task.state === 'done' && !buildDone) ? 'needs-you'
    : ACTIVE.includes(task.state) ? 'running' : undefined
  const steps: ProgressStep[] = STAGES.map((step, i) => {
    if (i < at) return { step, mark: task.turns.some((t) => t.stage === step) ? 'done' : 'skipped' }
    if (i > at) return { step, mark: 'todo' }
    return buildDone ? { step, mark: 'done' } : { step, mark: 'current', ...(tone && { tone }) }
  })
  const committed = Object.values(task.delivery).filter((d) => d.ahead > 0)
  let ship: ProgressStep['mark'] = 'todo'
  let merged: ProgressStep['mark'] = 'todo'
  if (buildDone) {
    if (!committed.length) ship = merged = 'skipped'
    else {
      ship = committed.every((d) => d.pr || (d.untracked && d.target)) ? 'done' : 'current'
      merged = committed.every((d) => d.pr === 'merged') ? 'done' : committed.some((d) => d.pr === 'open') ? 'current' : 'todo'
    }
  }
  const last = (step: Step, mark: ProgressStep['mark']): ProgressStep =>
    ({ step, mark, ...(mark === 'current' && !task.bin && { tone: 'needs-you' as const }) })
  return [...steps, last('pr', ship), last('merged', merged)]
}

function prLabel(task: TaskRecord, cfg: PetreeConfig): string | null {
  const entries = Object.entries(task.delivery)
  // A target without a PR on a tracked host means the push landed but PR creation failed.
  const tracked = (repo: string) => prHost(cfg.repos[repo]?.url ?? '').kind !== 'untracked'
  if (entries.some(([repo, d]) => d.ahead > 0 && !d.pr && (!d.target || tracked(repo)))) return 'Open the PR'
  const open = entries.filter(([, d]) => d.pr === 'open')
  const stale = open.find(([, d]) => d.prHead !== d.head)
  if (stale) return `Push the update to PR #${stale[1].number}`
  if (!open[0]) return null
  const host = prHost(cfg.repos[open[0][0]]?.url ?? '').kind === 'azure' ? 'Azure DevOps' : 'GitHub'
  return `Merge PR #${open[0][1].number} on ${host}`
}

export function cardFor(task: TaskRecord, status: ThreadStatus | null, cfg: PetreeConfig, now: Date = new Date()): Card {
  const level = LEVEL[task.stage]
  const mins = task.startedAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(task.startedAt)) / 60_000)) : 0
  let line: string
  let group: Group = 'questing'
  let action: Card['action'] = null
  let reason: string | undefined
  const detail = status?.needsYou ?? null
  const deliveries = Object.values(task.delivery)
  const openPr = deliveries.find((d) => d.pr === 'open')

  switch (task.state) {
    case 'queued': line = 'Queued'; break
    case 'provisioning': line = 'Preparing workspace'; break
    case 'running': line = `Running ${level} · ${mins}m`; break
    case 'paused-rate-limit': line = 'Waiting out a rate limit'; break
    case 'paused-limit': line = 'Out of tokens'; break
    case 'cancelled':
      line = 'Paused by you'
      group = 'your-move'
      action = { label: 'Paused — resume or send a note', detail }
      break
    case 'failed':
      line = `Failed: ${(task.error ?? '').split('\n')[0]}`
      group = 'your-move'
      action = { label: `Failed in ${level} — retry the stage or drop it`, detail }
      break
    case 'waiting-for-you':
    case 'done':
      line = status?.status || READY[task.stage]
      group = 'your-move'
      if (task.state === 'waiting-for-you') {
        action = { label: `Read the ${task.stage === 'spec' ? 'spec' : 'findings'}, then approve or comment`, detail }
      } else if (prLabel(task, cfg)) {
        action = { label: prLabel(task, cfg)!, detail }
        if (openPr) line = `PR #${openPr.number} open — waiting for merge`
      } else if (detail) {
        action = { label: 'Reply', detail }
      }
      break
  }

  // Bins win over engine state (spec §5.2.2).
  if (task.bin) {
    group = task.bin
    action = null
    reason = task.binReason ?? undefined
    line = reason ?? line
  }

  return {
    q: task.seq,
    topic: status?.topic || threadTitle(task),
    summary: status?.status || line,
    line,
    group,
    action,
    ...(reason && { reason }),
    progress: progressFor(task),
    repos: task.repos.map((name) => ({ name, tags: cfg.repos[name]?.tags ?? [] })),
    prs: Object.entries(task.delivery).filter(([, d]) => d.url)
      .map(([repo, d]) => ({ repo, url: d.url!, pr: d.pr, number: d.number })),
  }
}
