import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { parseStreamLine, type RunnerEvent } from './stream.js'

export interface SandboxProcessCommands {
  // Omitted on re-attach: the container already exists (running or exited).
  create?: string[]
  stream: string[]
  wait: string[]
  kill: string[]
}

export interface CliRunnerOptions {
  commands: SandboxProcessCommands
  timeoutMs: number
  tokenBudget: number
  alreadyUsed?: number
  // Re-attach: stdout lines already processed (and persisted) before a server
  // restart. They rebuild in-memory state without re-emitting log/usage.
  skipLines?: number
}

// If the kill command (docker stop -t 5) somehow never brings the container
// down, force-close the local log stream so the runner still settles.
const STREAM_KILL_MS = 15_000
// After the stream closes, how long to keep waiting for the exit code.
const WAIT_RESULT_GRACE_MS = 5000

export class CliRunner extends EventEmitter {
  private streamChild?: ChildProcess
  private started = false
  private tokens: number
  private settled = false
  private closed = false
  private countedMessageIds = new Set<string>()
  private lastResult: string | null = null
  private replayRemaining: number
  private waitExit?: Promise<number | null>
  private timeoutTimer?: NodeJS.Timeout
  private killTimer?: NodeJS.Timeout

  constructor(private opts: CliRunnerOptions) {
    super()
    this.tokens = opts.alreadyUsed ?? 0
    this.replayRemaining = opts.skipLines ?? 0
  }

  tokensUsed(): number {
    return this.tokens
  }

  start(): void {
    if (this.started) throw new Error('runner already started')
    this.started = true

    if (this.tokens >= this.opts.tokenBudget) {
      this.settled = true
      setImmediate(() => {
        this.emit('event', { type: 'limit', reason: 'token-budget' } satisfies RunnerEvent)
        this.emitClosed()
      })
      return
    }

    this.timeoutTimer = setTimeout(() => this.interrupt('timeout'), this.opts.timeoutMs)

    if (this.opts.commands.create) {
      const [cmd, ...args] = this.opts.commands.create
      execFile(cmd, args, (err, _stdout, stderr) => {
        if (err) {
          this.clearTimers()
          if (!this.settled) {
            this.settled = true
            this.emit('event', { type: 'error', message: stderr?.trim() || err.message } satisfies RunnerEvent)
          }
          this.emitClosed()
          return
        }
        this.attach()
      })
    } else {
      this.attach()
    }
  }

  private attach(): void {
    if (this.settled) {
      // stop()/interrupt() raced the create — make sure the container dies too
      this.killContainer()
      this.emitClosed()
      return
    }
    this.waitExit = this.collectExitCode()
    const [cmd, ...args] = this.opts.commands.stream
    this.streamChild = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    const rl = createInterface({ input: this.streamChild.stdout! })
    rl.on('line', (line) => {
      if (!line.trim()) return
      const replay = this.replayRemaining > 0
      if (replay) this.replayRemaining--
      for (const event of parseStreamLine(line)) {
        if (this.settled && event.type !== 'log') continue
        if (event.type === 'usage' && event.messageId !== null) {
          // stream-json repeats a message once per content block; count each id once
          if (this.countedMessageIds.has(event.messageId)) continue
          this.countedMessageIds.add(event.messageId)
        }
        if (event.type === 'done') {
          // not terminal yet — later turns may produce more results/usage.
          // Remember the latest; the authoritative done is emitted at close.
          this.lastResult = event.result
          continue
        }
        if (replay) {
          // Replayed lines were already streamed (and persisted) before the
          // restart: rebuild dedup/result state, but re-emit no log/usage and
          // count no tokens — those are already in alreadyUsed. Session ids
          // are re-emitted; patching them again is idempotent and covers a
          // crash between the log write and the sessionId write.
          if (event.type === 'error') this.settled = true
          if (event.type === 'session') this.emit('event', event)
          continue
        }
        if (event.type === 'error') this.settled = true
        this.emit('event', event)
        if (event.type === 'usage') {
          this.tokens += event.tokens
          if (this.tokens >= this.opts.tokenBudget) this.interrupt('token-budget')
        }
      }
    })

    const errRl = createInterface({ input: this.streamChild.stderr! })
    errRl.on('line', (line) => {
      if (!line.trim()) return
      this.emit('event', { type: 'log', line } satisfies RunnerEvent)
    })

    this.streamChild.on('error', (e) => {
      this.clearTimers()
      if (!this.settled) {
        this.settled = true
        this.emit('event', { type: 'error', message: e.message } satisfies RunnerEvent)
      }
      this.emitClosed()
    })

    this.streamChild.on('close', () => {
      void this.finalize()
    })
  }

  private async finalize(): Promise<void> {
    this.clearTimers()
    const code = await this.exitCodeOrNull()
    if (!this.settled) {
      if (this.lastResult !== null) {
        this.emit('event', { type: 'done', result: this.lastResult } satisfies RunnerEvent)
      } else if (code !== 0) {
        const message = code !== null ? `exit code ${code}` : 'container exit code unavailable'
        this.emit('event', { type: 'error', message } satisfies RunnerEvent)
      }
      // clean exit (0) with no result at all → emit nothing; the launcher's
      // post-run reconciliation fails the task ("run ended without terminal event")
    }
    this.settled = true
    this.emitClosed()
  }

  private collectExitCode(): Promise<number | null> {
    return new Promise((resolve) => {
      const [cmd, ...args] = this.opts.commands.wait
      execFile(cmd, args, (err, stdout) => {
        if (err) return resolve(null)
        const code = Number.parseInt(stdout.trim(), 10)
        resolve(Number.isNaN(code) ? null : code)
      })
    })
  }

  private exitCodeOrNull(): Promise<number | null> {
    const grace = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), WAIT_RESULT_GRACE_MS).unref()
    })
    return Promise.race([this.waitExit ?? Promise.resolve(null), grace])
  }

  private clearTimers(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    if (this.killTimer) clearTimeout(this.killTimer)
  }

  private emitClosed(): void {
    if (this.closed) return
    this.closed = true
    this.emit('closed')
  }

  private killContainer(): void {
    const [cmd, ...args] = this.opts.commands.kill
    execFile(cmd, args, () => {})
    this.killTimer = setTimeout(() => this.streamChild?.kill('SIGKILL'), STREAM_KILL_MS)
    this.killTimer.unref()
  }

  private interrupt(reason: 'timeout' | 'token-budget'): void {
    if (this.settled) return
    this.settled = true
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    this.emit('event', { type: 'limit', reason } satisfies RunnerEvent)
    this.killContainer()
  }

  async stop(): Promise<void> {
    this.settled = true
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    if (this.closed) return
    if (!this.started) {
      this.emitClosed()
      return
    }
    await new Promise<void>((resolve) => {
      this.once('closed', () => resolve())
      this.killContainer()
    })
  }
}
