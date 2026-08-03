// Emulates the docker CLI subset petree uses, against a state directory given
// by FAKE_DOCKER_HOME. "Containers" are detached node processes, so they
// survive the death of whoever spawned them — exactly like real containers
// survive the petree server.
// CLI: run <name> <scenario> | logs [-f] <name> | wait <name> | stop <name>
//      | rm <name> | inspect <name>
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = process.env.FAKE_DOCKER_HOME
if (!home) { console.error('FAKE_DOCKER_HOME not set'); process.exit(64) }
const argv = process.argv.slice(2)
const sub = argv[0]
const args = argv.slice(1).filter((a) => !a.startsWith('-'))
const name = args[sub === 'run' ? 0 : args.length - 1]
const p = (ext) => join(home, `${name}.${ext}`)
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

if (sub === 'run') {
  if (existsSync(p('pid')) && !existsSync(p('exit'))) { console.error(`name ${name} in use`); process.exit(125) }
  rmSync(p('exit'), { force: true })
  rmSync(p('log'), { force: true })
  const wrapper = fileURLToPath(new URL('./fake-container.js', import.meta.url))
  const child = spawn(process.execPath, [wrapper, home, name, args[1] ?? 'ok'], { detached: true, stdio: 'ignore' })
  child.unref()
  writeFileSync(p('pid'), String(child.pid))
  console.log(name)
} else if (sub === 'logs') {
  let offset = 0
  const drain = () => {
    if (!existsSync(p('log'))) return
    const size = statSync(p('log')).size
    if (size > offset) {
      const fd = openSync(p('log'), 'r')
      const buf = Buffer.alloc(size - offset)
      readSync(fd, buf, 0, buf.length, offset)
      closeSync(fd)
      process.stdout.write(buf)
      offset = size
    }
  }
  if (!argv.includes('-f')) {
    drain()
    process.exit(existsSync(p('pid')) ? 0 : 1)
  }
  const timer = setInterval(() => {
    drain()
    if (existsSync(p('exit'))) { drain(); clearInterval(timer) }
  }, 20)
} else if (sub === 'wait') {
  const timer = setInterval(() => {
    if (existsSync(p('exit'))) {
      clearInterval(timer)
      console.log(readFileSync(p('exit'), 'utf8').trim())
    }
  }, 20)
} else if (sub === 'stop') {
  if (existsSync(p('pid')) && !existsSync(p('exit'))) {
    const pid = Number(readFileSync(p('pid'), 'utf8'))
    if (alive(pid)) { try { process.kill(pid, 'SIGTERM') } catch { /* raced its exit */ } }
  }
  const timer = setInterval(() => {
    if (!existsSync(p('pid')) || existsSync(p('exit'))) { clearInterval(timer); console.log(name) }
  }, 20)
} else if (sub === 'rm') {
  for (const ext of ['pid', 'exit', 'log']) rmSync(p(ext), { force: true })
  console.log(name)
} else if (sub === 'inspect') {
  if (!existsSync(p('pid'))) { console.error('no such container'); process.exit(1) }
  if (existsSync(p('exit'))) console.log('exited')
  else if (alive(Number(readFileSync(p('pid'), 'utf8')))) console.log('running')
  else console.log('exited')
} else {
  console.error(`unknown subcommand ${sub}`)
  process.exit(64)
}
