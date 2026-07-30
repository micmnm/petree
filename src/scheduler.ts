import type { TaskRecord, TaskStore } from './store.js'

export class Scheduler {
  private ticking = false

  constructor(
    private store: TaskStore,
    private concurrency: number,
    private launch: (t: TaskRecord) => Promise<void>,
  ) {}

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      while (
        this.store.countByState('running') + this.store.countByState('provisioning') < this.concurrency
      ) {
        const next = this.store.nextQueued()
        if (!next) break
        const t = this.store.transition(next.id, 'provisioning')
        this.launch(t).catch((err) => {
          try {
            this.store.transition(t.id, 'failed', { error: String(err) })
          } catch {
            // task already reached a terminal state; nothing to record
          }
        })
      }
    } finally {
      this.ticking = false
    }
  }
}
