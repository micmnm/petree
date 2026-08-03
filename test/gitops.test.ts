import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { taskBranch, createTaskBranch, commitChanges, repoStatus, diffBranch, pushBranch } from '../src/gitops.js'

// a clone-shaped fixture: a bare "origin" + a working clone on branch main
function fixture(): { repoDir: string; bare: string } {
  const root = mkdtempSync(join(tmpdir(), 'petree-gitops-'))
  const bare = join(root, 'origin.git')
  execFileSync('git', ['init', '--bare', '-b', 'main', bare])
  const seed = join(root, 'seed')
  execFileSync('git', ['clone', bare, seed])
  writeFileSync(join(seed, 'README.md'), 'base\n')
  execFileSync('git', ['-C', seed, 'add', '.'])
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base'])
  execFileSync('git', ['-C', seed, 'push', 'origin', 'main'])
  const repoDir = join(root, 'work')
  execFileSync('git', ['clone', '--branch', 'main', bare, repoDir])
  return { repoDir, bare }
}

describe('gitops', () => {
  it('creates the task branch', () => {
    const { repoDir } = fixture()
    createTaskBranch(repoDir, 'abc123')
    const cur = execFileSync('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(cur).toBe('petree/abc123')
    expect(taskBranch('abc123')).toBe('petree/abc123')
  })

  it('commits changes only when the tree is dirty', () => {
    const { repoDir } = fixture()
    createTaskBranch(repoDir, 'abc123')
    expect(commitChanges(repoDir, 'abc123', 'petree abc123: nothing')).toBe(false)
    writeFileSync(join(repoDir, 'new.txt'), 'hi\n')
    expect(commitChanges(repoDir, 'abc123', 'petree abc123: add file')).toBe(true)
    const msg = execFileSync('git', ['-C', repoDir, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim()
    expect(msg).toBe('petree abc123: add file')
  })

  it('reports status and diff of the branch vs base', () => {
    const { repoDir } = fixture()
    createTaskBranch(repoDir, 'abc123')
    writeFileSync(join(repoDir, 'README.md'), 'base\nadded line\n')
    commitChanges(repoDir, 'abc123', 'petree abc123: edit')
    const st = repoStatus(repoDir, 'main')
    expect(st.hasChanges).toBe(true)
    expect(st.ahead).toBe(1)
    const d = diffBranch(repoDir, 'main')
    expect(d.stat).toContain('README.md')
    expect(d.patch).toContain('+added line')
  })

  it('pushes the branch to a target and refuses git errors gracefully', () => {
    const { repoDir } = fixture()
    createTaskBranch(repoDir, 'abc123')
    writeFileSync(join(repoDir, 'f.txt'), 'x\n')
    commitChanges(repoDir, 'abc123', 'petree abc123: f')
    const ok = pushBranch(repoDir, 'abc123', 'petree/abc123')
    expect(ok.ok).toBe(true)
    // the branch now exists on origin
    const refs = execFileSync('git', ['-C', repoDir, 'ls-remote', 'origin', 'petree/abc123'], { encoding: 'utf8' })
    expect(refs).toContain('petree/abc123')
  })

  it('returns ok:false with output on a push error', () => {
    const { repoDir } = fixture()
    createTaskBranch(repoDir, 'abc123')
    // remove origin so push fails
    execFileSync('git', ['-C', repoDir, 'remote', 'remove', 'origin'])
    const res = pushBranch(repoDir, 'abc123', 'petree/abc123')
    expect(res.ok).toBe(false)
    expect(res.output.length).toBeGreaterThan(0)
  })

  it('scrubs credential-bearing remote URLs out of push output', () => {
    const { repoDir } = fixture()
    createTaskBranch(repoDir, 'abc123')
    writeFileSync(join(repoDir, 'f.txt'), 'x\n')
    commitChanges(repoDir, 'abc123', 'petree abc123: f')
    // point origin at a URL carrying embedded credentials, like a token-authed remote
    execFileSync('git', ['-C', repoDir, 'remote', 'set-url', 'origin', 'https://x-access-token:s3cr3t@example.com/org/repo.git'])
    const res = pushBranch(repoDir, 'abc123', 'petree/abc123')
    expect(res.output).not.toContain('s3cr3t')
    expect(res.output).not.toContain('https://')
  })

  it('diffBranch returns empty (does not throw) when the base ref is missing', () => {
    const { repoDir } = fixture()
    createTaskBranch(repoDir, 'abc123')
    // remove the remote-tracking ref so origin/main no longer resolves
    execFileSync('git', ['-C', repoDir, 'remote', 'remove', 'origin'])
    expect(() => diffBranch(repoDir, 'main')).not.toThrow()
    const d = diffBranch(repoDir, 'main')
    expect(d).toEqual({ stat: '', patch: '' })
  })
})
