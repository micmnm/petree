import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export type TaskState =
  | 'queued' | 'provisioning' | 'running'
  | 'paused-limit' | 'paused-rate-limit' | 'waiting-for-you'
  | 'done' | 'failed' | 'cancelled'

export interface Turn {
  prompt: string
  result: string | null
  tokensUsed: number
  endedAt: string
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
}

// States a task must reach before it becomes eligible for automatic
// clearing — a queued/running/paused task is never pruned, regardless of
// age or how many other tasks share its repo group.
const PRUNABLE_STATES: TaskState[] = ['done', 'failed', 'cancelled']

export interface RetentionSettings {
  maxAgeDays: number
  maxPerRepoGroup: number
}

// States a finished task's turn can be archived from, then requeued with a
// follow-up prompt (used by followUp() and the /next route).
export const FOLLOWUP_STATES: TaskState[] = ['done', 'failed', 'cancelled']

// States from which /resume may re-run the same prompt. Deliberately excludes
// 'done' — a done task's turn must be archived via /next, not re-run in place.
export const RESUMABLE_STATES: TaskState[] = ['paused-limit', 'paused-rate-limit', 'waiting-for-you', 'failed', 'cancelled']

const TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued: ['provisioning', 'failed', 'cancelled'],
  provisioning: ['running', 'queued', 'failed', 'cancelled'],
  running: ['done', 'queued', 'failed', 'paused-limit', 'paused-rate-limit', 'waiting-for-you', 'cancelled'],
  'paused-limit': ['queued', 'failed'],
  'paused-rate-limit': ['queued', 'failed'],
  'waiting-for-you': ['queued', 'failed'],
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
    turns: JSON.parse(r.turns ?? '[]'),
    createdAt: r.created_at, updatedAt: r.updated_at,
    restarts: r.restarts ?? 0, retryAt: r.retry_at ?? null,
    startedAt: r.started_at ?? null, logOffset: r.log_offset ?? 0,
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
    const cols = (this.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name)
    if (!cols.includes('result')) this.db.exec('ALTER TABLE tasks ADD COLUMN result TEXT')
    if (!cols.includes('model')) this.db.exec('ALTER TABLE tasks ADD COLUMN model TEXT')
    if (!cols.includes('turns')) this.db.exec('ALTER TABLE tasks ADD COLUMN turns TEXT')
    if (!cols.includes('restarts')) this.db.exec('ALTER TABLE tasks ADD COLUMN restarts INTEGER NOT NULL DEFAULT 0')
    if (!cols.includes('retry_at')) this.db.exec('ALTER TABLE tasks ADD COLUMN retry_at TEXT')
    if (!cols.includes('started_at')) this.db.exec('ALTER TABLE tasks ADD COLUMN started_at TEXT')
    if (!cols.includes('log_offset')) this.db.exec('ALTER TABLE tasks ADD COLUMN log_offset INTEGER NOT NULL DEFAULT 0')

    this.db.exec(`CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      max_age_days INTEGER NOT NULL,
      max_per_repo_group INTEGER NOT NULL,
      updated_at TEXT NOT NULL)`)
    this.db.prepare(`INSERT OR IGNORE INTO settings (id, max_age_days, max_per_repo_group, updated_at)
      VALUES (1, 3, 5, ?)`).run(new Date().toISOString())
  }

  create(input: { prompt: string; repos: string[]; tokenBudget: number; timeoutMinutes: number; model?: string | null }): TaskRecord {
    const now = new Date().toISOString()
    const id = randomUUID().slice(0, 8)
    this.db.prepare(`INSERT INTO tasks
      (id, prompt, repos, mode, state, token_budget, timeout_minutes, model, created_at, updated_at)
      VALUES (?, ?, ?, 'unattended', 'queued', ?, ?, ?, ?, ?)`)
      .run(id, input.prompt, JSON.stringify(input.repos), input.tokenBudget, input.timeoutMinutes, input.model ?? null, now, now)
    return this.get(id)!
  }

  get(id: string): TaskRecord | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    return r ? rowToTask(r) : undefined
  }

  list(): TaskRecord[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC').all().map(rowToTask)
  }

  transition(id: string, to: TaskState, patch: { error?: string | null } = {}): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    if (!TRANSITIONS[t.state].includes(to)) throw new Error(`illegal transition ${t.state} -> ${to}`)
    // Leaving 'running' proves the task is not crash-looping; entering 'queued'
    // by hand (resume/follow-up) must not stay gated behind an old backoff.
    // recoveryRequeue() re-applies its own counter right after this call.
    const clearBackoff = t.state === 'running' || to === 'queued'
    this.db.prepare(`UPDATE tasks SET state = ?, error = ?, updated_at = ?,
        restarts = CASE WHEN ? THEN 0 ELSE restarts END,
        retry_at = CASE WHEN ? THEN NULL ELSE retry_at END
      WHERE id = ?`)
      .run(to, patch.error !== undefined ? patch.error : t.error, new Date().toISOString(),
        clearBackoff ? 1 : 0, clearBackoff ? 1 : 0, id)
    return this.get(id)!
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

  // Archive the finished turn and requeue the task with a follow-up prompt.
  // sessionId is kept — it is what lets the next run resume the conversation.
  followUp(id: string, prompt: string, model?: string | null): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    if (!FOLLOWUP_STATES.includes(t.state)) {
      throw new Error(`cannot follow up from state ${t.state}`)
    }
    const turns: Turn[] = [
      ...t.turns,
      { prompt: t.prompt, result: t.result, tokensUsed: t.tokensUsed, endedAt: new Date().toISOString() },
    ]
    this.db.prepare(`UPDATE tasks SET prompt = ?, model = ?, tokens_used = 0, result = NULL,
      turns = ?, state = 'queued', restarts = 0, retry_at = NULL, updated_at = ? WHERE id = ?`)
      .run(prompt, model !== undefined ? model : t.model, JSON.stringify(turns), new Date().toISOString(), id)
    return this.get(id)!
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
    const r = this.db.prepare('SELECT max_age_days, max_per_repo_group FROM settings WHERE id = 1')
      .get() as { max_age_days: number; max_per_repo_group: number }
    return { maxAgeDays: r.max_age_days, maxPerRepoGroup: r.max_per_repo_group }
  }

  updateSettings(patch: Partial<RetentionSettings>): RetentionSettings {
    const cur = this.getSettings()
    const next: RetentionSettings = {
      maxAgeDays: patch.maxAgeDays ?? cur.maxAgeDays,
      maxPerRepoGroup: patch.maxPerRepoGroup ?? cur.maxPerRepoGroup,
    }
    this.db.prepare('UPDATE settings SET max_age_days = ?, max_per_repo_group = ?, updated_at = ? WHERE id = 1')
      .run(next.maxAgeDays, next.maxPerRepoGroup, new Date().toISOString())
    return next
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  }

  // Clears finished tasks (done/failed/cancelled only — active tasks are never
  // touched) that are either older than maxAgeDays, or are excess beyond
  // maxPerRepoGroup within their repo group (the exact set of repos a task
  // runs against). Excess is trimmed oldest-first.
  prune(): { removedByAge: number; removedByLimit: number } {
    const settings = this.getSettings()
    const cutoff = new Date(Date.now() - settings.maxAgeDays * 24 * 60 * 60 * 1000).toISOString()
    const placeholders = PRUNABLE_STATES.map(() => '?').join(',')

    const aged = this.db.prepare(`SELECT id FROM tasks WHERE created_at < ? AND state IN (${placeholders})`)
      .all(cutoff, ...PRUNABLE_STATES) as { id: string }[]
    for (const { id } of aged) this.delete(id)

    const remaining = this.db.prepare('SELECT id, repos, state, created_at FROM tasks')
      .all() as { id: string; repos: string; state: TaskState; created_at: string }[]
    const groups = new Map<string, typeof remaining>()
    for (const row of remaining) {
      const key = JSON.stringify((JSON.parse(row.repos) as string[]).slice().sort())
      const group = groups.get(key)
      if (group) group.push(row); else groups.set(key, [row])
    }
    let removedByLimit = 0
    for (const rows of groups.values()) {
      let excess = rows.length - settings.maxPerRepoGroup
      if (excess <= 0) continue
      const oldestFirst = rows.filter((r) => PRUNABLE_STATES.includes(r.state))
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
      for (const row of oldestFirst) {
        if (excess <= 0) break
        this.delete(row.id)
        excess--
        removedByLimit++
      }
    }
    return { removedByAge: aged.length, removedByLimit }
  }
}
