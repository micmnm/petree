import { describe, it, expect } from 'vitest'
import {
  parseOptionsHash, optionsHash, normFields, isDirty, dirtySummary, forwardHash,
  buildSearchIndex, searchOptions,
} from '../src/options-state.js'
import type { SearchEntry } from '../src/options-state.js'

describe('parseOptionsHash', () => {
  it('parses every canonical route', () => {
    expect(parseOptionsHash('#/options')).toEqual({ tab: 'repos' })
    expect(parseOptionsHash('#/options/repos')).toEqual({ tab: 'repos' })
    expect(parseOptionsHash('#/options/repo/petree')).toEqual({ tab: 'repos', repo: 'petree' })
    expect(parseOptionsHash('#/options/recruit')).toEqual({ tab: 'repos', recruit: true })
    expect(parseOptionsHash('#/options/rules')).toEqual({ tab: 'rules' })
    expect(parseOptionsHash('#/options/claude')).toEqual({ tab: 'claude', sub: 'skills' })
    expect(parseOptionsHash('#/options/claude/skills')).toEqual({ tab: 'claude', sub: 'skills' })
    expect(parseOptionsHash('#/options/claude/plugins')).toEqual({ tab: 'claude', sub: 'plugins' })
    expect(parseOptionsHash('#/options/claude/mcp')).toEqual({ tab: 'claude', sub: 'mcp' })
    expect(parseOptionsHash('#/options/raw')).toEqual({ tab: 'raw' })
  })

  it('falls back an unrecognized tab segment to repos', () => {
    expect(parseOptionsHash('#/options/bogus')).toEqual({ tab: 'repos' })
  })

  it('falls back an unrecognized claude sub-segment to skills', () => {
    expect(parseOptionsHash('#/options/claude/bogus')).toEqual({ tab: 'claude', sub: 'skills' })
  })

  it('parses repo names containing dots, dashes and underscores', () => {
    expect(parseOptionsHash('#/options/repo/my.repo-name_1')).toEqual({ tab: 'repos', repo: 'my.repo-name_1' })
  })

  it('decodes percent-encoded repo names', () => {
    expect(parseOptionsHash('#/options/repo/foo%20bar')).toEqual({ tab: 'repos', repo: 'foo bar' })
  })

  it('a repo literally named "recruit" does not collide with the recruit route', () => {
    expect(parseOptionsHash('#/options/repo/recruit')).toEqual({ tab: 'repos', repo: 'recruit' })
    expect(parseOptionsHash('#/options/recruit')).toEqual({ tab: 'repos', recruit: true })
  })

  it('returns null for a hash outside the options namespace', () => {
    expect(parseOptionsHash('#/inbox')).toBeNull()
  })
})

describe('optionsHash', () => {
  it('round-trips every canonical route except bare #/options, which normalizes to /repos', () => {
    const canonical = [
      '#/options/repos',
      '#/options/repo/petree',
      '#/options/recruit',
      '#/options/rules',
      '#/options/claude/skills',
      '#/options/claude/plugins',
      '#/options/claude/mcp',
      '#/options/raw',
    ]
    for (const h of canonical) expect(optionsHash(parseOptionsHash(h))).toBe(h)
  })

  it('normalizes bare #/options to the repos tab hash', () => {
    expect(optionsHash(parseOptionsHash('#/options'))).toBe('#/options/repos')
  })

  it('encodes repo names that need it', () => {
    expect(optionsHash({ tab: 'repos', repo: 'foo bar' })).toBe('#/options/repo/foo%20bar')
  })
})

describe('normFields', () => {
  it('splits, trims and dedupes tags, sorting the result', () => {
    expect(normFields({ tags: ['a, b', ' c ', 'a'] })).toEqual({ tags: ['a', 'b', 'c'] })
  })

  it('accepts a single comma-joined string for tags', () => {
    expect(normFields({ tags: 'a, b, a' })).toEqual({ tags: ['a', 'b'] })
  })

  it('trims entries and drops blanks for other list fields without splitting on commas', () => {
    expect(normFields({ setup: ['  a  ', '', 'b, c'] })).toEqual({ setup: ['a', 'b, c'] })
  })

  it('trims plain string fields', () => {
    expect(normFields({ url: '  http://x  ' })).toEqual({ url: 'http://x' })
  })

  it('omits null, empty-string and empty-array values', () => {
    expect(normFields({ url: '', path: null, tags: [], run: [''] })).toEqual({})
  })

  it('keeps unrelated non-string, non-array values untouched', () => {
    expect(normFields({ concurrency: 3 })).toEqual({ concurrency: 3 })
  })
})

describe('isDirty', () => {
  const fields = { url: 'http://x', tags: ['a', 'b'] }
  const orig = JSON.stringify(normFields(fields))

  it('is false for a round-tripped draft', () => {
    expect(isDirty(orig, fields)).toBe(false)
  })

  it('is false when re-normalizing produces the same shape from different input order', () => {
    expect(isDirty(orig, { tags: ['b, a'], url: 'http://x' })).toBe(false)
  })

  it('is true after a single character changes', () => {
    expect(isDirty(orig, { ...fields, url: 'http://xy' })).toBe(true)
  })
})

describe('dirtySummary', () => {
  it('is empty for zero pending items', () => {
    expect(dirtySummary([])).toBe('')
    expect(dirtySummary([{ name: 'petree', dirty: false }])).toBe('')
  })

  it('names the one pending item', () => {
    expect(dirtySummary([{ name: 'petree', dirty: true }, { name: 'rules', dirty: false }])).toBe('1 unsaved: petree')
  })

  it('names several pending items in order, counted', () => {
    const items = [{ name: 'petree', dirty: true }, { name: 'GAME RULES', dirty: true }, { name: 'skills', dirty: true }]
    expect(dirtySummary(items)).toBe('3 unsaved: petree, GAME RULES, skills')
  })
})

describe('forwardHash', () => {
  it('follows a chain of two moves', () => {
    const moved = { '#/old': '#/mid', '#/mid': '#/new' }
    expect(forwardHash(moved, '#/old')).toBe('#/new')
  })

  it('returns its input unchanged when the hash was never moved', () => {
    const moved = { '#/old': '#/mid' }
    expect(forwardHash(moved, '#/elsewhere')).toBe('#/elsewhere')
  })
})

describe('search index and ranking', () => {
  const repos = [
    { name: 'petree', tags: ['game', 'core'], defaultBranch: 'main', image: 'node:22' },
    { name: 'popplank', tags: ['game'], defaultBranch: 'main', image: 'node:22' },
  ]
  const settingsFields = [
    { label: 'CONCURRENCY', help: 'How many quests run at the same time.', name: 'concurrency' },
    { label: 'TOKEN BUDGET', help: 'A quest that runs out stops and lands in GAME OVER as out of tokens.', name: 'token_budget' },
    { label: 'GAME OVER CLEAN-UP', help: 'Quests leave the GAME OVER bin after this. Until then CONTINUE? brings them back.', name: 'binDays' },
  ]
  const claude = {
    skills: [{ name: 'brainstorming', description: 'creative work' }],
    plugins: [{ name: 'agent-skills', marketplace: 'anthropic', version: '1.0' }],
    mcp: [{ name: 'chrome-devtools', scope: 'user', transport: 'stdio' }],
  }
  const index = buildSearchIndex({ repos, settingsFields, claude })

  it('indexes repos, tags, settings, claude items and the raw page', () => {
    expect(index.find((e: SearchEntry) => e.kind === 'repo' && e.label === 'petree')).toMatchObject({ hash: '#/options/repo/petree' })
    expect(index.find((e: SearchEntry) => e.kind === 'tag' && e.label === 'game')).toMatchObject({ detail: '2 repos', hash: '#/options/repos' })
    expect(index.find((e: SearchEntry) => e.kind === 'setting' && e.label === 'TOKEN BUDGET')).toMatchObject({ hash: '#/options/rules' })
    expect(index.find((e: SearchEntry) => e.kind === 'skill' && e.label === 'brainstorming')).toMatchObject({ hash: '#/options/claude/skills' })
    expect(index.find((e: SearchEntry) => e.kind === 'plugin' && e.label === 'agent-skills')).toMatchObject({ hash: '#/options/claude/plugins' })
    expect(index.find((e: SearchEntry) => e.kind === 'mcp' && e.label === 'chrome-devtools')).toMatchObject({ hash: '#/options/claude/mcp' })
    expect(index.find((e: SearchEntry) => e.kind === 'page' && e.label === 'RAW repos.yaml')).toMatchObject({ hash: '#/options/raw' })
  })

  it('ranks a label prefix match above a label substring match', () => {
    const results = searchOptions(index, 'pet', 8)
    expect(results[0]).toMatchObject({ kind: 'repo', label: 'petree' })
  })

  it('ranks a label match above a detail-only match', () => {
    const results = searchOptions(index, 'token', 8)
    expect(results[0]).toMatchObject({ kind: 'setting', label: 'TOKEN BUDGET' })
  })

  it('finds a setting purely by its help text ("bin" -> GAME OVER CLEAN-UP)', () => {
    const results = searchOptions(index, 'bin', 8)
    expect(results.some((r: SearchEntry) => r.kind === 'setting' && r.label === 'GAME OVER CLEAN-UP')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(searchOptions(index, 'PETREE', 8)[0]).toMatchObject({ label: 'petree' })
  })

  it('returns an empty list for no match', () => {
    expect(searchOptions(index, 'zzzznotfound', 8)).toEqual([])
  })

  it('returns an empty list for an empty query', () => {
    expect(searchOptions(index, '', 8)).toEqual([])
  })

  it('caps results at the given limit', () => {
    expect(searchOptions(index, 'o', 2)).toHaveLength(2)
  })

  it('breaks ties by kind order then label', () => {
    // all four entries score 2 (label substring) on "zz"; order must follow
    // KIND_ORDER (repo, setting, skill, plugin, mcp, tag, page) then label
    const tied: SearchEntry[] = [
      { kind: 'tag', label: 'zz-tag', detail: '', hash: '#t' },
      { kind: 'mcp', label: 'zz-mcp', detail: '', hash: '#m' },
      { kind: 'repo', label: 'zz-repo-b', detail: '', hash: '#rb' },
      { kind: 'repo', label: 'zz-repo-a', detail: '', hash: '#ra' },
    ]
    const results = searchOptions(tied, 'zz', 8)
    expect(results.map((r: SearchEntry) => r.label)).toEqual(['zz-repo-a', 'zz-repo-b', 'zz-mcp', 'zz-tag'])
  })
})
