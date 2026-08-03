import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export type TaskState =
  | 'queued' | 'provisioning' | 'running'
  | 'paused-limit' | 'paused-rate-limit' | 'waiting-for-you'
  | 'done' | 'failed'

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
  createdAt: string
  updatedAt: string
}

const TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued: ['provisioning', 'failed'],
  provisioning: ['running', 'failed'],
  running: ['done', 'failed', 'paused-limit', 'paused-rate-limit', 'waiting-for-you'],
  'paused-limit': ['queued', 'failed'],
  'paused-rate-limit': ['queued', 'failed'],
  'waiting-for-you': ['queued', 'failed'],
  done: [],
  failed: ['queued'],
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToTask(r: any): TaskRecord {
  return {
    id: r.id, prompt: r.prompt, repos: JSON.parse(r.repos), mode: r.mode,
    state: r.state, sessionId: r.session_id, tokensUsed: r.tokens_used,
    tokenBudget: r.token_budget, timeoutMinutes: r.timeout_minutes,
    error: r.error, result: r.result ?? null, model: r.model ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
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
    this.db.prepare('UPDATE tasks SET state = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(to, patch.error !== undefined ? patch.error : t.error, new Date().toISOString(), id)
    return this.get(id)!
  }

  patch(id: string, fields: { sessionId?: string; error?: string }): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    this.db.prepare('UPDATE tasks SET session_id = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(fields.sessionId ?? t.sessionId, fields.error ?? t.error, new Date().toISOString(), id)
    return this.get(id)!
  }

  setResult(id: string, text: string): TaskRecord {
    const t = this.get(id)
    if (!t) throw new Error(`no task ${id}`)
    this.db.prepare('UPDATE tasks SET result = ?, updated_at = ? WHERE id = ?')
      .run(text, new Date().toISOString(), id)
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

  nextQueued(): TaskRecord | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE state = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1").get()
    return r ? rowToTask(r) : undefined
  }
}
