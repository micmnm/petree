import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { NoteInputError, acceptNote, dropSuggestion, listSuggestions, readThreadFile, readThreadStatus } from '../src/notes.js'

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

  it('caps an oversized file at 1 MiB', () => {
    mkdirSync(join(workDir, '_thread'))
    writeFileSync(join(workDir, '_thread', 'findings.md'), 'x'.repeat(3 * 1024 * 1024))
    expect(readThreadFile(workDir, 'findings.md')).toHaveLength(1024 * 1024)
  })
})

describe('readThreadStatus', () => {
  const since = new Date(Date.now() - 60_000).toISOString()
  const write = (text: string) => {
    mkdirSync(join(workDir, '_thread'), { recursive: true })
    writeFileSync(join(workDir, '_thread', 'status.txt'), text)
  }

  it('parses the first line per key, ignores unknown lines', () => {
    write('topic: First\ntopic: Second\nmood: great\nstatus: Spec written.\nneeds-you: Approve the spec.\n')
    expect(readThreadStatus(workDir, since)).toEqual({ topic: 'First', status: 'Spec written.', needsYou: 'Approve the spec.' })
  })

  it('clips long values', () => {
    write(`topic: ${'a'.repeat(100)}\nstatus: ${'b'.repeat(200)}\nneeds-you: ${'c'.repeat(200)}`)
    const s = readThreadStatus(workDir, since)!
    expect([s.topic.length, s.status.length, s.needsYou!.length]).toEqual([60, 140, 160])
  })

  it('maps nothing, none and empty needs-you to null', () => {
    for (const v of ['nothing', 'None.', '']) {
      write(`topic: t\nstatus: s\nneeds-you: ${v}`)
      expect(readThreadStatus(workDir, since)!.needsYou).toBeNull()
    }
  })

  it('returns null when missing, garbled, or without a turn start', () => {
    expect(readThreadStatus(workDir, since)).toBeNull()
    write('just some prose')
    expect(readThreadStatus(workDir, since)).toBeNull()
    write('topic: t')
    expect(readThreadStatus(workDir, null)).toBeNull()
  })

  it('returns null when written before the turn started', () => {
    write('topic: t\nstatus: s\nneeds-you: nothing')
    expect(readThreadStatus(workDir, new Date(Date.now() + 60_000).toISOString())).toBeNull()
  })

  it('reads only the first 4 KiB', () => {
    write(`topic: t\n${'x'.repeat(5000)}\nneeds-you: hidden\n`)
    expect(readThreadStatus(workDir, since)).toMatchObject({ topic: 't', needsYou: null })
  })

  it.skipIf(process.platform === 'win32')('returns null for a FIFO instead of blocking', () => {
    mkdirSync(join(workDir, '_thread'))
    execFileSync('mkfifo', [join(workDir, '_thread', 'status.txt')])
    execFileSync('mkfifo', [join(workDir, '_thread', 'spec.md')])
    expect(readThreadStatus(workDir, since)).toBeNull()
    expect(readThreadFile(workDir, 'spec.md')).toBeNull()
  })

  it('returns null for a symlink pointing outside workDir', () => {
    const outside = mkdtempSync(join(tmpdir(), 'petree-out-'))
    writeFileSync(join(outside, 's.txt'), 'topic: leak')
    mkdirSync(join(workDir, '_thread'))
    symlinkSync(join(outside, 's.txt'), join(workDir, '_thread', 'status.txt'))
    expect(readThreadStatus(workDir, since)).toBeNull()
  })
})

describe('symlink containment', () => {
  it('reads a symlinked thread file pointing outside workDir as null', () => {
    const outside = mkdtempSync(join(tmpdir(), 'petree-out-'))
    writeFileSync(join(outside, 'secret.md'), 'secret')
    mkdirSync(join(workDir, '_thread'))
    symlinkSync(join(outside, 'secret.md'), join(workDir, '_thread', 'spec.md'))
    expect(readThreadFile(workDir, 'spec.md')).toBeNull()
  })

  it('skips a symlinked suggestion dir pointing outside workDir', () => {
    const outside = mkdtempSync(join(tmpdir(), 'petree-out-'))
    writeFileSync(join(outside, 'x.md'), 'leak')
    mkdirSync(join(workDir, '_thread', 'notes'), { recursive: true })
    symlinkSync(outside, join(workDir, '_thread', 'notes', 'demo'))
    expect(listSuggestions(notesHome, workDir, repos)).toEqual([])
  })

  it('refuses to accept a note when the notes dir escapes notesHome', () => {
    const outside = mkdtempSync(join(tmpdir(), 'petree-out-'))
    symlinkSync(outside, join(notesHome, 'demo'))
    expect(() => acceptNote(notesHome, workDir, { repo: 'demo', topic: 'a', text: 't', summary: 's' }, repos)).toThrow(NoteInputError)
    expect(existsSync(join(outside, 'a.md'))).toBe(false)
  })

  it('refuses to drop a suggestion through a symlinked dir', () => {
    const outside = mkdtempSync(join(tmpdir(), 'petree-out-'))
    writeFileSync(join(outside, 'a.md'), 'keep')
    mkdirSync(join(workDir, '_thread', 'notes'), { recursive: true })
    symlinkSync(outside, join(workDir, '_thread', 'notes', 'demo'))
    expect(() => dropSuggestion(workDir, 'demo', 'a', repos)).toThrow(NoteInputError)
    expect(existsSync(join(outside, 'a.md'))).toBe(true)
  })
})

describe('listSuggestions', () => {
  it('lists slug .md files for listed repos and flags existing', () => {
    suggest('demo', 'run-locally.md', 'text')
    suggest('demo', 'Bad Name.md')
    suggest('demo', 'a_b.md')
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
    expect(() => acceptNote(notesHome, workDir, { ...note, topic: 'a_b' }, repos)).toThrow(NoteInputError)
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
    expect(() => dropSuggestion(workDir, 'demo', 'a_b', repos)).toThrow(NoteInputError)
  })
})
