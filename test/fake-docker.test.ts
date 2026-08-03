import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const shim = fileURLToPath(new URL('./fixtures/fake-docker.js', import.meta.url))

function docker(home: string, ...argv: string[]): string {
  return execFileSync(process.execPath, [shim, ...argv], {
    env: { ...process.env, FAKE_DOCKER_HOME: home },
    encoding: 'utf8',
  })
}

const until = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('fake-docker shim', () => {
  it('run + wait + logs: clean scenario', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fdock-'))
    expect(docker(home, 'run', 'c1', 'ok').trim()).toBe('c1')
    expect(docker(home, 'wait', 'c1').trim()).toBe('0')
    const logs = docker(home, 'logs', 'c1')
    expect(logs).toContain('sess-123')
    expect(logs).toContain('all tests pass')
  })

  it('logs -f follows until exit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fdock-'))
    docker(home, 'run', 'c2', 'slow')
    const out = execFileSync(process.execPath, [shim, 'logs', '-f', 'c2'], {
      env: { ...process.env, FAKE_DOCKER_HOME: home },
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(out).toContain('too late')
  })

  it('stop kills the container with exit code 143; inspect reports states', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fdock-'))
    docker(home, 'run', 'c3', 'slow')
    expect(docker(home, 'inspect', 'c3').trim()).toBe('running')
    docker(home, 'stop', 'c3')
    expect(docker(home, 'wait', 'c3').trim()).toBe('143')
    expect(docker(home, 'inspect', 'c3').trim()).toBe('exited')
  })

  it('containers survive their spawner: run via a child process that dies immediately', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fdock-'))
    // spawn the shim and let the parent (this callback) drop it — no waiting
    await new Promise<void>((resolve) => {
      execFile(process.execPath, [shim, 'run', 'c4', 'slow'],
        { env: { ...process.env, FAKE_DOCKER_HOME: home } }, () => resolve())
    })
    await until(() => existsSync(join(home, 'c4.exit')))
    expect(docker(home, 'logs', 'c4')).toContain('too late')
  })

  it('rm removes state; second run with same live name fails with 125', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fdock-'))
    docker(home, 'run', 'c5', 'slow')
    expect(() => docker(home, 'run', 'c5', 'ok')).toThrow()
    docker(home, 'stop', 'c5')
    docker(home, 'rm', 'c5')
    expect(() => docker(home, 'inspect', 'c5')).toThrow()
    expect(docker(home, 'run', 'c5', 'ok').trim()).toBe('c5')
  })

  it('FAKE_CONTAINER_EXEC overrides the containerized command', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fdock-'))
    execFileSync(process.execPath, [shim, 'run', 'c6', 'ok'], {
      env: {
        ...process.env,
        FAKE_DOCKER_HOME: home,
        FAKE_CONTAINER_EXEC: JSON.stringify([process.execPath, '-e', "console.log('custom-exec-ran')"]),
      },
      encoding: 'utf8',
    })
    docker(home, 'wait', 'c6')
    expect(docker(home, 'logs', 'c6')).toContain('custom-exec-ran')
  })
})
