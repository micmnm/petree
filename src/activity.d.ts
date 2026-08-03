export interface ActivityTodo {
  content?: string
  activeForm?: string
  status?: string
}

export interface ActivityEntry {
  kind: 'init' | 'text' | 'thinking' | 'tool' | 'result' | 'error' | 'raw'
  icon: string
  name: string
  summary: string
  detail?: string
  output?: string
  tag?: string
  ok?: boolean
}

export interface ActivityStats {
  turns: number
  toolCalls: number
  toolCounts: Record<string, number>
  files: string[]
  commands: number
  tokens: number
  errors: number
  sessionId: string | null
  model: string | null
  durationMs: number | null
  costUsd: number | null
  numTurns: number | null
  finished: { ok: boolean; text: string } | null
  todos: ActivityTodo[]
  lines: number
  noise: number
}

export declare const MAX_ENTRIES: number

export declare function summarizeLog(text: string): {
  stats: ActivityStats
  entries: ActivityEntry[]
  hidden: number
  total: number
}

export declare function renderActivity(
  text: string,
  task?: { state?: string; tokensUsed?: number; tokenBudget?: number },
): string
