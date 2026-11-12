import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Suggestion { repo: string; topic: string; text: string; exists: boolean }

export class NoteInputError extends Error {}

const SLUG = /^[a-z0-9-]+$/

function check(repo: string, topic: string, repos: string[]): void {
  if (!repos.includes(repo)) throw new NoteInputError(`unknown repo: ${repo}`)
  if (!SLUG.test(topic)) throw new NoteInputError(`invalid topic: ${topic}`)
}

const suggestionDir = (workDir: string, repo: string) => join(workDir, '_thread', 'notes', repo)

export function readThreadFile(workDir: string, name: 'spec.md' | 'findings.md'): string | null {
  try {
    return readFileSync(join(workDir, '_thread', name), 'utf8')
  } catch {
    return null
  }
}

export function listSuggestions(notesHome: string, workDir: string, repos: string[]): Suggestion[] {
  const out: Suggestion[] = []
  for (const repo of repos) {
    let entries
    try {
      entries = readdirSync(suggestionDir(workDir, repo), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      const topic = e.name.slice(0, -3)
      if (!SLUG.test(topic)) continue
      out.push({
        repo,
        topic,
        text: readFileSync(join(suggestionDir(workDir, repo), e.name), 'utf8'),
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
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${s.topic}.md`), s.text)

  const line = `- [${s.topic}](${s.topic}.md) — ${s.summary.replace(/\s+/g, ' ').trim()}`
  const indexPath = join(dir, 'INDEX.md')
  const lines = existsSync(indexPath) ? readFileSync(indexPath, 'utf8').split('\n').filter(l => l !== '') : []
  const i = lines.findIndex(l => l.startsWith(`- [${s.topic}](`))
  if (i >= 0) lines[i] = line
  else lines.push(line)
  writeFileSync(indexPath, lines.join('\n') + '\n')

  rmSync(join(suggestionDir(workDir, s.repo), `${s.topic}.md`), { force: true })
}

export function dropSuggestion(workDir: string, repo: string, topic: string, repos: string[]): void {
  check(repo, topic, repos)
  rmSync(join(suggestionDir(workDir, repo), `${topic}.md`), { force: true })
}
