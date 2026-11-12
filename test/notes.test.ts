import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { NoteInputError, acceptNote, dropSuggestion, listSuggestions, readThreadFile } from '../src/notes.js'

let notesHome: string
let workDir: string
const repos = ['demo']

function suggest(repo: string, file: string, text = 'body'): string {
  const dir = join(workDir, '_thread', 'notes', repo)
  mkdirSync(dir, { recursive: true })
  const p = join(dir, file)
  writeFileSync(p, text)
  return p
}

beforeEach(() => {
  notesHome = mkdtempSync(join(tmpdir(), 'petree-notes-'))
  workDir = mkdtempSync(join(tmpdir(), 'petree-work-'))
})

describe('readThreadFile', () => {
  it('returns content or null', () => {
    expect(readThreadFile(workDir, 'spec.md')).toBeNull()
    mkdirSync(join(workDir, '_thread'))
    writeFileSync(join(workDir, '_thread', 'spec.md'), 'hello')
    expect(readThreadFile(workDir, 'spec.md')).toBe('hello')
  })
})

describe('listSuggestions', () => {
  it('lists slug .md files for listed repos and flags existing', () => {
    suggest('demo', 'run-locally.md', 'text')
    suggest('demo', 'Bad Name.md')
    suggest('other', 'x.md')
    mkdirSync(join(workDir, '_thread', 'notes', 'demo', 'nested'))
    writeFileSync(join(workDir, '_thread', 'notes', 'demo', 'nested', 'y.md'), 'y')
    expect(listSuggestions(notesHome, workDir, repos)).toEqual([
      { repo: 'demo', topic: 'run-locally', text: 'text', exists: false },
    ])
    mkdirSync(join(notesHome, 'demo'), { recursive: true })
    writeFileSync(join(notesHome, 'demo', 'run-locally.md'), 'old')
    expect(listSuggestions(notesHome, workDir, repos)[0].exists).toBe(true)
  })
})

describe('acceptNote', () => {
  const note = { repo: 'demo', topic: 'run-locally', text: 'use docker', summary: 'needs postgres' }
  const line = '- [run-locally](run-locally.md) — needs postgres'

  it('writes note and index, replaces line on re-accept, removes suggestion', () => {
    const p = suggest('demo', 'run-locally.md')
    acceptNote(notesHome, workDir, note, repos)
    expect(readFileSync(join(notesHome, 'demo', 'run-locally.md'), 'utf8')).toBe('use docker')
    expect(readFileSync(join(notesHome, 'demo', 'INDEX.md'), 'utf8')).toContain(line)
    expect(existsSync(p)).toBe(false)
    acceptNote(notesHome, workDir, { ...note, summary: 'needs postgres' }, repos)
    const lines = readFileSync(join(notesHome, 'demo', 'INDEX.md'), 'utf8').split('\n').filter(l => l.includes('](run-locally.md)'))
    expect(lines).toEqual([line])
  })

  it('collapses newlines in summary', () => {
    acceptNote(notesHome, workDir, { ...note, summary: 'a\nb' }, repos)
    expect(readFileSync(join(notesHome, 'demo', 'INDEX.md'), 'utf8')).toContain('— a b')
  })

  it('rejects bad topic or repo without writing', () => {
    expect(() => acceptNote(notesHome, workDir, { ...note, topic: '../x' }, repos)).toThrow(NoteInputError)
    expect(() => acceptNote(notesHome, workDir, { ...note, repo: 'other' }, repos)).toThrow(NoteInputError)
    expect(existsSync(join(notesHome, 'demo'))).toBe(false)
    expect(existsSync(join(notesHome, 'other'))).toBe(false)
  })
})

describe('dropSuggestion', () => {
  it('removes the file and rejects bad topic', () => {
    const p = suggest('demo', 'a.md')
    dropSuggestion(workDir, 'demo', 'a', repos)
    expect(existsSync(p)).toBe(false)
    expect(() => dropSuggestion(workDir, 'demo', '../a', repos)).toThrow(NoteInputError)
  })
})
