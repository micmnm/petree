import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import type { TaskRecord } from '../src/store.js'
import { buildDockerCommand, readToken } from '../src/sandbox.js'

const cfg: PetreeConfig = {
  home: '/petree-home',
  defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null, instructions: '' },
  repos: { demo: { url: 'x', defaultBranch: 'main', image: 'sandbox-node', instructions: '', setup: [], build: [], test: [], skills: [], defaultModel: null } },
  allowClone: [],
}

const task: TaskRecord = {
  id: 'abc123', prompt: 'fix the bug', repos: ['demo'], mode: 'unattended',
  state: 'provisioning', sessionId: null, tokensUsed: 0, tokenBudget: 500000,
  timeoutMinutes: 30, error: null, result: null, model: null, turns: [], createdAt: '', updatedAt: '',
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

  it('mounts the per-task session dir at /home/dev/.claude', () => {
    const cmd = buildDockerCommand(task, cfg, '/tmp/work/abc123', 'tok-1')
    expect(cmd.join(' ')).toContain('/petree-home/sessions/abc123:/home/dev/.claude')
  })

  it('adds --resume only when the session transcript exists on the host', () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-sess-'))
    const cfgReal = { ...cfg, home }
    // transcript missing: fresh session instead of a crashing --resume
    const without = buildDockerCommand({ ...task, sessionId: 'sess-9' }, cfgReal, '/w', 't')
    expect(without).not.toContain('--resume')
    // transcript present (as written by a previous containerized run): resume
    mkdirSync(join(home, 'sessions', task.id, 'projects', '-work'), { recursive: true })
    writeFileSync(join(home, 'sessions', task.id, 'projects', '-work', 'sess-9.jsonl'), '{}\n')
    const withResume = buildDockerCommand({ ...task, sessionId: 'sess-9' }, cfgReal, '/w', 't')
    expect(withResume.join(' ')).toContain('--resume sess-9')
  })

  it('appends --model when the task has a model', () => {
    const cmd = buildDockerCommand({ ...task, model: 'haiku' }, cfg, '/w', 't')
    expect(cmd.join(' ')).toContain('--model haiku')
    // must come after the prompt, before --output-format
    const i = cmd.indexOf('--model')
    expect(cmd[i + 1]).toBe('haiku')
    expect(cmd.indexOf('-p')).toBeLessThan(i)
    expect(i).toBeLessThan(cmd.indexOf('--output-format'))
  })

  it('passes the repo conventions through in the -p prompt', () => {
    const withRules: PetreeConfig = {
      ...cfg,
      repos: { demo: { ...cfg.repos.demo, instructions: 'Never edit src/generated/.', test: ['npm test'] } },
    }
    const cmd = buildDockerCommand(task, withRules, '/w', 't')
    const prompt = cmd[cmd.indexOf('-p') + 1]
    expect(prompt.startsWith('fix the bug')).toBe(true)
    expect(prompt).toContain('Never edit src/generated/.')
    expect(prompt).toContain('`npm test`')
  })

  it('passes the bare prompt when the repo has no conventions', () => {
    const cmd = buildDockerCommand(task, cfg, '/w', 't')
    expect(cmd[cmd.indexOf('-p') + 1]).toBe('fix the bug')
  })

  it('omits --model when the task model is null', () => {
    const cmd = buildDockerCommand({ ...task, model: null }, cfg, '/w', 't')
    expect(cmd).not.toContain('--model')
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
