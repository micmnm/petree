import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { InterviewRecord } from './interview.js'
import { mergeStats, type TurnStats } from './stats.js'

export type TaskState =
  | 'queued' | 'provisioning' | 'running'
  | 'paused-limit' | 'paused-rate-limit' | 'waiting-for-you'
  | 'done' | 'failed' | 'cancelled'

export type Stage = 'investigate' | 'spec' | 'build'
export const STAGES: Stage[] = ['investigate', 'spec', 'build']

export interface Comment {
  text: string
  at: string
  consumed: boolean
}

export interface Turn {
  prompt: string
  result: string | null
  tokensUsed: number
  endedAt: string
  stage: Stage
  stats?: TurnStats | null
  interview?: InterviewRecord // the questions this turn asked and how they were answered
}

export interface TaskRecord {
  id: string
  prompt: string
  repos: string[]
  mode: 'unattended'
  state: TaskState
  sessionId: string | null
  tokensUsed: number
  tokenBudget: number
  timeoutMinutes: number
  error: string | null
  result: string | null
  model: string | null
  turns: Turn[]
  createdAt: string
  updatedAt: string
  restarts: number
  retryAt: string | null
  startedAt: string | null
  logOffset: number
  stage: Stage
  comments: Comment[]
  delivery: Record<string, Delivery>
  party: boolean
  autoPlay: boolean
  interview?: boolean
  turnStats?: TurnStats | null
  seq: number
  bin: Bin | null
  binReason: string | null
  binnedAt: string | null
  archivedAt: string | null
}

export type Bin = 'game-over' | 'hall-of-fame'

// Per-repo ship state (spec §5.4); ahead/head are set at turn end, the rest by /push, /pr and PR polling.
export interface Delivery {
  ahead: number
  head: string
  target?: string
  url?: string
  number?: number
  pr?: 'open' | 'merged' | 'closed'
  prHead?: string
  mergedAt?: string
  mergedBy?: string
  untracked?: string
}

// Forgets a repo's PR; `number` stays so the poll can skip the closed PR the user restored past.
export const NO_PR: Partial<Delivery> = {
  pr: undefined, url: undefined, prHead: undefined, target: undefined, mergedAt: undefined, mergedBy: undefined,
}

// Engine states no turn will leave on its own; only these may be binned by the poll or archived.
export const SETTLED_STATES: TaskState[] = ['done', 'failed', 'cancelled', 'paused-limit', 'waiting-for-you']

const DAY_MS = 24 * 60 * 60 * 1000

export interface RetentionSettings {
  binDays: number
  hallOfFameDays: number
}

// States a turn can be archived from, then requeued with a follow-up prompt
// (used by followUp() and the /next route). 'waiting-for-you' is the gate.
export const FOLLOWUP_STATES: TaskState[] = ['done', 'failed', 'cancelled', 'waiting-for-you']

// States from which /resume may re-run the same prompt. Deliberately excludes
// 'done' — a done task's turn must be archived via /next, not re-run in place —
// and 'waiting-for-you', which only a follow-up (gate decision) leaves.
export const RESUMABLE_STATES: TaskState[] = ['paused-limit', 'paused-rate-limit', 'failed', 'cancelled']

// Same stage is always fine; forward only through the gate; back only once finished.
export function canMoveStage(state: TaskState, from: Stage, to: Stage): boolean {
  const d = STAGES.indexOf(to) - STAGES.indexOf(from)
  if (d === 0) return true
  if (state === 'waiting-for-you') return d > 0
  return (state === 'done' || state === 'failed' || state === 'cancelled') && d < 0
}

export function threadTitle(t: TaskRecord): string {
  return (t.turns[0]?.prompt ?? t.prompt).split('\n')[0].slice(0, 72)
}

const TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued: ['provisioning', 'failed', 'cancelled'],
  provisioning: ['running', 'queued', 'failed', 'cancelled'],
  running: ['done', 'queued', 'failed', 'paused-limit', 'paused-rate-limit', 'waiting-for-you', 'cancelled'],
  'paused-limit': ['queued', 'failed'],
  'paused-rate-limit': ['queued', 'failed'],
  'waiting-for-you': ['queued', 'failed', 'cancelled'],
  done: ['queued'],
  failed: ['queued'],
  cancelled: ['queued'],
}

// Recovery backoff (spec §4): 30s, 2m, 8m, 15m, 15m, then give up.
export const MAX_RESTARTS = 5
const BACKOFF_BASE_MS = 30_000
const BACKOFF_FACTOR = 4
const BACKOFF_CAP_MS = 15 * 60_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToTask(r: any): TaskRecord {
  return {
    id: r.id, prompt: r.prompt, repos: JSON.parse(r.repos), mode: r.mode,
    state: r.state, sessionId: r.session_id, tokensUsed: r.tokens_used,
    tokenBudget: r.token_budget, timeoutMinutes: r.timeout_minutes,
    error: r.error, result: r.result ?? null, model: r.model ?? null,
    turns: (JSON.parse(r.turns ?? '[]') as Turn[]).map((t) => ({ ...t, stage: t.stage ?? 'build' })),
    stage: r.stage, comments: JSON.parse(r.comments ?? '[]'),
    delivery: JSON.parse(r.delivery ?? '{}'),
    party: r.party !== 0, autoPlay: r.auto_play === 1, interview: r.interview === 1,
    seq: r.seq ?? 0, bin: r.bin ?? null, binReason: r.bin_reason ?? null,
    binnedAt: r.binned_at ?? null, archivedAt: r.archived_at ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
    restarts: r.restarts ?? 0, retryAt: r.retry_at ?? null,
    startedAt: r.started_at ?? null, logOffset: r.log_offset ?? 0,
    turnStats: r.turn_stats ? JSON.parse(r.turn_stats) : null,
  }
}

export class TaskStore {
  private db: Database.Database

  constructor(file: string) {
    this.db = new Database(file)
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, repos TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'unattended', state TEXT NOT NULL,
      session_id TEXT, tokens_used INTEGER NOT NULL DEFAULT 0,
      token_budget INTEGER NOT NULL, timeout_minutes INTEGER NOT NULL,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result TEXT, model TEXT)`)
    // One transaction, so a failed upgrade can't commit new columns while their backfill is skipped on the next open.
    this.db.transaction(() => {
      const cols = (this.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name)
      if (!cols.includes('result')) this.db.exec('ALTER TABLE tasks ADD COLUMN result TEXT')
      if (!cols.includes('model')) this.db.exec('ALTER TABLE tasks ADD COLUMN model TEXT')
      if (!cols.includes('turns')) this.db.exec('ALTER TABLE tasks ADD COLUMN turns TEXT')
      if (!cols.includes('restarts')) this.db.exec('ALTER TABLE tasks ADD COLUMN restarts INTEGER NOT NULL DEFAULT 0')
      if (!cols.includes('retry_at')) this.db.exec('ALTER TABLE tasks ADD COLUMN retry_at TEXT')
      if (!cols.includes('started_at')) this.db.exec('ALTER TABLE tasks ADD COLUMN started_at TEXT')
      if (!cols.includes('log_offset')) this.db.exec('ALTER TABLE tasks ADD COLUMN log_offset INTEGER NOT NULL DEFAULT 0')
      // Default 'build' so pre-threads rows read as already-building tasks.
      if (!cols.includes('stage')) this.db.exec("ALTER TABLE tasks ADD COLUMN stage TEXT NOT NULL DEFAULT 'build'")
      if (!cols.includes('comments')) this.db.exec('ALTER TABLE tasks ADD COLUMN comments TEXT')
      if (!cols.includes('delivery')) this.db.exec('ALTER TABLE tasks ADD COLUMN delivery TEXT')
      if (!cols.includes('party')) this.db.exec('ALTER TABLE tasks ADD COLUMN party INTEGER NOT NULL DEFAULT 1')
      if (!cols.includes('auto_play')) this.db.exec('ALTER TABLE tasks ADD COLUMN auto_play INTEGER NOT NULL DEFAULT 0')
      if (!cols.includes('turn_stats')) this.db.exec('ALTER TABLE tasks ADD COLUMN turn_stats TEXT')
      if (!cols.includes('interview')) this.db.exec('ALTER TABLE tasks ADD COLUMN interview INTEGER NOT NULL DEFAULT 0')
      for (const c of ['bin TEXT', 'binned_at TEXT', 'bin_reason TEXT', 'archived_at TEXT', 'seq INTEGER']) {
        if (!cols.includes(c.split(' ')[0])) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${c}`)
      }
      if (!cols.includes('seq')) this.backfillSeq()
      if (!cols.includes('bin')) this.upgradeRetention()
    })()

    this.db.exec(`CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      max_age_days INTEGER NOT NULL,
      max_per_repo_group INTEGER NOT NULL,
      updated_at TEXT NOT NULL)`)
    this.db.prepare(`INSERT OR IGNORE INTO settings (id, max_age_days, max_per_repo_group, updated_at)
      VALUES (1, 3, 5, ?)`).run(new Date().toISOString())
    // max_age_days / max_per_repo_group are no longer read.
    const scols = (this.db.prepare('PRAGMA table_info(settings)').all() as { name: string }[]).map((c) => c.name)
    if (!scols.includes('bin_days')) this.db.exec('ALTER TABLE settings ADD COLUMN bin_days INTEGER NOT NULL DEFAULT 14')
    if (!scols.includes('hall_of_fame_days')) this.db.exec('ALTER TABLE settings ADD COLUMN hall_of_fame_days INTEGER NOT NULL DEFAULT 3')
  }

  private backfillSeq(): void {
    this.db.transaction(() => {
      const ids = this.db.prepare('SELECT id FROM tasks ORDER BY created_at, rowid').all() as { id: string }[]
      const set = this.db.prepare('UPDATE tasks SET seq = ? WHERE id = ?')
      ids.forEach(({ id }, i) => set.run(i + 1, id))
    })()
  }

  // One-off on first run with the bin columns (spec §5.6): old finished rows are
  // archived, younger paused ones binned, so the first inbox isn't flooded.
  private upgradeRetention(): void {
    const now = new Date().toISOString()
    const cutoff = new Date(Date.now() - 3 * DAY_MS).toISOString()
    this.db.prepare(`UPDATE tasks SET archived_at = ?
      WHERE state IN ('done', 'failed', 'cancelled', 'paused-limit') AND updated_at < ?`).run(now, cutoff)
    this.db.prepare(`UPDATE tasks SET bin = 'game-over', binned_at = ?,
        bin_reason = CASE state WHEN 'paused-limit' THEN 'out of tokens' ELSE 'dropped by you' END
      WHERE archived_at IS NULL AND state IN ('cancelled', 'paused-limit')`).run(now)
  }

  create(input: { prompt: string; repos: string[]; tokenBudget: number; timeoutMinutes: number; model?: string | null; stage?: Stage; party?: boolean; autoPlay?: boolean; interview?: boolean }): TaskRecord {
    const now = new Date().toISOString()
    const id = randomUUID().slice(0, 8)
    this.db.prepare(`INSERT INTO tasks
      (id, prompt, repos, mode, state, token_budget, timeout_minutes, model, stage, party, auto_play, interview, created_at, updated_at, seq)
      VALUES (?, ?, ?, 'unattended', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM tasks))`)
      .run(id, input.prompt, JSON.stringify(input.repos), input.tokenBudget, input.timeoutMinutes, input.model ?? null,
        input.stage ?? 'investigate', input.party === false ? 0 : 1, input.autoPlay ? 1 : 0, input.interview ? 1 : 0, now, now)
    return this.get(id)!
  }

  get(id: string): TaskRecord | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    return r ? rowToTask(r) : undefined
  }

  list(): TaskRecord[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC').all().map(rowToTask)
  }

  transition(id: string, to: TaskState, patch: { error?: string | null; model?: string | null } = {}): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    if (!TRANSITIONS[t.state].includes(to)) throw new Error(`illegal transition ${t.state} -> ${to}`)
    // Leaving 'running' proves the task is not crash-looping; entering 'queued'
    // by hand (resume/follow-up) must not stay gated behind an old backoff.
    // recoveryRequeue() re-applies its own counter right after this call.
    const clearBackoff = t.state === 'running' || to === 'queued'
    this.db.prepare(`UPDATE tasks SET state = ?, error = ?, model = ?, updated_at = ?,
        restarts = CASE WHEN ? THEN 0 ELSE restarts END,
        retry_at = CASE WHEN ? THEN NULL ELSE retry_at END
      WHERE id = ?`)
      .run(to, patch.error !== undefined ? patch.error : t.error,
        patch.model !== undefined ? patch.model : t.model, new Date().toISOString(),
        clearBackoff ? 1 : 0, clearBackoff ? 1 : 0, id)
    // A turn that hit its time limit is resumable work, not a loss; only a spent token budget ends the quest.
    if (to === 'paused-limit' && patch.error !== 'timeout') return this.bin(id, 'game-over', 'out of tokens')
    return this.get(id)!
  }

  bin(id: string, kind: Bin, reason: string): TaskRecord {
    const now = new Date().toISOString()
    this.db.prepare('UPDATE tasks SET bin = ?, binned_at = ?, bin_reason = ?, updated_at = ? WHERE id = ?')
      .run(kind, now, reason, now, id)
    return this.get(id)!
  }

  unbin(id: string): TaskRecord {
    this.db.prepare('UPDATE tasks SET bin = NULL, binned_at = NULL, bin_reason = NULL, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id)
    return this.get(id)!
  }

  // CONTINUE?: game-over and not archived only. A paused-limit thread gets one more token budget.
  restore(id: string): TaskRecord {
    return this.db.transaction(() => {
      const t = this.get(id)
      if (!t) throw new Error(`no task ${id}`)
      if (t.bin !== 'game-over' || t.archivedAt) throw new Error('cannot restore')
      this.unbin(id)
      // Else the next poll re-bins it, and the card never offers "Open the PR" again.
      for (const [repo, d] of Object.entries(t.delivery)) if (d.pr === 'closed') this.setDelivery(id, repo, NO_PR)
      if (t.state !== 'paused-limit') return this.get(id)!
      this.db.prepare('UPDATE tasks SET tokens_used = 0 WHERE id = ?').run(id)
      return this.resume(id)
    })()
  }

  // Re-run the same prompt/turn in place, optionally on a different model.
  // Unlike followUp(), does not archive a turn or reset tokensUsed — the
  // task picks up where it left off, same session, just possibly a new model.
  resume(id: string, model?: string | null): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    if (t.bin) throw new Error('restore first')
    if (!RESUMABLE_STATES.includes(t.state)) {
      throw new Error(`cannot resume from state ${t.state}`)
    }
    return this.transition(id, 'queued', { model })
  }

  patch(id: string, fields: { sessionId?: string; error?: string; startedAt?: string; logOffset?: number }): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    this.db.prepare('UPDATE tasks SET session_id = ?, error = ?, started_at = ?, log_offset = ?, updated_at = ? WHERE id = ?')
      .run(fields.sessionId ?? t.sessionId, fields.error ?? t.error, fields.startedAt ?? t.startedAt,
        fields.logOffset ?? t.logOffset, new Date().toISOString(), id)
    return this.get(id)!
  }

  setResult(id: string, text: string): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    this.db.prepare('UPDATE tasks SET result = ?, updated_at = ? WHERE id = ?')
      .run(text, new Date().toISOString(), id)
    return this.get(id)!
  }

  // Merges patch into the repo's entry; updated_at moves only when something changed.
  setDelivery(id: string, repo: string, patch: Partial<Delivery>): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    const prev = t.delivery[repo]
    const next = { ...prev, ...patch } as Delivery
    if (JSON.stringify(next) === JSON.stringify(prev)) return t
    this.db.prepare('UPDATE tasks SET delivery = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...t.delivery, [repo]: next }), new Date().toISOString(), id)
    return this.get(id)!
  }

  // Adds one run's stats to the current turn's running total.
  addTurnStats(id: string, run: TurnStats): void {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    this.db.prepare('UPDATE tasks SET turn_stats = ? WHERE id = ?').run(JSON.stringify(mergeStats(t.turnStats, run)), id)
  }

  // Comments never change state or prompt; followUp folds the pending ones in.
  addComment(id: string, text: string): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    const comments = [...t.comments, { text, at: new Date().toISOString(), consumed: false }]
    this.db.prepare('UPDATE tasks SET comments = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(comments), new Date().toISOString(), id)
    return this.get(id)!
  }

  // Archive the finished turn and requeue the task with a follow-up prompt,
  // folding pending comments in and optionally moving the stage.
  // sessionId is kept — it is what lets the next run resume the conversation.
  // `interview` is stored on the archived (question) turn.
  followUp(id: string, prompt: string, model?: string | null, stage?: Stage, interview?: InterviewRecord): TaskRecord {
    return this.db.transaction(() => {
      const t = this.get(id)
      if (!t) throw new Error(`no task ${id}`)
      if (t.bin) throw new Error('restore first')
      if (!FOLLOWUP_STATES.includes(t.state)) {
        throw new Error(`cannot follow up from state ${t.state}`)
      }
      const to = stage ?? t.stage
      if (!canMoveStage(t.state, t.stage, to)) {
        throw new Error(`illegal stage move ${t.stage} -> ${to} from state ${t.state}`)
      }
      const turns: Turn[] = [
        ...t.turns,
        { prompt: t.prompt, result: t.result, tokensUsed: t.tokensUsed, endedAt: new Date().toISOString(), stage: t.stage, stats: t.turnStats, ...(interview && { interview }) },
      ]
      const pending = t.comments.filter((c) => !c.consumed)
      const full = pending.length
        ? [prompt, `## Comments from the user since the last turn\n\n${pending.map((c) => `- ${c.text}`).join('\n')}`]
          .filter(Boolean).join('\n\n')
        : prompt
      const comments = t.comments.map((c) => ({ ...c, consumed: true }))
      this.db.prepare(`UPDATE tasks SET prompt = ?, model = ?, tokens_used = 0, result = NULL, error = NULL, turn_stats = NULL,
        turns = ?, stage = ?, comments = ?, state = 'queued', restarts = 0, retry_at = NULL, updated_at = ? WHERE id = ?`)
        .run(full, model !== undefined ? model : t.model, JSON.stringify(turns), to, JSON.stringify(comments),
          new Date().toISOString(), id)
      return this.get(id)!
    })()
  }

  // Requeue a task orphaned by a server restart (its container is gone).
  // Retries are spaced with exponential backoff so a crash-looping setup
  // cannot relaunch — and spend tokens — in a tight loop; after MAX_RESTARTS
  // the task fails instead.
  recoveryRequeue(id: string, now: Date = new Date()): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    if (t.state !== 'running' && t.state !== 'provisioning') {
      throw new Error(`cannot recovery-requeue from state ${t.state}`)
    }
    if (t.restarts >= MAX_RESTARTS) {
      return this.transition(id, 'failed', { error: `gave up after ${t.restarts} recovery restarts` })
    }
    const delay = Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** t.restarts, BACKOFF_CAP_MS)
    this.transition(id, 'queued', { error: 'recovered after server restart' })
    this.db.prepare('UPDATE tasks SET restarts = ?, retry_at = ? WHERE id = ?')
      .run(t.restarts + 1, new Date(now.getTime() + delay).toISOString(), id)
    return this.get(id)!
  }

  addUsage(id: string, tokens: number): TaskRecord {
    this.db.prepare('UPDATE tasks SET tokens_used = tokens_used + ?, updated_at = ? WHERE id = ?')
      .run(tokens, new Date().toISOString(), id)
    return this.get(id)!
  }

  countByState(state: TaskState): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE state = ?').get(state) as { c: number }
    return r.c
  }

  nextQueued(now: Date = new Date()): TaskRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM tasks WHERE state = 'queued'
      AND (retry_at IS NULL OR retry_at <= ?)
      ORDER BY created_at ASC, rowid ASC LIMIT 1`).get(now.toISOString())
    return r ? rowToTask(r) : undefined
  }

  getSettings(): RetentionSettings {
    const r = this.db.prepare('SELECT bin_days, hall_of_fame_days FROM settings WHERE id = 1')
      .get() as { bin_days: number; hall_of_fame_days: number }
    return { binDays: r.bin_days, hallOfFameDays: r.hall_of_fame_days }
  }

  updateSettings(patch: Partial<RetentionSettings>): RetentionSettings {
    const cur = this.getSettings()
    const next: RetentionSettings = {
      binDays: patch.binDays ?? cur.binDays,
      hallOfFameDays: patch.hallOfFameDays ?? cur.hallOfFameDays,
    }
    this.db.prepare('UPDATE settings SET bin_days = ?, hall_of_fame_days = ?, updated_at = ? WHERE id = 1')
      .run(next.binDays, next.hallOfFameDays, new Date().toISOString())
    return next
  }

  // Archives binned threads past their window; rows are never deleted (ponytail: grow forever, add a hard delete if the DB ever matters).
  sweep(now: Date = new Date()): number {
    const { binDays, hallOfFameDays } = this.getSettings()
    const before = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString()
    return this.db.prepare(`UPDATE tasks SET archived_at = ? WHERE archived_at IS NULL
      AND state IN (${SETTLED_STATES.map(() => '?').join(', ')})
      AND ((bin = 'game-over' AND binned_at < ?) OR (bin = 'hall-of-fame' AND binned_at < ?))`)
      .run(now.toISOString(), ...SETTLED_STATES, before(binDays), before(hallOfFameDays)).changes
  }
}
