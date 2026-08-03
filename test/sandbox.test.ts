import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import type { TaskRecord } from '../src/store.js'
import { buildSandboxCommands, containerName, inspectContainerState, readToken } from '../src/sandbox.js'

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
  restarts: 0, retryAt: null, startedAt: null, logOffset: 0,
}

describe('buildSandboxCommands', () => {
  it('creates a detached, named container without --rm', () => {
    const cmds = buildSandboxCommands(task, cfg, '/tmp/w', 'tok')
    expect(cmds.containerName).toBe(`petree-${task.id}`)
    expect(cmds.create.slice(0, 4)).toEqual(['docker', 'run', '-d', '--init'])
    expect(cmds.create).not.toContain('--rm')
    expect(cmds.create).toContain(`petree-${task.id}`)
    expect(cmds.create).toContain('--dangerously-skip-permissions')
  })

  it('builds a create command with token env, mounts and stream output', () => {
    const cmds = buildSandboxCommands(task, cfg, '/tmp/work/abc123', 'tok-1')
    expect(cmds.create).toContain('sandbox-node')
    expect(cmds.create.join(' ')).toContain('-e CLAUDE_CODE_OAUTH_TOKEN=tok-1')
    expect(cmds.create.join(' ')).toContain('/tmp/work/abc123:/work')
    expect(cmds.create.join(' ')).toContain('/petree-home/shared/skills:/petree/skills:ro')
    expect(cmds.create.join(' ')).toContain('--output-format stream-json')
    expect(cmds.create.join(' ')).not.toContain('ANTHROPIC_API_KEY')
  })

  it('mounts the per-task session dir at /home/dev/.claude', () => {
    const cmds = buildSandboxCommands(task, cfg, '/tmp/work/abc123', 'tok-1')
    expect(cmds.create.join(' ')).toContain('/petree-home/sessions/abc123:/home/dev/.claude')
  })

  it('builds the stream/wait/kill/remove/inspect commands', () => {
    const cmds = buildSandboxCommands(task, cfg, '/tmp/w', 'tok')
    const name = `petree-${task.id}`
    expect(cmds.stream).toEqual(['docker', 'logs', '-f', name])
    expect(cmds.wait).toEqual(['docker', 'wait', name])
    expect(cmds.kill).toEqual(['docker', 'stop', '-t', '5', name])
    expect(cmds.remove).toEqual(['docker', 'rm', '-f', name])
    expect(cmds.inspect).toEqual(['docker', 'inspect', '-f', '{{.State.Status}}', name])
  })

  it('adds --resume only when the session transcript exists on the host', () => {
    const home = mkdtempSync(join(tmpdir(), 'petree-sess-'))
    const cfgReal = { ...cfg, home }
    // transcript missing: fresh session instead of a crashing --resume
    const without = buildSandboxCommands({ ...task, sessionId: 'sess-9' }, cfgReal, '/w', 't')
    expect(without.create).not.toContain('--resume')
    // transcript present (as written by a previous containerized run): resume
    mkdirSync(join(home, 'sessions', task.id, 'projects', '-work'), { recursive: true })
    writeFileSync(join(home, 'sessions', task.id, 'projects', '-work', 'sess-9.jsonl'), '{}\n')
    const withResume = buildSandboxCommands({ ...task, sessionId: 'sess-9' }, cfgReal, '/w', 't')
    expect(withResume.create.join(' ')).toContain('--resume sess-9')
  })

  it('appends --model when the task has a model', () => {
    const cmds = buildSandboxCommands({ ...task, model: 'haiku' }, cfg, '/w', 't')
    const cmd = cmds.create
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
    const cmds = buildSandboxCommands(task, withRules, '/w', 't')
    const cmd = cmds.create
    const prompt = cmd[cmd.indexOf('-p') + 1]
    expect(prompt.startsWith('fix the bug')).toBe(true)
    expect(prompt).toContain('Never edit src/generated/.')
    expect(prompt).toContain('`npm test`')
  })

  it('passes the bare prompt when the repo has no conventions', () => {
    const cmds = buildSandboxCommands(task, cfg, '/w', 't')
    expect(cmds.create[cmds.create.indexOf('-p') + 1]).toBe('fix the bug')
  })

  it('omits --model when the task model is null', () => {
    const cmds = buildSandboxCommands({ ...task, model: null }, cfg, '/w', 't')
    expect(cmds.create).not.toContain('--model')
  })
})

describe('containerName', () => {
  it('prefixes the task id', () => {
    expect(containerName('abc123')).toBe('petree-abc123')
  })
})

describe('inspectContainerState', () => {
  const echo = (out: string) => [process.execPath, '-e', `console.log('${out}')`]
  it('maps running / exited / dead / other / command-failure', async () => {
    expect(await inspectContainerState(echo('running'))).toBe('running')
    expect(await inspectContainerState(echo('exited'))).toBe('exited')
    expect(await inspectContainerState(echo('dead'))).toBe('exited')
    expect(await inspectContainerState(echo('created'))).toBe('absent')
    expect(await inspectContainerState([process.execPath, '-e', 'process.exit(1)'])).toBe('absent')
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
