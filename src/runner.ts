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

export class CliRunner extends EventEmitter {
  private child?: ChildProcess
  private tokens: number
  private settled = false
  private countedMessageIds = new Set<string>()

  constructor(private opts: CliRunnerOptions) {
    super()
    this.tokens = opts.alreadyUsed ?? 0
  }

  tokensUsed(): number {
    return this.tokens
  }

  start(): void {
    const [cmd, ...args] = this.opts.command
    this.child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => this.interrupt('timeout'), this.opts.timeoutMs)

    const rl = createInterface({ input: this.child.stdout! })
    rl.on('line', (line) => {
      if (!line.trim()) return
      for (const event of parseStreamLine(line)) {
        if (event.type === 'usage' && event.messageId !== null) {
          // stream-json repeats a message once per content block; count each id once
          if (this.countedMessageIds.has(event.messageId)) continue
          this.countedMessageIds.add(event.messageId)
        }
        if (this.settled && event.type !== 'log') continue
        if (event.type === 'done' || event.type === 'error') this.settled = true
        this.emit('event', event)
        if (event.type === 'usage') {
          this.tokens += event.tokens
          if (this.tokens >= this.opts.tokenBudget) this.interrupt('token-budget')
        }
      }
    })
    this.child.stderr!.on('data', (d) => {
      this.emit('event', { type: 'log', line: String(d).trimEnd() } satisfies RunnerEvent)
    })
    this.child.on('close', (code) => {
      clearTimeout(timer)
      if (!this.settled && code !== 0) {
        this.emit('event', { type: 'error', message: `exit code ${code}` } satisfies RunnerEvent)
      }
      this.emit('closed')
    })
  }

  private interrupt(reason: 'timeout' | 'token-budget'): void {
    if (this.settled) return
    this.settled = true
    this.emit('event', { type: 'limit', reason } satisfies RunnerEvent)
    this.child?.kill('SIGTERM')
  }

  async stop(): Promise<void> {
    this.settled = true
    this.child?.kill('SIGTERM')
  }
}
