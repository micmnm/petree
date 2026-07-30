import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PetreeConfig } from './config.js'
import { prepareWorkspace } from './git.js'
import { CliRunner } from './runner.js'
import { buildDockerCommand, readToken } from './sandbox.js'
import type { TaskRecord, TaskStore } from './store.js'

export interface LauncherOptions {
  buildCommand?: (task: TaskRecord, workDir: string) => string[]
}

export function makeLauncher(cfg: PetreeConfig, store: TaskStore, opts: LauncherOptions = {}) {
  const buildCommand =
    opts.buildCommand ??
    ((task: TaskRecord, workDir: string) => buildDockerCommand(task, cfg, workDir, readToken(cfg.home)))

  return async function launch(task: TaskRecord): Promise<void> {
    const workDir = join(cfg.home, 'work', task.id)
    const logFile = join(cfg.home, 'logs', `${task.id}.log`)
    mkdirSync(join(cfg.home, 'logs'), { recursive: true })

    prepareWorkspace(cfg, task.repos, workDir)
    const runner = new CliRunner({
      command: buildCommand(task, workDir),
      timeoutMs: task.timeoutMinutes * 60_000,
      tokenBudget: task.tokenBudget,
      alreadyUsed: task.tokensUsed,
    })
    store.transition(task.id, 'running')

    const safely = (fn: () => void) => {
      try { fn() } catch { /* event arrived after a terminal transition; ignore */ }
    }

    await new Promise<void>((resolve) => {
      runner.on('event', (e) => {
        if (e.type === 'log') appendFileSync(logFile, e.line + '\n')
        else if (e.type === 'session') safely(() => store.patch(task.id, { sessionId: e.sessionId }))
        else if (e.type === 'usage') safely(() => store.addUsage(task.id, e.tokens))
        else if (e.type === 'done') safely(() => store.transition(task.id, 'done'))
        else if (e.type === 'limit') safely(() => store.transition(task.id, 'paused-limit', { error: e.reason }))
        else if (e.type === 'error') safely(() => store.transition(task.id, 'failed', { error: e.message }))
      })
      runner.on('closed', resolve)
      runner.start()
    })
  }
}
