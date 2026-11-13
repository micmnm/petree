import { createHash } from 'node:crypto'
import { dump, loadAll, CORE_SCHEMA, mergeTag } from 'js-yaml'

// Text-splice edits of repos.yaml: only the edited block is re-rendered, so
// comments and every other block stay byte-for-byte. js-yaml cannot round-trip them.

export const REPO_KEYS = [
  'url', 'default_branch', 'image', 'instructions', 'setup', 'build', 'test', 'run',
  'skills', 'tags', 'default_model', 'path',
]
export const DEFAULT_KEYS = ['concurrency', 'token_budget', 'timeout_minutes', 'window_usd']

/** The block can't be spliced safely (anchors, flow style, no block mapping). */
export class NotEditable extends Error {}

export const hashText = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Keeps the allowed keys and drops empty values, so unset options leave no noise. */
export function pickFields(body: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    const v = body[k]
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue
    out[k] = v
  }
  return out
}

/** Raw (snake_case, merge keys resolved) fields of one repo, for the edit form. */
export function readRepoFields(text: string, name: string): Record<string, unknown> {
  const doc = loadAll(text, { schema: CORE_SCHEMA.withTags(mergeTag) })[0] as { repos?: Record<string, Record<string, unknown>> } | undefined
  return pickFields(doc?.repos?.[name] ?? {}, REPO_KEYS)
}

interface Span { start: number; end: number; indent: number }

const indentOf = (l: string): number => l.length - l.trimStart().length
const isBlank = (l: string): boolean => /^\s*(#.*)?$/.test(l)
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Finds `name:` among the direct children of lines[from, to). The span ends before
// the next sibling; trailing blanks and sibling-level comments stay outside it.
function findChild(lines: string[], from: number, to: number, name: string): Span | null {
  let indent = -1
  for (let i = from; i < to && indent < 0; i++) if (!isBlank(lines[i])) indent = indentOf(lines[i])
  if (indent < 0) return null
  const key = new RegExp(`^(${esc(name)}|"${esc(name)}"|'${esc(name)}'):(\\s|$)`)
  let start = -1
  let end = to
  for (let i = from; i < to; i++) {
    const l = lines[i]
    if (isBlank(l) || indentOf(l) > indent) continue
    if (start >= 0) { end = i; break }
    if (indentOf(l) === indent && key.test(l.slice(indent))) start = i
  }
  if (start < 0) return null
  while (end > start + 1 && (lines[end - 1].trim() === '' || (isBlank(lines[end - 1]) && indentOf(lines[end - 1]) <= indent))) end--
  return { start, end, indent }
}

const SHARED = /(?:^|[:,[-])\s*[&*][\w-]+|^\s*<<\s*:/m

function editableSpan(lines: string[], s: Span): boolean {
  return !SHARED.test(lines.slice(s.start, s.end).join('\n'))
}

function repoSpan(lines: string[], name: string): Span | null {
  const top = findChild(lines, 0, lines.length, 'repos')
  return top && findChild(lines, top.start + 1, top.end, name)
}

function render(name: string, value: unknown, indent: number): string[] {
  const pad = ' '.repeat(indent)
  return dump({ [name]: value }, { indent: 2, lineWidth: -1 }).trimEnd().split('\n').map((l) => (l ? pad + l : l))
}

/** null = no locatable block for that repo. */
export function repoEditable(text: string, name: string): boolean | null {
  const lines = text.split('\n')
  const s = repoSpan(lines, name)
  return s ? editableSpan(lines, s) : null
}

function spliceBlock(text: string, locate: (l: string[]) => Span | null, what: string, replacement: (s: Span) => string[]): string {
  const lines = text.split('\n')
  const s = locate(lines)
  if (!s || !editableSpan(lines, s)) throw new NotEditable(`${what} uses YAML anchors (or is missing) — edit in RAW`)
  lines.splice(s.start, s.end - s.start, ...replacement(s))
  return lines.join('\n')
}

export const replaceRepo = (text: string, name: string, fields: Record<string, unknown>): string =>
  spliceBlock(text, (l) => repoSpan(l, name), `repo ${name}`, (s) => render(name, fields, s.indent))

export const removeRepo = (text: string, name: string): string =>
  spliceBlock(text, (l) => repoSpan(l, name), `repo ${name}`, () => [])

export function addRepo(text: string, name: string, fields: Record<string, unknown>): string {
  const lines = text.split('\n')
  const top = findChild(lines, 0, lines.length, 'repos')
  if (!top) {
    const base = text === '' || text.endsWith('\n') ? text : `${text}\n`
    return `${base}${base ? '\n' : ''}repos:\n${render(name, fields, 2).join('\n')}\n`
  }
  if (!/^repos:\s*(#.*)?$/.test(lines[top.start])) throw new NotEditable('repos: is not a block mapping — edit in RAW')
  const first = lines.slice(top.start + 1, top.end).find((l) => !isBlank(l))
  lines.splice(top.end, 0, ...render(name, fields, first ? indentOf(first) : 2))
  return lines.join('\n')
}

export function setDefaults(text: string, patch: Record<string, unknown>): string {
  const lines = text.split('\n')
  const s = findChild(lines, 0, lines.length, 'defaults')
  if (!s) {
    const base = text === '' || text.endsWith('\n') ? text : `${text}\n`
    return `${base}${base ? '\n' : ''}${render('defaults', patch, 0).join('\n')}\n`
  }
  const doc = loadAll(text, { schema: CORE_SCHEMA.withTags(mergeTag) })[0] as { defaults?: Record<string, unknown> }
  return spliceBlock(text, (l) => findChild(l, 0, l.length, 'defaults'), 'defaults', (sp) =>
    render('defaults', { ...doc.defaults, ...patch }, sp.indent))
}
