import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PetreeConfig } from './config.js'
import { headSha, pushBranch, scrubUrls, taskBranch } from './gitops.js'
import { threadTitle, type Delivery, type TaskRecord, type TaskStore } from './store.js'

const execFileAsync = promisify(execFile)

// Injected so tests never touch the real gh/az; rejects like execFile (code, stderr).
export type Run = (cmd: string, args: string[], cwd?: string) => Promise<string>
const defaultRun: Run = async (cmd, args, cwd) =>
  (await execFileAsync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout

export type AzureHost = { kind: 'azure'; org: string; project: string; repo: string }
export type PrHost = { kind: 'github'; slug: string } | AzureHost | { kind: 'untracked'; reason: string }

const GITHUB = /^(?:\w+:\/\/)?(?:[^@/]+@)?github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/
const AZURE = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)\/?$/
const AZURE_VS = /^https?:\/\/([^./@]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+?)\/?$/

export function prHost(url: string): PrHost {
  const gh = GITHUB.exec(url)
  if (gh) return { kind: 'github', slug: `${gh[1]}/${gh[2]}` }
  const az = AZURE.exec(url) ?? AZURE_VS.exec(url)
  if (az) return { kind: 'azure', org: decodeURIComponent(az[1]), project: decodeURIComponent(az[2]), repo: decodeURIComponent(az[3]) }
  return { kind: 'untracked', reason: 'unsupported host' }
}

// GitHub `/pull/N` and Azure `/pullrequest/N` web URLs.
export function prNumber(url: string): number | undefined {
  return Number(/\/pull(?:request)?\/(\d+)/.exec(url)?.[1]) || undefined
}

const azureOrg = (h: AzureHost) => `https://dev.azure.com/${encodeURIComponent(h.org)}`
const azureUrl = (h: AzureHost, id: number) =>
  `${azureOrg(h)}/${encodeURIComponent(h.project)}/_git/${encodeURIComponent(h.repo)}/pullrequest/${id}`

const GH_STATE = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const
const AZ_STATE = { active: 'open', completed: 'merged', abandoned: 'closed' } as const

// The newest PR whose source branch is `branch`, as a delivery patch; null when there is none.
export async function findPr(host: Exclude<PrHost, { kind: 'untracked' }>, branch: string, run: Run = defaultRun): Promise<Partial<Delivery> | null> {
  if (host.kind === 'github') {
    const out = await run('gh', ['pr', 'list', '--repo', host.slug, '--head', branch, '--state', 'all',
      '--json', 'url,number,state,headRefOid,mergedAt,mergedBy', '--limit', '1'])
    const p = JSON.parse(out)[0]
    if (!p) return null
    const pr = GH_STATE[p.state as keyof typeof GH_STATE]
    return { url: p.url, number: p.number, pr, prHead: p.headRefOid,
      ...(pr === 'merged' && { mergedAt: p.mergedAt, mergedBy: p.mergedBy?.login }) }
  }
  const out = await run('az', ['repos', 'pr', 'list', '--org', azureOrg(host), '--project', host.project,
    '--repository', host.repo, '--source-branch', branch, '--status', 'all', '--top', '1', '-o', 'json'])
  const p = JSON.parse(out)[0]
  if (!p) return null
  const pr = AZ_STATE[p.status as keyof typeof AZ_STATE]
  return { url: azureUrl(host, p.pullRequestId), number: p.pullRequestId, pr, prHead: p.lastMergeSourceCommit?.commitId,
    ...(pr === 'merged' && { mergedAt: p.closedDate, mergedBy: p.closedBy?.displayName }) }
}

const stderrOf = (err: unknown) => {
  const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string }
  return scrubUrls(String(e.stderr?.toString() || e.stdout?.toString() || e.message || 'failed'))
}
const missing = (err: unknown) => (err as { code?: string }).code === 'ENOENT'
const reason = (cli: string, err: unknown) =>
  missing(err) ? `${cli} not installed` : `${cli}: ${stderrOf(err).split('\n').find((l) => l.trim()) ?? 'failed'}`

// Polls candidate threads (build stage, not running) and records PR state; the store only moves when something changed.
export async function pollPrs(store: TaskStore, cfg: PetreeConfig, onlyId?: string, run: Run = defaultRun): Promise<void> {
  // A thread pruned mid-poll makes setDelivery throw; nothing to record then.
  const set = (id: string, repo: string, patch: Partial<Delivery>) => { try { store.setDelivery(id, repo, patch) } catch { /* gone */ } }
  for (const t of store.list()) {
    if ((onlyId && t.id !== onlyId) || t.stage !== 'build' || t.state === 'running') continue
    for (const [repo, d] of Object.entries(t.delivery)) {
      if (d.ahead <= 0 || d.pr === 'merged' || d.pr === 'closed') continue
      const host = prHost(cfg.repos[repo]?.url ?? '')
      if (host.kind === 'untracked') { set(t.id, repo, { untracked: host.reason }); continue }
      try {
        set(t.id, repo, { ...await findPr(host, d.target ?? taskBranch(t.id), run), untracked: undefined })
      } catch (err) {
        set(t.id, repo, { untracked: reason(host.kind === 'github' ? 'gh' : 'az', err) })
      }
    }
  }
}

// Push petree/<id> to `target`, open the PR and record delivery; shared by POST /pr and AUTO-PLAY.
export async function openPr(
  store: TaskStore,
  cfg: PetreeConfig,
  t: TaskRecord,
  repo: string,
  target: string,
  create: typeof createPullRequest = createPullRequest,
): Promise<{ ok: boolean; output: string; url?: string }> {
  const repoDir = join(cfg.home, 'work', t.id, repo)
  const pushed = pushBranch(repoDir, t.id, target)
  if (!pushed.ok) return pushed
  // The branch is on the remote now, whether or not the PR gets created.
  store.setDelivery(t.id, repo, { target, prHead: headSha(repoDir) })
  const base = cfg.repos[repo]?.defaultBranch ?? 'main'
  const title = `petree ${t.id}: ${threadTitle(t)}`
  const made = await create(cfg.repos[repo].url, repoDir, target, base, title, t.turns[0]?.prompt ?? t.prompt)
  if (made.ok && made.url) store.setDelivery(t.id, repo, { url: made.url, number: made.number, pr: 'open' })
  return { ok: made.ok, output: made.output, url: made.url }
}

export async function createPullRequest(
  repoUrl: string,
  repoDir: string,
  target: string,
  baseBranch: string,
  title: string,
  body: string,
  run: Run = defaultRun,
): Promise<{ ok: boolean; output: string; url?: string; number?: number }> {
  const host = prHost(repoUrl)
  if (host.kind === 'untracked') return { ok: false, output: host.reason }
  const cli = host.kind === 'github' ? 'gh' : 'az'
  try {
    if (host.kind === 'github') {
      const output = (await run('gh', ['pr', 'create', '--head', target, '--base', baseBranch, '--title', title, '--body', body], repoDir)).trim()
      // gh pr create prints the new PR's URL as the last line of stdout.
      const url = output.split('\n').pop()
      return { ok: true, output, url, number: url ? prNumber(url) : undefined }
    }
    const output = await run('az', ['repos', 'pr', 'create', '--org', azureOrg(host), '--project', host.project,
      '--repository', host.repo, '--source-branch', target, '--target-branch', baseBranch,
      '--title', title, '--description', body, '-o', 'json'], repoDir)
    const id = JSON.parse(output).pullRequestId as number
    return { ok: true, output: output.trim(), url: azureUrl(host, id), number: id }
  } catch (err) {
    return { ok: false, output: missing(err) ? `${cli} not installed` : stderrOf(err) }
  }
}
