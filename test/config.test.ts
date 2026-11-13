import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadConfig, parseConfigText, resolveModel } from '../src/config.js'

function petreeHome(yamlText: string): string {
  const home = mkdtempSync(join(tmpdir(), 'petree-'))
  writeFileSync(join(home, 'repos.yaml'), yamlText)
  return home
}

describe('loadConfig', () => {
  it('parses repos and fills defaults', () => {
    const home = petreeHome(`
repos:
  demo:
    url: file:///tmp/demo
    image: sandbox-node
`)
    const cfg = loadConfig(home)
    expect(cfg.defaults).toEqual({ timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null, instructions: '' })
    expect(cfg.repos.demo.url).toBe('file:///tmp/demo')
    expect(cfg.repos.demo.defaultBranch).toBe('main')
    expect(cfg.repos.demo.setup).toEqual([])
    expect(cfg.repos.demo.build).toEqual([])
    expect(cfg.repos.demo.instructions).toBe('')
    expect(cfg.defaults.instructions).toBe('')
    expect(cfg.allowClone).toEqual([])
  })

  it('honors explicit defaults (snake_case keys as in the spec)', () => {
    const home = petreeHome(`
defaults:
  timeout_minutes: 10
  token_budget: 1000
  concurrency: 1
repos:
  demo: { url: x, image: sandbox-node }
`)
    const cfg = loadConfig(home)
    expect(cfg.defaults).toEqual({ timeoutMinutes: 10, tokenBudget: 1000, concurrency: 1, defaultModel: null, instructions: '' })
  })

  it('rejects a repo without an image', () => {
    const home = petreeHome(`
repos:
  bad: { url: x }
`)
    expect(() => loadConfig(home)).toThrow(/image/)
  })
})

describe('parseConfigText', () => {
  it('parses YAML text directly, without touching disk', () => {
    const cfg = parseConfigText(`
repos:
  demo:
    url: file:///tmp/demo
    image: sandbox-node
`)
    expect(cfg.repos.demo.url).toBe('file:///tmp/demo')
    expect(cfg.allowClone).toEqual([])
  })

  it('throws the same validation errors as loadConfig', () => {
    expect(() => parseConfigText('repos:\n  bad: { url: x }\n')).toThrow(/image/)
  })

  it('parses path with ~ expansion; absent or bare ~ means no path', () => {
    const cfg = parseConfigText(`
repos:
  a: { url: x, image: i, path: ~/code/a }
  b: { url: x, image: i, path: /abs/b }
  c: { url: x, image: i, path: ~ }
  d: { url: x, image: i }
`)
    expect(cfg.repos.a.path).toBe(join(homedir(), 'code/a'))
    expect(cfg.repos.b.path).toBe('/abs/b')
    expect(cfg.repos.c.path).toBeNull()
    expect(cfg.repos.d.path).toBeNull()
  })

  it('inherits path through <<: merge keys', () => {
    const cfg = parseConfigText(`
repos:
  a: &base { url: x, image: i, path: /shared }
  b:
    <<: *base
    url: y
`)
    expect(cfg.repos.b.path).toBe('/shared')
  })
})

// These guard the js-yaml behaviours petree depends on but never states.
// They are the first things to break on a js-yaml major bump, and `npm run
// typecheck` cannot see any of them.
describe('repos.yaml parsing contract', () => {
  // An empty or fully commented-out repos.yaml means "no repos configured",
  // not an error. `---` and `~` are included because they are the only inputs
  // that still reach the `?? {}` fallback in parseConfigText — everything else
  // document-less comes back as undefined from loadAll's empty list.
  it.each([
    ['empty', ''],
    ['whitespace only', '   \n\n'],
    ['comments only', '# nothing configured yet\n'],
    ['an explicit empty document', '---\n'],
    ['an explicit null document', '~\n'],
  ])('treats %s input as an empty config', (_label, text) => {
    const cfg = parseConfigText(text)
    expect(cfg.repos).toEqual({})
    expect(cfg.allowClone).toEqual([])
    expect(cfg.defaults.concurrency).toBe(3)
  })

  // The startup path specifically: an unconfigured repos.yaml on disk must not
  // stop the dashboard from booting.
  it('loads an empty repos.yaml from disk without throwing', () => {
    expect(loadConfig(petreeHome('')).repos).toEqual({})
    expect(loadConfig(petreeHome('# nothing here\n')).repos).toEqual({})
  })

  // Accepting a multi-document file would silently use only the first one.
  it('rejects a file holding more than one YAML document', () => {
    expect(() =>
      parseConfigText('repos:\n  a: { url: x, image: sandbox-node }\n---\nrepos:\n  b: { url: y, image: sandbox-node }\n'),
    ).toThrow(/single YAML document/)
  })

  // repos.yaml is hand-written, so anchors + `<<:` are a natural way to share
  // settings between repos. Losing merge support is silent: merged-away
  // `instructions` would just vanish from every prompt. Without the merge tag
  // the merged keys land under a literal "<<" property, so `image` goes missing
  // and this fails on the "image is required" check before reaching the
  // assertions.
  it('resolves anchors merged in with a merge key', () => {
    const cfg = parseConfigText(`
common: &common
  image: sandbox-node
  instructions: Run the tests.
repos:
  a:
    <<: *common
    url: url-a
  b:
    <<: *common
    url: url-b
    instructions: Override.
`)
    expect(cfg.repos.a).toMatchObject({
      url: 'url-a',
      image: 'sandbox-node',
      instructions: 'Run the tests.',
    })
    expect(cfg.repos.b).toMatchObject({ url: 'url-b', image: 'sandbox-node', instructions: 'Override.' })
  })

  // The silent case: with url and image given explicitly, a lost merge raises
  // no validation error at all — the standing instructions just quietly stop
  // reaching the agent's prompt.
  it('resolves a merge that contributes only instructions', () => {
    const cfg = parseConfigText(`
common: &common
  instructions: Run the tests.
repos:
  a:
    <<: *common
    url: url-a
    image: sandbox-node
`)
    expect(cfg.repos.a.instructions).toBe('Run the tests.')
  })

  // Merges also have to resolve in the `defaults` block, which is read by a
  // separate code path from `repos`.
  it('resolves a merge key in the defaults block', () => {
    const cfg = parseConfigText(`
shared: &shared
  concurrency: 7
defaults:
  <<: *shared
  token_budget: 1234
`)
    expect(cfg.defaults.concurrency).toBe(7)
    expect(cfg.defaults.tokenBudget).toBe(1234)
  })
})

describe('per-repo prompt settings', () => {
  it('parses instructions and setup/build/test commands', () => {
    const home = petreeHome(`
defaults:
  instructions: |
    Write a failing test first.
repos:
  demo:
    url: x
    image: sandbox-node
    instructions: |
      Never edit src/generated/.
      Keep public APIs backwards compatible.
    setup: ["npm ci"]
    build: ["npm run build"]
    test: ["npm test", "npm run typecheck"]
`)
    const cfg = loadConfig(home)
    expect(cfg.defaults.instructions).toBe('Write a failing test first.')
    expect(cfg.repos.demo.instructions).toBe('Never edit src/generated/.\nKeep public APIs backwards compatible.')
    expect(cfg.repos.demo.setup).toEqual(['npm ci'])
    expect(cfg.repos.demo.build).toEqual(['npm run build'])
    expect(cfg.repos.demo.test).toEqual(['npm test', 'npm run typecheck'])
  })

  it('accepts a bare string where a command list is expected', () => {
    const home = petreeHome(`
repos:
  demo: { url: x, image: sandbox-node, test: npm test, setup: "" }
`)
    const cfg = loadConfig(home)
    expect(cfg.repos.demo.test).toEqual(['npm test'])
    expect(cfg.repos.demo.setup).toEqual([])
  })
})

describe('run commands', () => {
  it('parses run as a command list and defaults to []', () => {
    const cfg = parseConfigText(`
repos:
  demo: { url: x, image: sandbox-node, run: pnpm dev }
  bare: { url: y, image: sandbox-node }
`)
    expect(cfg.repos.demo.run).toEqual(['pnpm dev'])
    expect(cfg.repos.bare.run).toEqual([])
  })
})

describe('tags', () => {
  it('parses tags from a list or bare string and defaults to []', () => {
    const cfg = parseConfigText(`
repos:
  a: { url: x, image: sandbox-node, tags: [work, backend] }
  b: { url: y, image: sandbox-node, tags: personal }
  c: { url: z, image: sandbox-node }
`)
    expect(cfg.repos.a.tags).toEqual(['work', 'backend'])
    expect(cfg.repos.b.tags).toEqual(['personal'])
    expect(cfg.repos.c.tags).toEqual([])
  })
})

describe('default_model', () => {
  it('parses default_model at defaults and repo level', () => {
    const home = petreeHome(`
defaults:
  default_model: sonnet
repos:
  demo: { url: x, image: sandbox-node }
  fast: { url: y, image: sandbox-node, default_model: haiku }
`)
    const cfg = loadConfig(home)
    expect(cfg.defaults.defaultModel).toBe('sonnet')
    expect(cfg.repos.demo.defaultModel).toBeNull()
    expect(cfg.repos.fast.defaultModel).toBe('haiku')
  })

  it('defaults default_model to null when absent', () => {
    const home = petreeHome(`
repos:
  demo: { url: x, image: sandbox-node }
`)
    const cfg = loadConfig(home)
    expect(cfg.defaults.defaultModel).toBeNull()
  })
})

describe('resolveModel', () => {
  it('prefers an explicit request over defaults', () => {
    expect(resolveModel('opus', 'haiku', 'sonnet')).toBe('opus')
  })
  it("treats 'default' as no-preference and falls through", () => {
    expect(resolveModel('default', 'haiku', 'sonnet')).toBe('haiku')
  })
  it('falls back repo then global then null', () => {
    expect(resolveModel(undefined, null, 'sonnet')).toBe('sonnet')
    expect(resolveModel(undefined, 'haiku', 'sonnet')).toBe('haiku')
    expect(resolveModel(null, null, null)).toBeNull()
  })
})
