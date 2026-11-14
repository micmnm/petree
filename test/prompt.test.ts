import { describe, it, expect } from 'vitest'
import type { PetreeConfig, RepoConfig } from '../src/config.js'
import type { InterviewRecord } from '../src/interview.js'
import type { Stage, TaskRecord, Turn } from '../src/store.js'
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
    seq: 1, bin: null, binReason: null, binnedAt: null, archivedAt: null,
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

describe('composePrompt with INTERVIEW (spec §5.4)', () => {
  const cfg = config({ demo: repo() })
  const answered = (stage: Stage, round: number, final = false): Turn =>
    ({ prompt: '', result: 'r', tokensUsed: 0, endedAt: '', stage, interview: { stage, round, final } as InterviewRecord })
  const plain = (stage: Stage): Turn => ({ prompt: '', result: 'r', tokensUsed: 0, endedAt: '', stage })

  it("keeps today's stage block when off or at build", () => {
    expect(composePrompt(task({ stage: 'spec', interview: false }), cfg)).toBe(composePrompt(task({ stage: 'spec' }), cfg))
    expect(composePrompt(task({ stage: 'build', interview: true }), cfg)).toBe(composePrompt(task({ stage: 'build' }), cfg))
  })

  it('round 1 asks for questions.json first, with the normal instructions as the fallback', () => {
    const inv = composePrompt(task({ stage: 'investigate', interview: true }), cfg)
    expect(inv).toContain('## Stage: investigate — interview first')
    expect(inv).toContain('1. Explore the repos and the question first; do not modify any repo files.')
    expect(inv).toContain('Write them to `/work/_thread/questions.json`')
    expect(inv).toContain('"kind": "choice"')
    expect(inv).toContain('Do not write `/work/_thread/findings.md` this turn')
    expect(inv.indexOf('If nothing is worth asking')).toBeLessThan(inv.indexOf(STAGE_INSTRUCTIONS.investigate))
    const spec = composePrompt(task({ stage: 'spec', interview: true, turns: [plain('investigate')] }), cfg)
    expect(spec).toContain('Do not write `/work/_thread/spec.md` this turn')
    expect(spec).toContain('`interview-me`')
    expect(spec).not.toContain('The SCOUT answers above')
  })

  it('PLAN after an answered SCOUT round asks only what the plan newly raised', () => {
    const out = composePrompt(task({ stage: 'spec', interview: true, turns: [answered('investigate', 1), plain('investigate')] }), cfg)
    expect(out).toContain('## Stage: spec — interview first')
    expect(out).toContain('The SCOUT answers above already settled the scope.')
  })

  it('round N writes the document, or asks one more round with whyMore', () => {
    const out = composePrompt(task({ stage: 'spec', interview: true, turns: [answered('spec', 1)] }), cfg)
    expect(out).toContain('## Stage: spec — your questions were answered (above)')
    expect(out).toContain('(round 2, 1 to 8 questions, same shape)')
    expect(out).toContain('"whyMore"')
    expect(out.indexOf('Decisions')).toBeLessThan(out.indexOf(STAGE_INSTRUCTIONS.spec))
  })

  it('after WRITE IT NOW writes with a Decisions section; a retry after the document does not repeat it', () => {
    const final = composePrompt(task({ stage: 'spec', interview: true, turns: [answered('spec', 1, true)] }), cfg)
    expect(final).toContain(`## Stage: spec\n\n${STAGE_INSTRUCTIONS.spec}\n\nRecord the user's answers from this thread under a \`Decisions\` heading`)
    expect(final).not.toContain('questions.json')
    const retry = composePrompt(task({ stage: 'spec', interview: true, turns: [answered('spec', 1), plain('spec')] }), cfg)
    expect(retry).toBe(composePrompt(task({ stage: 'spec' }), cfg))
  })
})
