import { createWriteStream, mkdirSync } from 'node:fs'
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

    // Recorded so a later failure — either a log-stream error or a swallowed
    // store-transition race — can be surfaced by the post-run reconciliation below,
    // instead of being silently lost.
    let storeError: string | undefined
    const logStream = createWriteStream(logFile, { flags: 'a', mode: 0o600 })
    logStream.on('error', (err) => {
      storeError = err.message
    })

    const safely = (fn: () => void) => {
      try {
        fn()
      } catch (err) {
        // event arrived after a terminal transition (or another store race); don't
        // throw out of the event handler, but remember it for reconciliation.
        storeError = String(err)
      }
    }

    await new Promise<void>((resolve) => {
      runner.on('event', (e) => {
        if (e.type === 'log') logStream.write(e.line + '\n')
        else if (e.type === 'session') safely(() => store.patch(task.id, { sessionId: e.sessionId }))
        else if (e.type === 'usage') safely(() => store.addUsage(task.id, e.tokens))
        else if (e.type === 'done') safely(() => { store.setResult(task.id, e.result); store.transition(task.id, 'done') })
        else if (e.type === 'limit') safely(() => store.transition(task.id, 'paused-limit', { error: e.reason }))
        else if (e.type === 'error') safely(() => store.transition(task.id, 'failed', { error: e.message }))
      })
      runner.on('closed', resolve)
      runner.start()
    })

    await new Promise<void>((resolve) => logStream.end(resolve))

    // The child can exit cleanly (code 0) without ever emitting a 'done' or 'error'
    // stream event (e.g. it printed nothing parseable as a result). Left unchecked
    // the task would sit in 'running'/'provisioning' forever, permanently occupying
    // a scheduler concurrency slot. Reconcile: if we're still non-terminal here, the
    // run ended without telling us why, so fail it explicitly.
    const finished = store.get(task.id)
    if (finished && (finished.state === 'running' || finished.state === 'provisioning')) {
      const error = storeError
        ? `run ended without terminal event; store error: ${storeError}`
        : 'run ended without terminal event'
      safely(() => store.transition(task.id, 'failed', { error }))
    }
  }
}
