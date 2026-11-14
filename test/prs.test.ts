import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PetreeConfig } from '../src/config.js'
import { createPullRequest, findPr, pollPrs, prHost, prNumber } from '../src/prs.js'
import type { Run } from '../src/prs.js'
import { TaskStore } from '../src/store.js'

describe('prHost', () => {
  it.each([
    ['https://github.com/o/r.git', { kind: 'github', slug: 'o/r' }],
    ['https://x-access-token:t@github.com/o/r', { kind: 'github', slug: 'o/r' }],
    ['git@github.com:o/r.git', { kind: 'github', slug: 'o/r' }],
    ['https://dev.azure.com/org/My%20Proj/_git/repo', { kind: 'azure', org: 'org', project: 'My Proj', repo: 'repo' }],
    ['https://user@dev.azure.com/org/proj/_git/re%20po/', { kind: 'azure', org: 'org', project: 'proj', repo: 're po' }],
    ['https://org.visualstudio.com/proj/_git/repo', { kind: 'azure', org: 'org', project: 'proj', repo: 'repo' }],
    ['file:///tmp/bare.git', { kind: 'untracked', reason: 'unsupported host' }],
    ['https://notgithub.com/o/r', { kind: 'untracked', reason: 'unsupported host' }],
  ])('%s', (url, expected) => {
    expect(prHost(url)).toEqual(expected)
  })

  it('extracts PR numbers from both hosts', () => {
    expect(prNumber('https://github.com/o/r/pull/12')).toBe(12)
    expect(prNumber('https://dev.azure.com/o/p/_git/r/pullrequest/34')).toBe(34)
    expect(prNumber('https://example.com/x')).toBeUndefined()
  })
})

const gh = prHost('https://github.com/o/r') as Extract<ReturnType<typeof prHost>, { kind: 'github' }>
const az = prHost('https://dev.azure.com/org/proj/_git/repo') as Extract<ReturnType<typeof prHost>, { kind: 'azure' }>
const answer = (json: unknown): Run => async () => JSON.stringify(json)
const enoent: Run = async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }

describe('findPr', () => {
  it('maps GitHub states, merge data only when merged', async () => {
    const p = { url: 'u', number: 3, headRefOid: 'abc', mergedAt: 'T', mergedBy: { login: 'me' } }
    expect(await findPr(gh, 'b', answer([{ ...p, state: 'MERGED' }])))
      .toEqual({ url: 'u', number: 3, pr: 'merged', prHead: 'abc', mergedAt: 'T', mergedBy: 'me' })
    expect(await findPr(gh, 'b', answer([{ ...p, state: 'OPEN' }]))).toEqual({ url: 'u', number: 3, pr: 'open', prHead: 'abc' })
    expect((await findPr(gh, 'b', answer([{ ...p, state: 'CLOSED' }])))?.pr).toBe('closed')
    expect(await findPr(gh, 'b', answer([]))).toBeNull()
  })

  it('maps Azure states and builds the web URL', async () => {
    const p = { pullRequestId: 9, lastMergeSourceCommit: { commitId: 'c1' }, closedDate: 'D', closedBy: { displayName: 'Ann' } }
    expect(await findPr(az, 'b', answer([{ ...p, status: 'completed' }])))
      .toEqual({ url: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/9', number: 9, pr: 'merged', prHead: 'c1', mergedAt: 'D', mergedBy: 'Ann' })
    expect((await findPr(az, 'b', answer([{ ...p, status: 'active' }])))).not.toHaveProperty('mergedAt')
    expect((await findPr(az, 'b', answer([{ ...p, status: 'abandoned' }])))?.pr).toBe('closed')
  })
})

describe('createPullRequest', () => {
  it('Azure: runs az repos pr create and builds the URL', async () => {
    const calls: string[][] = []
    const run: Run = async (_c, args) => { calls.push(args); return JSON.stringify({ pullRequestId: 5 }) }
    const res = await createPullRequest('https://dev.azure.com/org/proj/_git/repo', '/d', 'feat', 'main', 't', 'b', run)
    expect(res).toMatchObject({ ok: true, number: 5, url: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/5' })
    expect(calls[0].slice(0, 3)).toEqual(['repos', 'pr', 'create'])
    expect(calls[0]).toContain('feat')
  })

  it('GitHub: takes the URL from the last output line', async () => {
    const run: Run = async () => 'warning\nhttps://github.com/o/r/pull/8\n'
    expect(await createPullRequest('https://github.com/o/r', '/d', 'f', 'main', 't', 'b', run))
      .toMatchObject({ ok: true, number: 8, url: 'https://github.com/o/r/pull/8' })
  })

  it('reports a missing CLI and unsupported hosts without running anything', async () => {
    expect(await createPullRequest('https://github.com/o/r', '/d', 'f', 'main', 't', 'b', enoent)).toEqual({ ok: false, output: 'gh not installed' })
    expect(await createPullRequest('file:///x', '/d', 'f', 'main', 't', 'b', enoent)).toEqual({ ok: false, output: 'unsupported host' })
  })
})

describe('pollPrs', () => {
  const cfg = { repos: { demo: { url: 'https://github.com/o/r' }, local: { url: 'file:///x' } } } as unknown as PetreeConfig

  function seed(delivery: Record<string, { ahead: number; head: string; pr?: 'open' | 'merged' }>) {
    const store = new TaskStore(join(mkdtempSync(join(tmpdir(), 'petree-prs-')), 'db'))
    const t = store.create({ prompt: 'p', repos: ['demo'], tokenBudget: 1, timeoutMinutes: 1, stage: 'build' })
    for (const [repo, d] of Object.entries(delivery)) store.setDelivery(t.id, repo, d)
    return { store, id: t.id }
  }
  const merged = answer([{ url: 'u', number: 1, state: 'MERGED', headRefOid: 'h', mergedAt: 'T', mergedBy: { login: 'me' } }])

  it('records PR state and queries the petree branch by default', async () => {
    const { store, id } = seed({ demo: { ahead: 1, head: 'h' } })
    let args: string[] = []
    await pollPrs(store, cfg, undefined, async (_c, a) => { args = a; return merged('', []) })
    expect(args).toContain(`petree/${id}`)
    expect(store.get(id)!.delivery.demo).toMatchObject({ pr: 'merged', number: 1, mergedAt: 'T', mergedBy: 'me' })
  })

  it('writes only when something changed', async () => {
    const { store, id } = seed({ demo: { ahead: 1, head: 'h', pr: 'open' } })
    const run = answer([{ url: 'u', number: 1, state: 'OPEN', headRefOid: 'h' }])
    await pollPrs(store, cfg, undefined, run)
    const first = store.get(id)!.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    await pollPrs(store, cfg, undefined, run)
    expect(store.get(id)!.updatedAt).toBe(first)
  })

  it('marks the repo untracked on ENOENT or an unsupported host, and clears it once the CLI works', async () => {
    const { store, id } = seed({ demo: { ahead: 1, head: 'h' }, local: { ahead: 1, head: 'h' } })
    await pollPrs(store, cfg, undefined, enoent)
    expect(store.get(id)!.delivery.demo.untracked).toBe('gh not installed')
    expect(store.get(id)!.delivery.local.untracked).toBe('unsupported host')
    await pollPrs(store, cfg, undefined, answer([]))
    expect(store.get(id)!.delivery.demo.untracked).toBeUndefined()
  })

  it('bins hall-of-fame when every repo with commits merged', async () => {
    const { store, id } = seed({ demo: { ahead: 1, head: 'h' }, local: { ahead: 0, head: 'h' } })
    await pollPrs(store, cfg, undefined, merged)
    expect(store.get(id)).toMatchObject({ bin: 'hall-of-fame', binReason: 'merged · PR #1' })
  })

  it('keeps the thread unbinned while a PR is open or another repo is unshipped', async () => {
    const { store, id } = seed({ demo: { ahead: 1, head: 'h' }, local: { ahead: 1, head: 'h' } })
    await pollPrs(store, cfg, undefined, merged)
    expect(store.get(id)!.bin).toBeNull()
  })

  it('bins game-over when a PR closed and none is open', async () => {
    const { store, id } = seed({ demo: { ahead: 1, head: 'h' } })
    await pollPrs(store, cfg, undefined, answer([{ url: 'u', number: 3, state: 'CLOSED', headRefOid: 'h' }]))
    expect(store.get(id)).toMatchObject({ bin: 'game-over', binReason: 'PR closed without merge' })
  })

  it('skips archived threads', async () => {
    const { store, id } = seed({ demo: { ahead: 1, head: 'h' } })
    store.bin(id, 'game-over', 'r')
    store.updateSettings({ binDays: 1 })
    store.sweep(new Date(Date.now() + 2 * 86_400_000))
    let calls = 0
    await pollPrs(store, cfg, undefined, async () => { calls++; return '[]' })
    expect(calls).toBe(0)
  })

  it('uses the first stderr line for other CLI failures', async () => {
    const { store, id } = seed({ demo: { ahead: 1, head: 'h' } })
    await pollPrs(store, cfg, undefined, async () => { throw Object.assign(new Error('x'), { stderr: '\nnot logged in\nmore' }) })
    expect(store.get(id)!.delivery.demo.untracked).toBe('gh: not logged in')
  })

  it('skips merged repos, no-commit repos and non-build or running threads', async () => {
    const { store, id } = seed({ demo: { ahead: 1, head: 'h', pr: 'merged' }, local: { ahead: 0, head: 'h' } })
    let calls = 0
    const run: Run = async () => { calls++; return '[]' }
    await pollPrs(store, cfg, undefined, run)
    store.transition(id, 'provisioning')
    store.transition(id, 'running')
    store.setDelivery(id, 'demo', { pr: undefined })
    await pollPrs(store, cfg, undefined, run)
    expect(calls).toBe(0)
  })
})
