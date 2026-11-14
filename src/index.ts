import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { scanClaudeHome, settingsOf, writeMcpFile } from './claude-home.js'
import { loadConfig } from './config.js'
import { makeLauncher } from './launcher.js'
import { pollPrs } from './prs.js'
import { recover } from './recover.js'
import { containerName, inspectContainerState } from './sandbox.js'
import { Scheduler } from './scheduler.js'
import { makeApp } from './server.js'
import { TaskStore } from './store.js'

const cfg = loadConfig()
for (const dir of ['logs', 'work', 'shared/skills', 'notes']) {
  mkdirSync(join(cfg.home, dir), { recursive: true })
}
// Picks up host-side edits to an allowlisted MCP server's command or token.
try {
  writeMcpFile(cfg.home, scanClaudeHome(cfg), settingsOf(cfg).mcp)
} catch (err) {
  console.warn(`claude.mcp.json not regenerated: ${err instanceof Error ? err.message : String(err)}`)
}
const store = new TaskStore(join(cfg.home, 'petree.db'))
const launcher = makeLauncher(cfg, store)
const scheduler = new Scheduler(store, cfg.defaults.concurrency, launcher)

// Re-attach to (or requeue) turns orphaned by the previous server process
// before the scheduler starts filling concurrency slots.
void recover(store, launcher, {
  inspect: (t) => inspectContainerState(['docker', 'inspect', '-f', '{{.State.Status}}', containerName(t.id)]),
}).then(() => {
  setInterval(() => void scheduler.tick(), 2000)
})

store.sweep()
setInterval(() => store.sweep(), 60_000)

void pollPrs(store, cfg)
setInterval(() => void pollPrs(store, cfg), 5 * 60_000)

const app = makeApp(cfg, store, scheduler, launcher)
const port = Number(process.env.PORT ?? 4100)
// 127.0.0.1 explicitly: the API is unauthenticated and must never bind the LAN
app.listen(port, '127.0.0.1', () => {
  console.log(`petree dashboard: http://localhost:${port}`)
})
