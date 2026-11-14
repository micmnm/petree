import { execFile } from 'node:child_process'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PetreeConfig } from './config.js'
import { prepareWorkspace } from './git.js'
import { aheadCount, commitChanges, commitStat, ensureGitConfig, headSha, taskBranch } from './gitops.js'
import { readThreadStatus } from './notes.js'
import { openPr } from './prs.js'
import { CliRunner } from './runner.js'
import { buildSandboxCommands, readToken, type SandboxCommands } from './sandbox.js'
import { readSlice, sliceStats, type TurnStats } from './stats.js'
import { threadTitle, type TaskRecord, type TaskStore } from './store.js'

export interface LauncherOptions {
  buildCommands?: (task: TaskRecord, workDir: string) => SandboxCommands
  // Injected by tests so AUTO-PLAY never pushes or calls gh/az.
  openPr?: typeof openPr
}

export interface Launcher {
  (task: TaskRecord): Promise<void>
  // Kills the task's in-flight container (or, if it's still cloning/provisioning
  // with no container yet, marks it so launch() cancels before creating one).
  // Resolves true once a stop was actioned, false if there was nothing to stop.
  stop(id: string): Promise<boolean>
  // Re-attach to a task whose container survived a server restart (still
  // running, or exited while petree was down); replays missed output and
  // finalizes the turn normally. task.state must already be 'running'.
  reattach(task: TaskRecord): Promise<void>
}

function runCommand(command: string[]): Promise<void> {
  return new Promise((resolve) => {
    const [cmd, ...args] = command
    execFile(cmd, args, () => resolve())
  })
}

// Lines already written to the task log for this turn (i.e. after the byte
// offset recorded at container launch) — the runner skips that many stream
// lines when replaying `docker logs` from the start.
function countLinesFrom(file: string, offset: number): number {
  if (!existsSync(file)) return 0
  const size = statSync(file).size
  if (size <= offset) return 0
  const fd = openSync(file, 'r')
  const buf = Buffer.alloc(size - offset)
  readSync(fd, buf, 0, buf.length, offset)
  closeSync(fd)
  let n = 0
  for (const b of buf) if (b === 10) n++
  return n
}

export function makeLauncher(cfg: PetreeConfig, store: TaskStore, opts: LauncherOptions = {}): Launcher {
  const buildCommands =
    opts.buildCommands ??
    ((task: TaskRecord, workDir: string) => buildSandboxCommands(task, cfg, workDir, readToken(cfg.home)))

  const runners = new Map<string, CliRunner>()
  const cancelled = new Set<string>()
  // Stops asked for during a turn; the turn's end consumes it so AUTO-PLAY never moves on past one.
  const stopRequested = new Set<string>()

  // Shared turn body: stream events into the store and the log file, reconcile
  // a run that ended without a terminal event, capture commits, and remove the
  // (detached) container once the turn is finalized.
  const runTurn = async (task: TaskRecord, runner: CliRunner, logFile: string, workDir: string, commands: SandboxCommands): Promise<void> => {
    runners.set(task.id, runner)

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
        // Stage is read from the store, not the launch-time snapshot (reattach passes a stale one).
        else if (e.type === 'done') safely(() => {
          store.setResult(task.id, e.result)
          store.transition(task.id, store.get(task.id)!.stage === 'build' ? 'done' : 'waiting-for-you')
        })
        else if (e.type === 'limit') safely(() => store.transition(task.id, 'paused-limit', { error: e.reason }))
        else if (e.type === 'error') safely(() => store.transition(task.id, 'failed', { error: e.message }))
      })
      runner.on('closed', resolve)
      runner.start()
    })
    runners.delete(task.id)

    await new Promise<void>((resolve) => logStream.end(resolve))

    // The container can exit cleanly (code 0) without ever emitting a 'done' or
    // 'error' stream event (e.g. it printed nothing parseable as a result, or was
    // killed via stop()). Left unchecked the task would sit in 'running'/
    // 'provisioning' forever, permanently occupying a scheduler concurrency slot.
    const finished = store.get(task.id)
    if (finished && (finished.state === 'running' || finished.state === 'provisioning')) {
      if (cancelled.delete(task.id)) {
        safely(() => store.transition(task.id, 'cancelled'))
      } else {
        const error = storeError
          ? `run ended without terminal event; store error: ${storeError}`
          : 'run ended without terminal event'
        safely(() => store.transition(task.id, 'failed', { error }))
      }
    } else {
      cancelled.delete(task.id)
    }

    // Capture any file changes the agent made as a commit on the task branch,
    // per repo, on the host. Investigation tasks that changed nothing get no commit.
    const latest = store.get(task.id) ?? task
    const title = threadTitle(latest)
    const commitErrors: string[] = []
    const files: TurnStats['files'] = []
    for (const repo of task.repos) {
      try {
        ensureGitConfig(join(workDir, repo), cfg.repos[repo]?.url ?? '')
        const committed = commitChanges(join(workDir, repo), task.id, `petree ${task.id}: ${title}`)
        if (committed) files.push({ repo, ...commitStat(join(workDir, repo)) })
        if (committed && latest.stage !== 'build') {
          commitErrors.push(`${latest.stage} turn changed files in ${repo}`)
        }
      } catch (err) {
        commitErrors.push(`commit failed for ${repo}: ${String(err)}`)
      }
      // Both throw on a wrecked repo or a missing base ref, so a bogus ahead=0 is never recorded.
      try {
        const dir = join(workDir, repo)
        const head = headSha(dir)
        const ahead = aheadCount(dir, cfg.repos[repo]?.defaultBranch ?? 'main')
        safely(() => store.setDelivery(task.id, repo, { ahead, head }))
      } catch (err) {
        commitErrors.push(`could not read ${repo}: ${String(err)}`)
      }
    }
    // A finished build that changed nothing and asks nothing is complete (spec §5.6).
    const after = store.get(task.id)
    if (after && !after.bin && !commitErrors.length && after.stage === 'build' && after.state === 'done'
      && task.repos.every((r) => after.delivery[r] && after.delivery[r].ahead <= 0)
      && !readThreadStatus(workDir, after.startedAt)?.needsYou) {
      safely(() => store.bin(task.id, 'hall-of-fame', 'finished · no code changes'))
    }
    // The task is already in a terminal state by now (done/failed/paused), so this
    // can't go through transition() — patch the error field directly, appending to
    // whatever's already there rather than clobbering it.
    if (commitErrors.length) {
      const current = store.get(task.id)
      const combined = [current?.error, ...commitErrors].filter(Boolean).join('; ')
      safely(() => store.patch(task.id, { error: combined }))
    }

    // This run's log slice joins the turn's running total (resumes accumulate).
    safely(() => {
      const elapsed = latest.startedAt ? Date.now() - Date.parse(latest.startedAt) : 0
      const tests = task.repos.flatMap((r) => cfg.repos[r]?.test ?? [])
      store.addTurnStats(task.id, sliceStats(readSlice(logFile, latest.logOffset), tests, elapsed, files))
    })

    // The turn is finalized — the detached container is no longer needed.
    await runCommand(commands.remove)
    if (!stopRequested.delete(task.id)) await autoPlay(task.id)
  }

  // AUTO-PLAY (spec §5.8): move on to the next stage, or open the PRs after build. Stops on
  // anything but a clean finish, when the agent asked for the user, or once the thread is binned.
  const autoPlay = async (id: string): Promise<void> => {
    const t = store.get(id)
    if (!t?.autoPlay || t.bin || readThreadStatus(join(cfg.home, 'work', id), t.startedAt)?.needsYou) return
    try {
      if (t.state === 'waiting-for-you' && t.stage !== 'build') {
        store.followUp(id, '', undefined, t.stage === 'investigate' ? 'spec' : 'build')
      } else if (t.state === 'done' && t.stage === 'build') {
        const errors: string[] = []
        for (const [repo, d] of Object.entries(t.delivery)) {
          if (d.ahead <= 0 || d.pr) continue
          try {
            const made = await (opts.openPr ?? openPr)(store, cfg, t, repo, taskBranch(id))
            if (!made.ok) errors.push(`${repo}: ${made.output}`)
          } catch (err) {
            errors.push(`${repo}: ${String(err)}`)
          }
        }
        if (errors.length) store.patch(id, { error: `auto PR failed: ${errors.join('; ')}` })
      }
    } catch (err) {
      try { store.patch(id, { error: `auto-play failed: ${String(err)}` }) } catch { /* thread gone */ }
    }
  }

  // A stop that arrived while the workspace was being prepared: cancel instead of starting the container.
  const cancelledEarly = (id: string): boolean => {
    if (!cancelled.delete(id)) return false
    stopRequested.delete(id)
    store.transition(id, 'cancelled')
    return true
  }

  const launch = async function launch(task: TaskRecord): Promise<void> {
    const workDir = join(cfg.home, 'work', task.id)
    const logFile = join(cfg.home, 'logs', `${task.id}.log`)
    mkdirSync(join(cfg.home, 'logs'), { recursive: true })
    mkdirSync(join(cfg.home, 'sessions', task.id), { recursive: true })

    if (cancelledEarly(task.id)) return
    await prepareWorkspace(cfg, task.repos, workDir, task.id)
    if (cancelledEarly(task.id)) return

    const commands = buildCommands(task, workDir)
    // A stale container from an interrupted previous turn may still hold the name.
    await runCommand(commands.remove)

    const logOffset = existsSync(logFile) ? statSync(logFile).size : 0
    store.patch(task.id, { logOffset, startedAt: new Date().toISOString() })

    const runner = new CliRunner({
      commands: { create: commands.create, stream: commands.stream, wait: commands.wait, kill: commands.kill },
      timeoutMs: task.timeoutMinutes * 60_000,
      tokenBudget: task.tokenBudget,
      alreadyUsed: task.tokensUsed,
    })
    // stop() may have landed during the awaits above, with no runner yet to kill.
    if (cancelledEarly(task.id)) return
    store.transition(task.id, 'running')
    await runTurn(task, runner, logFile, workDir, commands)
  } as Launcher

  launch.reattach = async (task: TaskRecord): Promise<void> => {
    const workDir = join(cfg.home, 'work', task.id)
    const logFile = join(cfg.home, 'logs', `${task.id}.log`)
    const commands = buildCommands(task, workDir)
    const skipLines = countLinesFrom(logFile, task.logOffset)
    const elapsed = Date.now() - Date.parse(task.startedAt ?? task.updatedAt)
    const remaining = Math.max(0, task.timeoutMinutes * 60_000 - elapsed)
    const runner = new CliRunner({
      // no create: the container already exists (running, or exited while we were down)
      commands: { stream: commands.stream, wait: commands.wait, kill: commands.kill },
      timeoutMs: remaining,
      tokenBudget: task.tokenBudget,
      alreadyUsed: task.tokensUsed,
      skipLines,
    })
    // task is already 'running' — no transition here.
    await runTurn(task, runner, logFile, workDir, commands)
  }

  launch.stop = async (id: string): Promise<boolean> => {
    const runner = runners.get(id)
    if (runner) {
      cancelled.add(id)
      stopRequested.add(id)
      await runner.stop()
      return true
    }
    // No container yet (still cloning in prepareWorkspace, or queued and not yet
    // picked up) — mark it so launch() cancels at its next check instead of
    // creating one.
    if (store.get(id)?.state === 'provisioning') {
      cancelled.add(id)
      stopRequested.add(id)
      return true
    }
    return false
  }

  return launch
}
