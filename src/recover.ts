import type { Launcher } from './launcher.js'
import type { ContainerState } from './sandbox.js'
import type { TaskRecord, TaskStore } from './store.js'

export interface RecoverOptions {
  inspect: (task: TaskRecord) => Promise<ContainerState>
}

// One-shot startup pass: every task a previous server process left in
// 'running' or 'provisioning' is either re-attached to its surviving container
// or requeued (with backoff) to continue via --resume. Re-attaches run in the
// background; recover() resolves once every orphan has been dispatched.
export async function recover(store: TaskStore, launcher: Launcher, opts: RecoverOptions): Promise<void> {
  for (const t of store.list()) {
    if (t.state === 'provisioning') {
      // The container is only created after the transition to 'running', so a
      // provisioning task never has one; workspace prep is idempotent.
      store.recoveryRequeue(t.id)
      continue
    }
    if (t.state !== 'running') continue
    const state = await opts.inspect(t)
    if (state === 'absent') {
      store.recoveryRequeue(t.id)
      continue
    }
    void launcher.reattach(t).catch((err) => {
      try {
        store.transition(t.id, 'failed', { error: `re-attach failed: ${String(err)}` })
      } catch {
        // task already reached a terminal state; nothing to record
      }
    })
  }
}
