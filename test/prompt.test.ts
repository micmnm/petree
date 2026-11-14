import { describe, it, expect } from 'vitest'
import type { PetreeConfig, RepoConfig } from '../src/config.js'
import type { TaskRecord } from '../src/store.js'
import { composePrompt, STAGE_INSTRUCTIONS } from '../src/prompt.js'

function repo(over: Partial<RepoConfig> = {}): RepoConfig {
  return {
    url: 'x', defaultBranch: 'main', image: 'sandbox-node',
    instructions: '', setup: [], build: [], test: [], run: [], skills: [], tags: [], defaultModel: null,
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
    restarts: 0, retryAt: null, startedAt: null, logOffset: 0, stage: 'build', comments: [], delivery: {}, party: true, autoPlay: false,
    ...over,
  }
}

describe('composePrompt', () => {
  it('puts the stored prompt first, then the stage block', () => {
    const out = composePrompt(task(), config({ demo: repo() }))
    expect(out.startsWith('fix the bug')).toBe(true)
    expect(out).toContain('## Stage: build')
    expect(out).toContain(STAGE_INSTRUCTIONS.build)
  })

  it('omits the prompt when empty (approve) and starts at the stage block', () => {
    const out = composePrompt(task({ prompt: '' }), config({ demo: repo() }))
    expect(out.startsWith('## Stage: ')).toBe(true)
  })

  it('gives each stage its own instructions', () => {
    const cfg = config({ demo: repo() })
    const inv = composePrompt(task({ stage: 'investigate' }), cfg)
    expect(inv).toContain('/work/_thread/findings.md')
    expect(inv).toContain('do not modify')
    const spec = composePrompt(task({ stage: 'spec' }), cfg)
    expect(spec).toContain('spec-driven-development')
    expect(spec).toContain('/work/_thread/spec.md')
    const build = composePrompt(task({ stage: 'build' }), cfg)
    expect(build).toContain('planning-and-task-breakdown')
    expect(build).toContain('in parallel')
    expect(build).toContain('test-driven-development')
  })

  it('drops the subagent paragraph from build when PARTY MODE is off', () => {
    const out = composePrompt(task({ party: false }), config({ demo: repo() }))
    expect(out).toContain('Do what the prompt above asks')
    expect(out).not.toContain('subagent')
    expect(out).not.toContain('planning-and-task-breakdown')
  })

  it('tells build turns to follow the prompt above before falling back to the spec', () => {
    const build = composePrompt(task({ stage: 'build' }), config({ demo: repo() })).toLowerCase()
    const ask = build.indexOf('do what the prompt above asks')
    expect(ask).toBeGreaterThan(-1)
    expect(ask).toBeLessThan(build.indexOf('/work/_thread/spec.md'))
  })

  it('asks for the status file once per stage, after the notes and before conventions', () => {
    const cfg = config({ demo: repo({ instructions: 'Be careful.' }) })
    for (const stage of ['investigate', 'spec', 'build'] as const) {
      const out = composePrompt(task({ stage }), cfg)
      expect(out.split('## Thread status').length).toBe(2)
      expect(out).toContain('/work/_thread/status.txt')
      expect(out.indexOf('## Thread status')).toBeGreaterThan(out.indexOf('## Suggesting notes'))
      expect(out.indexOf('## Thread status')).toBeLessThan(out.indexOf('## Repo conventions'))
    }
  })

  it('points at notes, repo CLAUDE.md and the suggestion dir for each repo', () => {
    const out = composePrompt(task({ repos: ['demo', 'api'] }), config({ demo: repo(), api: repo() }))
    for (const r of ['demo', 'api']) {
      expect(out).toContain(`/petree/notes/${r}/INDEX.md`)
      expect(out).toContain(`/work/${r}/CLAUDE.md`)
      expect(out).toContain(`/work/_thread/notes/${r}/`)
    }
  })

  it('keeps repo conventions after the stage block', () => {
    const out = composePrompt(task(), config({ demo: repo({ instructions: 'Be careful.' }) }))
    expect(out).toContain('## Repo conventions')
    expect(out.indexOf('## Repo conventions')).toBeGreaterThan(out.indexOf('## Stage: build'))
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
    expect(out).not.toContain('## Repo conventions')
  })
})
