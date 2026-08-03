import { describe, it, expect } from 'vitest'
import type { PetreeConfig, RepoConfig } from '../src/config.js'
import type { TaskRecord } from '../src/store.js'
import { composePrompt } from '../src/prompt.js'

function repo(over: Partial<RepoConfig> = {}): RepoConfig {
  return {
    url: 'x', defaultBranch: 'main', image: 'sandbox-node',
    instructions: '', setup: [], build: [], test: [], skills: [], defaultModel: null,
    ...over,
  }
}

function config(repos: Record<string, RepoConfig>, instructions = ''): PetreeConfig {
  return {
    home: '/petree-home',
    defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null, instructions },
    repos,
    allowClone: [],
  }
}

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'abc123', prompt: 'fix the bug', repos: ['demo'], mode: 'unattended',
    state: 'provisioning', sessionId: null, tokensUsed: 0, tokenBudget: 500000,
    timeoutMinutes: 30, error: null, result: null, model: null, turns: [], createdAt: '', updatedAt: '',
    restarts: 0, retryAt: null, startedAt: null, logOffset: 0,
    ...over,
  }
}

describe('composePrompt', () => {
  it('returns the prompt untouched when nothing is configured', () => {
    expect(composePrompt(task(), config({ demo: repo() }))).toBe('fix the bug')
  })

  it('appends repo instructions after the task prompt', () => {
    const out = composePrompt(task(), config({ demo: repo({ instructions: 'Never touch src/legacy.' }) }))
    expect(out.startsWith('fix the bug')).toBe(true)
    expect(out).toContain('Never touch src/legacy.')
    expect(out).toContain('### demo')
    expect(out.indexOf('fix the bug')).toBeLessThan(out.indexOf('Never touch src/legacy.'))
  })

  it('lists setup, build and test commands with a pass-before-success gate', () => {
    const out = composePrompt(
      task(),
      config({ demo: repo({ setup: ['npm ci'], build: ['npm run build'], test: ['npm test'] }) }),
    )
    expect(out).toContain('`npm ci`')
    expect(out).toContain('`npm run build`')
    expect(out).toContain('`npm test`')
    expect(out).toMatch(/do not report success/)
    // setup runs first, so it is described first
    expect(out.indexOf('npm ci')).toBeLessThan(out.indexOf('npm test'))
  })

  it('omits the pass gate when only setup commands are configured', () => {
    const out = composePrompt(task(), config({ demo: repo({ setup: ['npm ci'] }) }))
    expect(out).toContain('`npm ci`')
    expect(out).not.toMatch(/do not report success/)
  })

  it('includes global defaults instructions even when no repo has any', () => {
    const out = composePrompt(task(), config({ demo: repo() }, 'Always write a test first.'))
    expect(out).toContain('Always write a test first.')
  })

  it('emits one section per repo, only for repos with conventions', () => {
    const cfg = config({
      demo: repo({ test: ['npm test'] }),
      api: repo({ instructions: 'dotnet only' }),
      plain: repo(),
    })
    const out = composePrompt(task({ repos: ['demo', 'api', 'plain'] }), cfg)
    expect(out).toContain('### demo')
    expect(out).toContain('### api')
    expect(out).not.toContain('### plain')
    expect(out).toContain('/work/demo')
  })

  it('ignores repo names that are no longer in the registry', () => {
    const out = composePrompt(task({ repos: ['gone'] }), config({ demo: repo({ test: ['npm test'] }) }))
    expect(out).toBe('fix the bug')
  })
})
