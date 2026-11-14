import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  answerRecord, interviewPhase, parseQuestions, readThreadQuestions, recap, renderAnswers,
  type InterviewRecord, type Questionnaire,
} from '../src/interview.js'

describe('recap', () => {
  it('tolerates a stored record without questions or answers', () => {
    const partial = { stage: 'spec', round: 1, final: false } as unknown as InterviewRecord
    expect(recap(partial)).toMatchObject({ questions: [], answers: {}, recap: [] })
  })
})
import type { Stage, TaskRecord, Turn } from '../src/store.js'

const FILE = {
  round: 1,
  intro: 'Before I write the retry spec, five things.',
  outlook: 'last',
  questions: [
    { id: 'scope', kind: 'choice', q: 'Which tasks retry?', why: 'POST may double-charge.',
      options: [{ id: 'idem', label: 'Idempotent only' }, { id: 'all', label: 'All methods' }], allowOther: true, guess: 'idem' },
    { id: 'codes', kind: 'multi', q: 'Which failures retry?',
      options: [{ id: '5xx', label: '5xx' }, { id: '429', label: '429' }, { id: 'reset', label: 'Connection reset' }], guess: ['5xx', '429'] },
    { id: 'on-429', kind: 'yesno', q: 'Honour Retry-After?', guess: true },
    { id: 'attempts', kind: 'number', q: 'How many attempts?', unit: 'attempts', min: 1, max: 10, step: 1, guess: 3 },
    { id: 'never', kind: 'text', q: 'Anything never to do?', guess: 'Never retry a streamed body.' },
  ],
}

const parsed = (raw: unknown, round = 1) => parseQuestions(raw, round) as Questionnaire
const withQs = (questions: unknown[], extra: object = {}) => ({ ...FILE, questions, ...extra })

describe('parseQuestions', () => {
  it('keeps every kind with its fields and guess', () => {
    const q = parsed(FILE)
    expect(q).toMatchObject({ round: 1, intro: FILE.intro, whyMore: '', outlook: 'last', dropped: [] })
    expect(q.questions).toEqual([
      { id: 'scope', kind: 'choice', q: 'Which tasks retry?', why: 'POST may double-charge.',
        options: FILE.questions[0].options, allowOther: true, guess: 'idem' },
      { id: 'codes', kind: 'multi', q: 'Which failures retry?', why: '', options: FILE.questions[1].options, allowOther: false, guess: ['5xx', '429'] },
      { id: 'on-429', kind: 'yesno', q: 'Honour Retry-After?', why: '', guess: true },
      { id: 'attempts', kind: 'number', q: 'How many attempts?', why: '', unit: 'attempts', min: 1, max: 10, step: 1, guess: 3 },
      { id: 'never', kind: 'text', q: 'Anything never to do?', why: '', guess: 'Never retry a streamed body.' },
    ])
  })

  it('drops questions that break their rules and lists why', () => {
    const two = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    const q = parsed(withQs([
      FILE.questions[2],
      { ...FILE.questions[2], id: 'Bad Id' },
      { ...FILE.questions[2] },
      { id: 'x', kind: 'scale', q: 'How much?' },
      { id: 'y', kind: 'yesno', q: '   ' },
      { id: 'c1', kind: 'choice', q: 'One?', options: [two[0]] },
      { id: 'c7', kind: 'choice', q: 'Seven?', options: 'abcdefg'.split('').map((id) => ({ id, label: id })) },
      { id: 'cd', kind: 'multi', q: 'Dup?', options: [two[0], two[0]] },
      { id: 'cb', kind: 'choice', q: 'Bad option?', options: [two[0], { id: 'B!', label: 'B' }] },
      { id: 'n', kind: 'number', q: 'Range?', min: 5, max: 1 },
      'just a string',
    ]))
    expect(q.questions.map((x) => x.id)).toEqual(['on-429'])
    expect(q.dropped).toEqual([
      'q2: bad id', 'q3: duplicate id', "q4: unknown kind 'scale'", 'q5: empty q',
      'q6: options missing or out of range', 'q7: options missing or out of range', 'q8: options missing or out of range',
      'q9: options missing or out of range', 'q10: min > max', 'q11: not an object',
    ])
  })

  it('keeps a question with a bad guess as NEEDS AN ANSWER (guess null)', () => {
    const [choice, multi, yesno, number, text] = FILE.questions
    const q = parsed(withQs([
      { ...choice, guess: 'nope' }, { ...multi, guess: ['5xx', 'nope'] }, { ...yesno, guess: 'yes' },
      { ...number, guess: 11 }, { ...text, guess: 42 }, { ...choice, id: 'other-guess', guess: { other: 'x' } }, { ...yesno, id: 'none', guess: undefined },
    ]))
    expect(q.questions.map((x) => x.guess)).toEqual([null, null, null, null, null, null, null])
    expect(q.dropped).toEqual([])
  })

  it('trims and clips strings, keeps the first 8 questions and lists the rest', () => {
    const long = (n: number) => 'x'.repeat(n)
    const q = parsed(withQs([
      { id: 'c', kind: 'choice', q: `  ${long(300)}  `, why: long(200), options: [{ id: 'a', label: long(100) }, { id: 'b', label: 'B' }], guess: 'a' },
      { id: 'n', kind: 'number', q: 'N?', unit: long(20), step: -1, guess: 1e9 },
      { id: 't', kind: 'text', q: 'T?', guess: long(600), extra: 'ignored' },
      ...Array.from({ length: 7 }, (_, i) => ({ id: `y${i}`, kind: 'yesno', q: 'Y?', guess: false })),
    ], { intro: long(300), whyMore: long(300) }))
    const [c, n, t] = q.questions
    expect([c.q.length, c.why.length, c.options![0].label.length, n.unit!.length, (t.guess as string).length]).toEqual([200, 160, 80, 12, 500])
    expect(n).not.toHaveProperty('step')
    expect(n.guess).toBe(1e9)
    expect(t).not.toHaveProperty('extra')
    expect([q.intro.length, q.whyMore.length]).toEqual([200, 200])
    expect(q.questions).toHaveLength(8)
    expect(q.dropped).toEqual(['q9: past 8 questions', 'q10: past 8 questions'])
  })

  it("uses petree's round, flags a mismatch, defaults whyMore and drops an unknown outlook", () => {
    const q = parsed(withQs([FILE.questions[2]], { round: 3, outlook: 'maybe' }), 2)
    expect(q).toMatchObject({ round: 2, whyMore: 'no reason given', outlook: null, dropped: ['round says 3, petree counts 2'] })
  })

  it('returns why nothing is usable', () => {
    expect(parseQuestions([], 1)).toBe('no "questions" list')
    expect(parseQuestions({ questions: [{ id: 'x', kind: 'scale', q: 'q' }] }, 1)).toBe("no valid questions (q1: unknown kind 'scale')")
  })
})

describe('readThreadQuestions', () => {
  const since = new Date(Date.now() - 60_000).toISOString()
  const setup = (text: string = JSON.stringify(FILE)) => {
    const workDir = mkdtempSync(join(tmpdir(), 'petree-q-'))
    mkdirSync(join(workDir, '_thread'))
    writeFileSync(join(workDir, '_thread', 'questions.json'), text)
    return workDir
  }

  it('reads a fresh file and ignores a missing, stale or turn-less one', () => {
    const workDir = setup()
    expect(readThreadQuestions(workDir, since, 1).asked?.questions).toHaveLength(5)
    expect(readThreadQuestions(workDir, null, 1)).toEqual({ asked: null, error: null })
    const old = new Date(Date.now() - 120_000)
    utimesSync(join(workDir, '_thread', 'questions.json'), old, old)
    expect(readThreadQuestions(workDir, since, 1)).toEqual({ asked: null, error: null })
    expect(readThreadQuestions(mkdtempSync(join(tmpdir(), 'petree-q-')), since, 1)).toEqual({ asked: null, error: null })
  })

  it('reports non-JSON, oversize and empty files as errors', () => {
    expect(readThreadQuestions(setup('{nope'), since, 1)).toEqual({ asked: null, error: 'not JSON, or over 32 KiB' })
    const big = JSON.stringify({ ...FILE, pad: 'x'.repeat(40 * 1024) })
    expect(readThreadQuestions(setup(big), since, 1).error).toBe('not JSON, or over 32 KiB')
    expect(readThreadQuestions(setup('{"questions": []}'), since, 1).error).toBe('no valid questions')
  })

  it('ignores a symlink pointing outside workDir', () => {
    const outside = mkdtempSync(join(tmpdir(), 'petree-out-'))
    writeFileSync(join(outside, 'q.json'), JSON.stringify(FILE))
    const workDir = mkdtempSync(join(tmpdir(), 'petree-q-'))
    mkdirSync(join(workDir, '_thread'))
    symlinkSync(join(outside, 'q.json'), join(workDir, '_thread', 'questions.json'))
    expect(readThreadQuestions(workDir, since, 1)).toEqual({ asked: null, error: null })
  })

  it.skipIf(process.platform === 'win32')('returns nothing for a FIFO instead of blocking', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'petree-q-'))
    mkdirSync(join(workDir, '_thread'))
    execFileSync('mkfifo', [join(workDir, '_thread', 'questions.json')])
    expect(readThreadQuestions(workDir, since, 1)).toEqual({ asked: null, error: null })
  })
})

const turn = (stage: Stage, interview?: Partial<InterviewRecord>): Turn =>
  ({ prompt: '', result: 'r', tokensUsed: 0, endedAt: '', stage, ...(interview && { interview: interview as InterviewRecord }) })
const task = (stage: Stage, turns: Turn[], interview = true) => ({ stage, turns, interview }) as TaskRecord

describe('interviewPhase', () => {
  it.each([
    ['off without INTERVIEW', task('spec', [], false), { kind: 'off' }],
    ['off at build', task('build', []), { kind: 'off' }],
    ['asks on the first turn', task('investigate', []), { kind: 'ask', round: 1 }],
    ['asks on a fresh visit after moving on', task('spec', [turn('investigate', { round: 1, final: false })]), { kind: 'ask', round: 1 }],
    ['asks again after an answered round', task('spec', [turn('investigate'), turn('spec', { round: 2, final: false })]), { kind: 'ask', round: 3 }],
    ['writes after WRITE IT NOW', task('spec', [turn('spec', { round: 1, final: true })]), { kind: 'write' }],
    ['writes on a retry after a document', task('spec', [turn('spec', { round: 1, final: false }), turn('spec')]), { kind: 'write' }],
    ['asks again after a back-move', task('spec', [turn('spec'), turn('build')]), { kind: 'ask', round: 1 }],
  ])('%s', (_name, t, phase) => {
    expect(interviewPhase(t)).toEqual(phase)
  })
})

describe('answerRecord', () => {
  const asked = parsed(FILE)
  const rec = (answers: unknown, final = false) => answerRecord(asked, 'spec', answers, final)

  it('checks each kind and fills missing answers with the guess', () => {
    const r = rec({ scope: { other: '  per task flag ' }, codes: ['reset'], 'on-429': false, attempts: 5 }) as InterviewRecord
    expect(r.answers).toEqual({
      scope: { other: 'per task flag' }, codes: ['reset'], 'on-429': false, attempts: 5, never: 'Never retry a streamed body.',
    })
    expect(r).toMatchObject({ stage: 'spec', round: 1, how: 'answered', final: false, changed: 4, outlook: 'last' })
    expect((rec({ codes: ['429', '5xx'], scope: 'idem', never: 'x\ny' }) as InterviewRecord).changed).toBe(1)
    const open = parsed(withQs([{ ...FILE.questions[1], allowOther: true }]))
    expect((answerRecord(open, 'spec', { codes: { picks: ['reset'], other: ' DNS ', x: 1 } }, false) as InterviewRecord).answers)
      .toEqual({ codes: { picks: ['reset'], other: 'DNS' } })
  })

  it('400s on an answer that does not fit its kind, or an unknown id', () => {
    expect(rec({ scope: 'nope' })).toBe('Q1: pick one of idem, all, or { other }')
    expect(rec({ codes: { picks: ['5xx'], other: 'x' } })).toBe('Q2: pick any of 5xx, 429, reset')
    expect(rec({ codes: ['5xx', '5xx'] })).toBe('Q2: pick any of 5xx, 429, reset')
    expect(rec({ 'on-429': 'yes' })).toBe('Q3: answer true or false')
    expect(rec({ attempts: 11 })).toBe('Q4: a number from 1 to 10')
    expect(rec({ never: 'x'.repeat(2001) })).toBe('Q5: text up to 2000 characters')
    expect(rec({ bogus: 1 })).toBe('unknown question: bogus')
    expect(rec(['idem'])).toBe("answers must be an object or 'guesses'")
  })

  it("'guesses' takes every guess, and 400s when one is missing", () => {
    expect(rec('guesses')).toMatchObject({ how: 'guesses', changed: 0, answers: { scope: 'idem', attempts: 3 } })
    const noGuess = parsed(withQs([{ ...FILE.questions[2], guess: null }]))
    expect(answerRecord(noGuess, 'spec', 'guesses', false)).toBe('Q1 has no guess: answer it first')
    expect(answerRecord(noGuess, 'spec', 'guesses', true)).toBe('Q1 has no guess: answer it first')
  })

  it('records an empty no-guess question as null only with final', () => {
    const noGuess = parsed(withQs([{ ...FILE.questions[2], guess: null }]))
    expect(answerRecord(noGuess, 'spec', {}, false)).toBe('Q1 has no guess: answer it first')
    expect(answerRecord(noGuess, 'spec', {}, true)).toMatchObject({ answers: { 'on-429': null }, final: true, changed: 0 })
  })
})

describe('renderAnswers', () => {
  it('renders the structured note', () => {
    const asked = parsed(withQs([...FILE.questions, { id: 'owner', kind: 'yesno', q: 'Own the retry budget?', guess: null }], { round: 2 }), 2)
    const r = answerRecord(asked, 'spec', { attempts: 5, scope: { other: 'full jitter' }, never: 'No retries on POST.\nNot even once.' }, true) as InterviewRecord
    expect(renderAnswers(r, '  Also cap total retry time at 2 minutes. ')).toBe(`## Answers to your questions (PLAN, round 2)

The user answered in petree's form. "guess kept" means they left your guess as it was.

1. [scope] Which tasks retry?
   Answer: other: "full jitter" — changed (your guess: Idempotent only)
2. [codes] Which failures retry?
   Answer: 5xx, 429 — guess kept
3. [on-429] Honour Retry-After?
   Answer: yes — guess kept
4. [attempts] How many attempts?
   Answer: 5 attempts — changed (your guess: 3 attempts)
5. [never] Anything never to do?
   Answer — changed (your guess: Never retry a streamed body.):
      No retries on POST.
      Not even once.
6. [owner] Own the retry budget?
   Answer: no answer — decide yourself

The user pressed WRITE IT NOW: do not ask more questions. Write the spec.

## Note from the user

Also cap total retry time at 2 minutes.`)
  })

  it("uses the accepted-guesses header and leaves out the final line and an empty note", () => {
    const r = answerRecord(parsed(withQs([FILE.questions[2]])), 'investigate', 'guesses', false) as InterviewRecord
    expect(renderAnswers(r, ' ')).toBe(`## Answers to your questions (SCOUT, round 1)

The user accepted all your guesses.

1. [on-429] Honour Retry-After?
   Answer: yes — guess kept`)
  })
})
