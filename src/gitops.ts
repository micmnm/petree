import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const IDENT = ['-c', 'user.name=Petree', '-c', 'user.email=petree@localhost']

// Unpushed commits and uncommitted changes in the user's own checkout. No fetch,
// so stale remote refs can only over-warn; any failure (bad path, not a repo) is null.
export async function localCheckout(path: string): Promise<{ unpushed: number; dirty: boolean } | null> {
  const run = async (args: string[]) =>
    (await execFileAsync('git', ['-C', path, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args])).stdout
  try {
    const [count, status] = await Promise.all([
      run(['rev-list', '--count', '--branches', '--not', '--remotes']),
      run(['status', '--porcelain']),
    ])
    return { unpushed: Number(count), dirty: status.trim() !== '' }
  } catch {
    return null
  }
}

function git(repoDir: string, args: string[], opts: { ident?: boolean } = {}): string {
  // The agent can write the repo's .git, so neutralise hooks and fsmonitor (both run host commands).
  const full = ['-C', repoDir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...(opts.ident ? IDENT : []), ...args]
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

// Files/insertions/deletions of HEAD, from `git show --shortstat`.
export function commitStat(repoDir: string): { files: number; add: number; del: number } {
  const out = git(repoDir, ['show', '--shortstat', '--format=', 'HEAD'])
  const n = (re: RegExp) => Number(re.exec(out)?.[1] ?? 0)
  return { files: n(/(\d+) files? changed/), add: n(/(\d+) insertions?\(\+\)/), del: n(/(\d+) deletions?\(-\)/) }
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

export function headSha(repoDir: string): string {
  return git(repoDir, ['rev-parse', 'HEAD']).trim()
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

// git's push output echoes the remote URL (e.g. "To https://x-access-token:TOKEN@host/repo.git"),
// which can carry embedded credentials — strip URLs before this reaches the API response.
export function scrubUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url redacted]').replace(/\bgit@\S+/gi, '[url redacted]')
}

export function pushBranch(repoDir: string, taskId: string, target: string): { ok: boolean; output: string } {
  try {
    const output = git(repoDir, ['push', 'origin', `${taskBranch(taskId)}:${target}`], { ident: true })
    return { ok: true, output: scrubUrls(output || `pushed ${taskBranch(taskId)} -> ${target}`) }
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string }
    const output = String(e.stderr?.toString() || e.stdout?.toString() || e.message || 'push failed')
    return { ok: false, output: scrubUrls(output) }
  }
}
