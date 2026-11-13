import { describe, it, expect } from 'vitest'
import { parseConfigText } from '../src/config.js'
import { NotEditable, addRepo, removeRepo, repoEditable, replaceRepo, setDefaults } from '../src/repos-yaml.js'

const TEXT = `# top comment
defaults:
  concurrency: 2 # keep low

repos:
  # about a
  a:
    url: x
    image: img
    run: [npm start]
  b:
    url: y # why y
    image: img

  # about c
  c:
    url: z
    image: img
`

describe('repos-yaml splice', () => {
  it('replaces one block and keeps everything else byte-for-byte', () => {
    const out = replaceRepo(TEXT, 'b', { url: 'new', image: 'img2', tags: ['t'] })
    expect(out).toBe(TEXT.replace('    url: y # why y\n    image: img\n', '    url: new\n    image: img2\n    tags:\n      - t\n'))
    expect(parseConfigText(out).repos.b.url).toBe('new')
  })

  it('adds after the last block and removes only the named one', () => {
    const added = addRepo(TEXT, 'd', { url: 'q', image: 'img' })
    expect(added).toBe(`${TEXT}  d:\n    url: q\n    image: img\n`)
    expect(Object.keys(parseConfigText(added).repos)).toEqual(['a', 'b', 'c', 'd'])

    const removed = removeRepo(TEXT, 'a')
    expect(removed).toBe(TEXT.replace('  a:\n    url: x\n    image: img\n    run: [npm start]\n', ''))
    expect(removed).toContain('  # about a\n')
  })

  it('creates repos: when missing and edits defaults in place', () => {
    expect(addRepo('', 'a', { url: 'x', image: 'i' })).toBe('repos:\n  a:\n    url: x\n    image: i\n')
    const out = setDefaults(TEXT, { token_budget: 5 })
    expect(out.startsWith('# top comment\ndefaults:\n  concurrency: 2\n  token_budget: 5\n\nrepos:')).toBe(true)
  })

  it('treats anchors, aliases and merge keys as not editable', () => {
    const anchored = 'x-base: &base\n  image: img\nrepos:\n  a: &a\n    url: x\n    image: img\n  b:\n    <<: *base\n    url: y\n'
    expect(repoEditable(anchored, 'a')).toBe(false)
    expect(repoEditable(anchored, 'b')).toBe(false)
    expect(repoEditable(TEXT, 'a')).toBe(true)
    expect(repoEditable(TEXT, 'nope')).toBeNull()
    expect(() => replaceRepo(anchored, 'b', { url: 'q' })).toThrow(NotEditable)
  })
})
