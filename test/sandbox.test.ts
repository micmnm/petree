import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import type { TaskRecord } from '../src/store.js'
import { buildDockerCommand, readToken } from '../src/sandbox.js'

const cfg: PetreeConfig = {
  home: '/petree-home',
  defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3 },
  repos: { demo: { url: 'x', defaultBranch: 'main', image: 'sandbox-node', setup: [], test: [], skills: [] } },
  allowClone: [],
}

const task: TaskRecord = {
  id: 'abc123', prompt: 'fix the bug', repos: ['demo'], mode: 'unattended',
  state: 'provisioning', sessionId: null, tokensUsed: 0, tokenBudget: 500000,
  timeoutMinutes: 30, error: null, createdAt: '', updatedAt: '',
}

describe('buildDockerCommand', () => {
  it('builds a docker run command with token env, mounts and stream output', () => {
    const cmd = buildDockerCommand(task, cfg, '/tmp/work/abc123', 'tok-1')
    expect(cmd.slice(0, 4)).toEqual(['docker', 'run', '--rm', '--init'])
    expect(cmd).toContain('sandbox-node')
    expect(cmd.join(' ')).toContain('-e CLAUDE_CODE_OAUTH_TOKEN=tok-1')
    expect(cmd.join(' ')).toContain('/tmp/work/abc123:/work')
    expect(cmd.join(' ')).toContain('/petree-home/shared/skills:/petree/skills:ro')
    expect(cmd.join(' ')).toContain('--output-format stream-json')
    expect(cmd.join(' ')).not.toContain('ANTHROPIC_API_KEY')
  })

  it('adds --resume when the task has a session id', () => {
    const cmd = buildDockerCommand({ ...task, sessionId: 'sess-9' }, cfg, '/w', 't')
    expect(cmd.join(' ')).toContain('--resume sess-9')
  })
})

describe('readToken', () => {
  it('reads and trims the token file', () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-tok-'))
    writeFileSync(join(home, 'token'), 'tok-abc\n')
    expect(readToken(home)).toBe('tok-abc')
  })

  it('throws with setup instructions when missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-tok-'))
    expect(() => readToken(home)).toThrow(/claude setup-token/)
  })
})
