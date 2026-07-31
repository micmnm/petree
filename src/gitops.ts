import { execFileSync } from 'node:child_process'

const IDENT = ['-c', 'user.name=Petree', '-c', 'user.email=petree@localhost']

function git(repoDir: string, args: string[], opts: { ident?: boolean } = {}): string {
  const full = ['-C', repoDir, ...(opts.ident ? IDENT : []), ...args]
  // Node's default maxBuffer (1 MiB) would otherwise throw ENOBUFS on a large diff/patch.
  return execFileSync('git', full, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

export function taskBranch(taskId: string): string {
  return `petree/${taskId}`
}

export function createTaskBranch(repoDir: string, taskId: string): void {
  git(repoDir, ['checkout', '-b', taskBranch(taskId)])
}

export function commitChanges(repoDir: string, taskId: string, message: string): boolean {
  const status = git(repoDir, ['status', '--porcelain'])
  if (!status.trim()) return false
  git(repoDir, ['add', '-A'])
  git(repoDir, ['commit', '-m', message], { ident: true })
  return true
}

export interface RepoStatus {
  hasChanges: boolean
  ahead: number
  baseBranch: string
}

export function repoStatus(repoDir: string, baseBranch: string): RepoStatus {
  let ahead = 0
  try {
    ahead = Number(git(repoDir, ['rev-list', '--count', `origin/${baseBranch}..HEAD`]).trim()) || 0
  } catch {
    ahead = 0
  }
  return { hasChanges: ahead > 0, ahead, baseBranch }
}

export function diffBranch(repoDir: string, baseBranch: string): { stat: string; patch: string } {
  const base = `origin/${baseBranch}`
  try {
    const stat = git(repoDir, ['diff', '--stat', `${base}...HEAD`])
    const patch = git(repoDir, ['diff', `${base}...HEAD`])
    return { stat, patch }
  } catch {
    return { stat: '', patch: '' }
  }
}

export function pushBranch(repoDir: string, taskId: string, target: string): { ok: boolean; output: string } {
  try {
    const output = git(repoDir, ['push', 'origin', `${taskBranch(taskId)}:${target}`], { ident: true })
    return { ok: true, output: output || `pushed ${taskBranch(taskId)} -> ${target}` }
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string }
    const output = String(e.stderr?.toString() || e.stdout?.toString() || e.message || 'push failed')
    return { ok: false, output }
  }
}
