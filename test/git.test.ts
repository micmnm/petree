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
    defaults: { timeoutMinutes: 30, tokenBudget: 500000, concurrency: 3, defaultModel: null },
    repos: { demo: { url, defaultBranch: 'main', image: 'sandbox-node', setup: [], test: [], skills: [], defaultModel: null } },
    allowClone: [],
  }
}

describe('prepareWorkspace', () => {
  it('clones named repos into workDir/<name> on a petree task branch', async () => {
    const fixture = makeFixtureRepo()
    const workDir = join(mkdtempSync(join(tmpdir(), 'petree-work-')), 'w')
    await prepareWorkspace(cfgWith(`file://${fixture}`), ['demo'], workDir, 'abc123')
    expect(existsSync(join(workDir, 'demo', 'README.md'))).toBe(true)
    const branch = execFileSync('git', ['-C', join(workDir, 'demo'), 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(branch).toBe('petree/abc123')
  })

  it('throws on unknown repo names', async () => {
    await expect(prepareWorkspace(cfgWith('file:///x'), ['nope'], '/tmp/unused-dir', 'abc123')).rejects.toThrow(/unknown repo/)
  })
})
