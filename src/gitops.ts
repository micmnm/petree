import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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

// Work repos live at <home>/work/<id>/<repo>; the host keeps each one's clone-time .git/config at
// <home>/gitconfig/<id>/<repo>, outside the agent's mount.
const hostConfig = (repoDir: string) =>
  join(repoDir, '..', '..', '..', 'gitconfig', basename(dirname(repoDir)), basename(repoDir))

export function saveGitConfig(repoDir: string): void {
  const dest = hostConfig(repoDir)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(join(repoDir, '.git', 'config'), dest)
}

// Repos cloned before host copies existed get one built from trusted data only, never from the
// agent-written config. SHA-1 only: a SHA-256 repo can't be read under version 0, so git fails closed.
export function ensureGitConfig(repoDir: string, url: string): void {
  const dest = hostConfig(repoDir)
  if (existsSync(dest)) return
  if (/[\r\n\0]/.test(url)) throw new Error('repo url contains a line break')
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, [
    '[core]', '\trepositoryformatversion = 0', '\tfilemode = true', '\tbare = false', '\tlogallrefupdates = true',
    '[remote "origin"]', `\turl = "${url.replace(/[\\"]/g, '\\$&')}"`, '\tfetch = +refs/heads/*:refs/remotes/origin/*', '',
  ].join('\n'), { flag: 'wx' })
}

// The agent owns the work repo, .git included, and git config can run commands (filters, gpg, ssh, credential
// helpers, insteadOf to ext::). So before each call: refuse a symlinked repo or a `.git` file pointing elsewhere,
// put back the clone-time config, and drop the git-dir files that extend or redirect it.
function seal(repoDir: string): void {
  const dotGit = join(repoDir, '.git')
  for (const p of [repoDir, dotGit]) if (!lstatSync(p).isDirectory()) throw new Error(`${p} is not a directory`)
  const config = readFileSync(hostConfig(repoDir))
  for (const p of ['config', 'config.worktree', 'commondir', 'info']) rmSync(join(dotGit, p), { recursive: true, force: true })
  writeFileSync(join(dotGit, 'config'), config, { flag: 'wx' })
}

// Belt and braces for what the restored config already drops; no override for ssh/credential settings,
// which would clobber the user's own global ones.
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
  '-c', 'commit.gpgSign=false', '-c', 'protocol.ext.allow=never']

function git(repoDir: string, args: string[], opts: { ident?: boolean } = {}): string {
  seal(repoDir)
  const full = ['-C', repoDir, ...SAFE, ...(opts.ident ? IDENT : []), ...args]
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
  // A nested repo would make status spawn git inside it, under that repo's own agent-written config.
  const status = git(repoDir, ['status', '--porcelain', '--ignore-submodules=all'])
  if (!status.trim()) return false
  git(repoDir, ['add', '-A'])
  git(repoDir, ['commit', '-m', message], { ident: true })
  return true
}

// Files/insertions/deletions of HEAD, from `git show --shortstat`.
export function commitStat(repoDir: string): { files: number; add: number; del: number } {
  const out = git(repoDir, ['show', '--no-ext-diff', '--no-textconv', '--shortstat', '--format=', 'HEAD'])
  const n = (re: RegExp) => Number(re.exec(out)?.[1] ?? 0)
  return { files: n(/(\d+) files? changed/), add: n(/(\d+) insertions?\(\+\)/), del: n(/(\d+) deletions?\(-\)/) }
}

export interface RepoStatus {
  hasChanges: boolean
  ahead: number
  baseBranch: string
}

// Commits on HEAD beyond origin/<base>; throws when that can't be read, so callers never record a bogus 0.
export function aheadCount(repoDir: string, baseBranch: string): number {
  return Number(git(repoDir, ['rev-list', '--count', `origin/${baseBranch}..HEAD`]).trim()) || 0
}

export function repoStatus(repoDir: string, baseBranch: string): RepoStatus {
  let ahead = 0
  try {
    ahead = aheadCount(repoDir, baseBranch)
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
    const stat = git(repoDir, ['diff', '--no-ext-diff', '--no-textconv', '--stat', `${base}...HEAD`])
    const patch = git(repoDir, ['diff', '--no-ext-diff', '--no-textconv', `${base}...HEAD`])
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

// Pushes to the configured URL, never to `origin`, whose url/pushurl live in the agent-writable config.
export function pushBranch(repoDir: string, taskId: string, target: string, url: string): { ok: boolean; output: string } {
  try {
    const output = git(repoDir, ['push', url, `${taskBranch(taskId)}:${target}`], { ident: true })
    return { ok: true, output: scrubUrls(output || `pushed ${taskBranch(taskId)} -> ${target}`) }
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string }
    const output = String(e.stderr?.toString() || e.stdout?.toString() || e.message || 'push failed')
    return { ok: false, output: scrubUrls(output) }
  }
}
