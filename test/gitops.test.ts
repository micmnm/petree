import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  taskBranch, createTaskBranch, commitChanges, commitStat, repoStatus, diffBranch, pushBranch, saveGitConfig,
  ensureGitConfig,
} from '../src/gitops.js'

// a clone-shaped fixture in the work layout (<root>/work/<id>/<repo>): a bare "origin" + a clone on main
function fixture(): { repoDir: string; bare: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'petree-gitops-'))
  const bare = join(root, 'origin.git')
  execFileSync('git', ['init', '--bare', '-b', 'main', bare])
  const seed = join(root, 'seed')
  execFileSync('git', ['clone', bare, seed])
  writeFileSync(join(seed, 'README.md'), 'base\n')
  execFileSync('git', ['-C', seed, 'add', '.'])
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base'])
  execFileSync('git', ['-C', seed, 'push', 'origin', 'main'])
  const repoDir = join(root, 'work', 'abc123', 'demo')
  mkdirSync(join(root, 'work', 'abc123'), { recursive: true })
  execFileSync('git', ['clone', '--branch', 'main', bare, repoDir])
  saveGitConfig(repoDir)
  return { repoDir, bare, root }
}

describe('an agent-written .git', () => {
  // Each payload touches its own marker; none may exist after the host's git calls.
  function arm(root: string, repoDir: string, bare: string) {
    const markers: Record<string, string> = {}
    const script = (name: string, body = '') => {
      markers[name] = join(root, `${name}-ran`)
      const p = join(root, `${name}.sh`)
      writeFileSync(p, `#!/bin/sh\ntouch "${markers[name]}"\n${body}`)
      chmodSync(p, 0o755)
      return p
    }
    const ext = `ext::sh -c touch% ${join(root, 'insteadof-ran')}`
    markers.insteadOf = join(root, 'insteadof-ran')
    appendFileSync(join(repoDir, '.git', 'config'), [
      '[core]', `\tfsmonitor = ${script('fsmonitor')}`, `\tsshCommand = ${script('ssh')}`,
      '[filter "evil"]', `\tclean = ${script('filter', 'cat\n')}`, '[diff "evil"]', `\ttextconv = ${script('textconv', 'cat "$1"\n')}`,
      '[diff]', `\texternal = ${script('extdiff')}`,
      '[gpg]', `\tprogram = ${script('gpg')}`, '[commit]', '\tgpgSign = true',
      '[protocol "ext"]', '\tallow = always', `[url "${ext}"]`, `\tinsteadOf = ${bare}`, `\tpushInsteadOf = ${bare}`,
      '',
    ].join('\n'))
    mkdirSync(join(repoDir, '.git', 'info'), { recursive: true })
    writeFileSync(join(repoDir, '.git', 'info', 'attributes'), '* filter=evil diff=evil\n')
    writeFileSync(join(repoDir, '.gitattributes'), '* filter=evil diff=evil\n')
    return markers
  }

  it('runs no agent-configured command during commit, stat, diff or push', () => {
    const { repoDir, bare, root } = fixture()
    createTaskBranch(repoDir, 'abc123')
    const markers = arm(root, repoDir, bare)
    writeFileSync(join(repoDir, 'README.md'), 'base\nchanged\n')
    expect(commitChanges(repoDir, 'abc123', 'petree abc123: x')).toBe(true)
    commitStat(repoDir)
    expect(diffBranch(repoDir, 'main').patch).toContain('+changed')
    expect(pushBranch(repoDir, 'abc123', 'petree/abc123', bare).ok).toBe(true)
    expect(pushBranch(repoDir, 'abc123', 'petree/abc123', 'ssh://127.0.0.1:9/x.git').ok).toBe(false)
    expect(Object.entries(markers).filter(([, m]) => existsSync(m)).map(([k]) => k)).toEqual([])
    expect(execFileSync('git', ['-C', bare, 'branch', '--list', 'petree/abc123'], { encoding: 'utf8' })).toContain('petree/abc123')
  })

  it('seals a pre-upgrade repo with a config built from trusted data, never from the agent-written one', () => {
    const { repoDir, bare, root } = fixture()
    createTaskBranch(repoDir, 'abc123')
    rmSync(join(root, 'gitconfig'), { recursive: true })
    const markers = arm(root, repoDir, bare)
    ensureGitConfig(repoDir, bare)
    const copy = readFileSync(join(root, 'gitconfig', 'abc123', 'demo'), 'utf8')
    expect(copy).toContain(`url = "${bare}"`)
    expect(copy).not.toMatch(/evil|fsmonitor|gpg|ext::/)
    writeFileSync(join(repoDir, 'README.md'), 'base\nchanged\n')
    expect(commitChanges(repoDir, 'abc123', 'petree abc123: x')).toBe(true)
    expect(repoStatus(repoDir, 'main').ahead).toBe(1)
    expect(pushBranch(repoDir, 'abc123', 'petree/abc123', bare).ok).toBe(true)
    expect(Object.entries(markers).filter(([, m]) => existsSync(m)).map(([k]) => k)).toEqual([])
    expect(readFileSync(join(repoDir, '.git', 'config'), 'utf8')).toBe(copy)
  })

  it('refuses a .git that points elsewhere or a work repo without a host copy of its config', () => {
    const { repoDir } = fixture()
    const other = fixture().repoDir
    rmSync(join(repoDir, '.git'), { recursive: true })
    writeFileSync(join(repoDir, '.git'), `gitdir: ${join(other, '.git')}\n`)
    expect(() => commitChanges(repoDir, 'abc123', 'x')).toThrow(/not a directory/)
    rmSync(join(other, '..', '..', '..', 'gitconfig'), { recursive: true })
    expect(() => commitChanges(other, 'abc123', 'x')).toThrow()
  })
})

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

  it('does not run repo-controlled git hooks on commit', () => {
    const { repoDir } = fixture()
    createTaskBranch(repoDir, 'abc123')
    const marker = join(repoDir, '..', 'hook-ran')
    const hook = join(repoDir, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`)
    chmodSync(hook, 0o755)
    writeFileSync(join(repoDir, 'new.txt'), 'hi\n')
    expect(commitChanges(repoDir, 'abc123', 'petree abc123: hook')).toBe(true)
    expect(existsSync(marker)).toBe(false)
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
    const { repoDir, bare } = fixture()
    createTaskBranch(repoDir, 'abc123')
    writeFileSync(join(repoDir, 'f.txt'), 'x\n')
    commitChanges(repoDir, 'abc123', 'petree abc123: f')
    const ok = pushBranch(repoDir, 'abc123', 'petree/abc123', bare)
    expect(ok.ok).toBe(true)
    // the branch now exists on origin
    const refs = execFileSync('git', ['-C', repoDir, 'ls-remote', 'origin', 'petree/abc123'], { encoding: 'utf8' })
    expect(refs).toContain('petree/abc123')
  })

  it('returns ok:false with output on a push error', () => {
    const { repoDir, root } = fixture()
    createTaskBranch(repoDir, 'abc123')
    const res = pushBranch(repoDir, 'abc123', 'petree/abc123', join(root, 'missing.git'))
    expect(res.ok).toBe(false)
    expect(res.output.length).toBeGreaterThan(0)
  })

  it('scrubs credential-bearing remote URLs out of push output', () => {
    const { repoDir } = fixture()
    createTaskBranch(repoDir, 'abc123')
    writeFileSync(join(repoDir, 'f.txt'), 'x\n')
    commitChanges(repoDir, 'abc123', 'petree abc123: f')
    // a configured URL carrying embedded credentials, like a token-authed remote
    const res = pushBranch(repoDir, 'abc123', 'petree/abc123', 'https://x-access-token:s3cr3t@example.invalid/org/repo.git')
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
