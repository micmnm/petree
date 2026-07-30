import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

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
    expect(cfg.defaults).toEqual({ timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3 })
    expect(cfg.repos.demo.url).toBe('file:///tmp/demo')
    expect(cfg.repos.demo.defaultBranch).toBe('main')
    expect(cfg.repos.demo.setup).toEqual([])
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
    expect(cfg.defaults).toEqual({ timeoutMinutes: 10, tokenBudget: 1000, concurrency: 1 })
  })

  it('rejects a repo without an image', () => {
    const home = petreeHome(`
repos:
  bad: { url: x }
`)
    expect(() => loadConfig(home)).toThrow(/image/)
  })
})
