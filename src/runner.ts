import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { parseStreamLine, type RunnerEvent } from './stream.js'

export interface CliRunnerOptions {
  command: string[]
  timeoutMs: number
  tokenBudget: number
  alreadyUsed?: number
}

const KILL_GRACE_MS = 5000

export class CliRunner extends EventEmitter {
  private child?: ChildProcess
  private tokens: number
  private settled = false
  private closed = false
  private countedMessageIds = new Set<string>()
  private lastResult: string | null = null
  private timeoutTimer?: NodeJS.Timeout
  private killTimer?: NodeJS.Timeout

  constructor(private opts: CliRunnerOptions) {
    super()
    this.tokens = opts.alreadyUsed ?? 0
  }

  tokensUsed(): number {
    return this.tokens
  }

  start(): void {
    if (this.child) throw new Error('runner already started')

    if (this.tokens >= this.opts.tokenBudget) {
      this.settled = true
      setImmediate(() => {
        this.emit('event', { type: 'limit', reason: 'token-budget' } satisfies RunnerEvent)
        this.emitClosed()
      })
      return
    }

    const [cmd, ...args] = this.opts.command
    this.child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.timeoutTimer = setTimeout(() => this.interrupt('timeout'), this.opts.timeoutMs)

    const rl = createInterface({ input: this.child.stdout! })
    rl.on('line', (line) => {
      if (!line.trim()) return
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
        if (event.type === 'error') this.settled = true
        this.emit('event', event)
        if (event.type === 'usage') {
          this.tokens += event.tokens
          if (this.tokens >= this.opts.tokenBudget) this.interrupt('token-budget')
        }
      }
    })

    const errRl = createInterface({ input: this.child.stderr! })
    errRl.on('line', (line) => {
      if (!line.trim()) return
      this.emit('event', { type: 'log', line } satisfies RunnerEvent)
    })

    this.child.on('error', (e) => {
      this.clearTimers()
      if (!this.settled) {
        this.settled = true
        this.emit('event', { type: 'error', message: e.message } satisfies RunnerEvent)
      }
      this.emitClosed()
    })

    this.child.on('close', (code, signal) => {
      this.clearTimers()
      if (!this.settled) {
        if (this.lastResult !== null) {
          this.emit('event', { type: 'done', result: this.lastResult } satisfies RunnerEvent)
        } else if (code !== 0) {
          const message = code !== null ? `exit code ${code}` : `killed by ${signal}`
          this.emit('event', { type: 'error', message } satisfies RunnerEvent)
        }
        // clean exit with no result at all → emit nothing; the launcher's
        // post-run reconciliation fails the task ("run ended without terminal event")
      }
      this.settled = true
      this.emitClosed()
    })
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

  private scheduleKill(): void {
    this.killTimer = setTimeout(() => {
      this.child?.kill('SIGKILL')
    }, KILL_GRACE_MS)
    this.killTimer.unref()
  }

  private interrupt(reason: 'timeout' | 'token-budget'): void {
    if (this.settled) return
    this.settled = true
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    this.emit('event', { type: 'limit', reason } satisfies RunnerEvent)
    this.child?.kill('SIGTERM')
    this.scheduleKill()
  }

  async stop(): Promise<void> {
    this.settled = true
    if (!this.child || this.closed) return
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    await new Promise<void>((resolve) => {
      this.once('closed', () => resolve())
      this.child?.kill('SIGTERM')
      this.scheduleKill()
    })
  }
}
