import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync,
  realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'

export interface Suggestion { repo: string; topic: string; text: string; exists: boolean }

export class NoteInputError extends Error {}

const SLUG = /^[a-z0-9-]+$/

function check(repo: string, topic: string, repos: string[]): void {
  if (!repos.includes(repo)) throw new NoteInputError(`unknown repo: ${repo}`)
  if (!SLUG.test(topic)) throw new NoteInputError(`invalid topic: ${topic}`)
}

const suggestionDir = (workDir: string, repo: string) => join(workDir, '_thread', 'notes', repo)

// Real path of p, resolving through its nearest existing ancestor when p does not exist yet.
// null for a dangling symlink, which a write would follow out of the tree.
function resolveReal(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    try {
      lstatSync(p)
      return null
    } catch {
      const parent = dirname(p)
      if (parent === p) return null
      const real = resolveReal(parent)
      return real && join(real, basename(p))
    }
  }
}

// The agent controls everything under workDir and can plant symlinks there, so
// every path is resolved and must stay inside the root before it is touched.
function contained(p: string, root: string): boolean {
  const real = resolveReal(p)
  const realRoot = resolveReal(root)
  return real !== null && realRoot !== null && real.startsWith(realRoot + sep)
}

function assertContained(p: string, root: string): void {
  if (!contained(p, root)) throw new NoteInputError(`path escapes its root: ${p}`)
}

// A bounded read of a regular file. The agent can plant a FIFO (a plain read blocks the server forever),
// a device, a last-second symlink or a huge file, so: no follow, no blocking, fstat the fd, cap the size.
function readCapped(p: string, max: number): { text: string; mtimeMs: number } | null {
  let fd: number
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return null
    const buf = Buffer.alloc(Math.min(st.size, max))
    const n = readSync(fd, buf, 0, buf.length, 0)
    return { text: buf.toString('utf8', 0, n), mtimeMs: st.mtimeMs }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

const THREAD_FILE_MAX = 1024 * 1024
const STATUS_MAX = 4096

export function readThreadFile(workDir: string, name: 'spec.md' | 'findings.md'): string | null {
  const p = join(workDir, '_thread', name)
  if (!contained(p, workDir)) return null
  return readCapped(p, THREAD_FILE_MAX)?.text ?? null
}

export interface ThreadStatus { topic: string; status: string; needsYou: string | null }

const STATUS_KEYS = { topic: 60, status: 140, 'needs-you': 160 } as const

// Parses `_thread/status.txt`; null when missing, escaping workDir, or written
// before `since` (the turn's startedAt), so a card never shows a previous turn's text.
export function readThreadStatus(workDir: string, since: string | null): ThreadStatus | null {
  const p = join(workDir, '_thread', 'status.txt')
  if (!since || !contained(p, workDir)) return null
  const file = readCapped(p, STATUS_MAX)
  if (!file || file.mtimeMs < Date.parse(since)) return null
  const text = file.text
  const found: Partial<Record<keyof typeof STATUS_KEYS, string>> = {}
  for (const line of text.split('\n')) {
    const m = /^([\w-]+):(.*)$/.exec(line)
    const key = m?.[1].toLowerCase() as keyof typeof STATUS_KEYS | undefined
    if (!m || !key || !(key in STATUS_KEYS) || key in found) continue
    found[key] = m[2].trim().slice(0, STATUS_KEYS[key])
  }
  if (!Object.keys(found).length) return null
  const needs = found['needs-you'] ?? ''
  return {
    topic: found.topic ?? '',
    status: found.status ?? '',
    needsYou: !needs || /^(nothing|none)\.?$/i.test(needs) ? null : needs,
  }
}

export function listSuggestions(notesHome: string, workDir: string, repos: string[]): Suggestion[] {
  const out: Suggestion[] = []
  for (const repo of repos) {
    let entries
    try {
      if (!contained(join(suggestionDir(workDir, repo), 'x'), workDir)) continue
      entries = readdirSync(suggestionDir(workDir, repo), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      const topic = e.name.slice(0, -3)
      if (!SLUG.test(topic)) continue
      const file = join(suggestionDir(workDir, repo), e.name)
      if (!contained(file, workDir)) continue
      out.push({
        repo,
        topic,
        text: readFileSync(file, 'utf8'),
        exists: existsSync(join(notesHome, repo, e.name)),
      })
    }
  }
  return out
}

export function acceptNote(
  notesHome: string,
  workDir: string,
  s: { repo: string; topic: string; text: string; summary: string },
  repos: string[],
): void {
  check(s.repo, s.topic, repos)
  const dir = join(notesHome, s.repo)
  const notePath = join(dir, `${s.topic}.md`)
  const indexPath = join(dir, 'INDEX.md')
  const suggestionPath = join(suggestionDir(workDir, s.repo), `${s.topic}.md`)
  assertContained(notePath, notesHome)
  assertContained(indexPath, notesHome)
  assertContained(suggestionPath, workDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(notePath, s.text)

  const line = `- [${s.topic}](${s.topic}.md) — ${s.summary.replace(/\s+/g, ' ').trim()}`
  const lines = existsSync(indexPath) ? readFileSync(indexPath, 'utf8').split('\n').filter(l => l !== '') : []
  const i = lines.findIndex(l => l.startsWith(`- [${s.topic}](`))
  if (i >= 0) lines[i] = line
  else lines.push(line)
  writeFileSync(indexPath, lines.join('\n') + '\n')

  rmSync(suggestionPath, { force: true })
}

export function dropSuggestion(workDir: string, repo: string, topic: string, repos: string[]): void {
  check(repo, topic, repos)
  const p = join(suggestionDir(workDir, repo), `${topic}.md`)
  assertContained(p, workDir)
  rmSync(p, { force: true })
}
