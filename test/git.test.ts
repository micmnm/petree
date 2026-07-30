import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { PetreeConfig } from '../src/config.js'
import { prepareWorkspace } from '../src/git.js'

function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'petree-fixture-'))
  execFileSync('git', ['init', '-b', 'main', dir])
  writeFileSync(join(dir, 'README.md'), 'hello')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'])
  return dir
}

function cfgWith(url: string): PetreeConfig {
  return {
    home: '/unused',
    defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3 },
    repos: { demo: { url, defaultBranch: 'main', image: 'sandbox-node', setup: [], test: [], skills: [] } },
    allowClone: [],
  }
}

describe('prepareWorkspace', () => {
  it('clones named repos into workDir/<name>', () => {
    const fixture = makeFixtureRepo()
    const workDir = join(mkdtempSync(join(tmpdir(), 'petree-work-')), 'w')
    prepareWorkspace(cfgWith(`file://${fixture}`), ['demo'], workDir)
    expect(existsSync(join(workDir, 'demo', 'README.md'))).toBe(true)
  })

  it('throws on unknown repo names', () => {
    expect(() => prepareWorkspace(cfgWith('file:///x'), ['nope'], '/tmp/unused-dir')).toThrow(/unknown repo/)
  })
})
