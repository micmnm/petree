import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
