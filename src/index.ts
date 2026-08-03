import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { makeLauncher } from './launcher.js'
import { Scheduler } from './scheduler.js'
import { makeApp } from './server.js'
import { TaskStore } from './store.js'

const cfg = loadConfig()
for (const dir of ['logs', 'work', 'shared/skills', 'shared/findings']) {
  mkdirSync(join(cfg.home, dir), { recursive: true })
}
const store = new TaskStore(join(cfg.home, 'petree.db'))
const launcher = makeLauncher(cfg, store)
const scheduler = new Scheduler(store, cfg.defaults.concurrency, launcher)
setInterval(() => void scheduler.tick(), 2000)
store.prune()
setInterval(() => store.prune(), 60_000)

const app = makeApp(cfg, store, scheduler, launcher)
const port = Number(process.env.PORT ?? 4100)
// 127.0.0.1 explicitly: the API is unauthenticated and must never bind the LAN
app.listen(port, '127.0.0.1', () => {
  console.log(`petree dashboard: http://localhost:${port}`)
})
