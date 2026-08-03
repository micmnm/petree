// Plays the "container" for fake-docker.js: runs fake-claude.js (or the argv
// in FAKE_CONTAINER_EXEC), appends its stdout to <name>.log, and records the
// exit code in <name>.exit — 143 when stopped via SIGTERM, like docker stop.
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [home, name, scenario] = process.argv.slice(2)
const fakeClaude = fileURLToPath(new URL('./fake-claude.js', import.meta.url))
const argv = process.env.FAKE_CONTAINER_EXEC
  ? JSON.parse(process.env.FAKE_CONTAINER_EXEC)
  : [process.execPath, fakeClaude, scenario]
const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] })
child.stdout.on('data', (chunk) => appendFileSync(join(home, `${name}.log`), chunk))
let finished = false
const finish = (code) => {
  if (finished) return
  finished = true
  writeFileSync(join(home, `${name}.exit`), String(code))
  process.exit(0)
}
child.on('close', (code, signal) => finish(code ?? (signal === 'SIGTERM' ? 143 : 137)))
process.on('SIGTERM', () => {
  child.kill('SIGTERM')
  setTimeout(() => finish(143), 200).unref()
})
