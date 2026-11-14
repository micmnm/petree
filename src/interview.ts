import { join } from 'node:path'
import { LEVEL } from './inbox.js'
import { contained, readCapped } from './notes.js'
import type { Stage, TaskRecord } from './store.js'

// The interview questionnaire (spec §5.3–5.6): the agent's questions.json, the phase a stage is in,
// and the user's answers checked, recorded and rendered back into the follow-up prompt.

export type Kind = 'choice' | 'multi' | 'yesno' | 'number' | 'text'
export interface Option { id: string; label: string }

export interface Question {
  id: string
  kind: Kind
  q: string
  why: string
  options?: Option[]
  allowOther?: boolean
  unit?: string
  min?: number
  max?: number
  step?: number
  guess: string | string[] | boolean | number | null
}

export interface Questionnaire {
  round: number
  intro: string
  whyMore: string
  outlook: 'last' | 'more' | null
  questions: Question[]
  dropped: string[]
}

export type Answer = string | string[] | boolean | number | { other: string } | { picks: string[]; other: string }

export interface InterviewRecord {
  stage: Stage
  round: number
  questions: Question[]
  answers: Record<string, Answer | null> // null = "no answer — decide yourself" (WRITE IT NOW only)
  how: 'answered' | 'guesses'
  final: boolean
  changed: number
  whyMore: string
  outlook: 'last' | 'more' | null
}

export type InterviewPhase = { kind: 'off' } | { kind: 'ask'; round: number } | { kind: 'write' }

const KINDS: Kind[] = ['choice', 'multi', 'yesno', 'number', 'text']
const QID = /^[a-z0-9-]{1,32}$/
const OID = /^[a-z0-9-]{1,16}$/
const MAX_QUESTIONS = 8
const QUESTIONS_MAX = 32 * 1024

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

// The answer in canonical form, or undefined when it doesn't fit its question (spec §5.5).
export function normAnswer(q: Question, a: unknown): Answer | undefined {
  const ids = q.options?.map((o) => o.id) ?? []
  const isIds = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => ids.includes(x)) && new Set(v).size === v.length
  const o = obj(a)
  const other = q.allowOther && typeof o?.other === 'string' && o.other.trim() && o.other.length <= 500 ? o.other.trim() : null
  switch (q.kind) {
    case 'choice': return typeof a === 'string' && ids.includes(a) ? a : other ? { other } : undefined
    case 'multi': return isIds(a) ? [...a] : other && isIds(o?.picks) ? { picks: [...o.picks], other } : undefined
    case 'yesno': return typeof a === 'boolean' ? a : undefined
    case 'number': return typeof a === 'number' && Number.isFinite(a) && a >= (q.min ?? -Infinity) && a <= (q.max ?? Infinity) ? a : undefined
    case 'text': return typeof a === 'string' && a.length <= 2000 ? a : undefined
  }
}

function hint(q: Question): string {
  const ids = q.options?.map((o) => o.id).join(', ')
  const other = q.allowOther ? ', or { other }' : ''
  switch (q.kind) {
    case 'choice': return `pick one of ${ids}${other}`
    case 'multi': return `pick any of ${ids}${other ? ', or { picks, other }' : ''}`
    case 'yesno': return 'answer true or false'
    case 'number': return `a number${q.min !== undefined || q.max !== undefined ? ` from ${q.min ?? '-∞'} to ${q.max ?? '∞'}` : ''}`
    case 'text': return 'text up to 2000 characters'
  }
}

// One question after validation, or why it was dropped.
function parseQuestion(raw: unknown): Question | string {
  const r = obj(raw)
  if (!r) return 'not an object'
  if (typeof r.id !== 'string' || !QID.test(r.id)) return 'bad id'
  if (!KINDS.includes(r.kind as Kind)) return `unknown kind '${String(r.kind).slice(0, 20)}'`
  const q: Question = { id: r.id, kind: r.kind as Kind, q: str(r.q, 200), why: str(r.why, 160), guess: null }
  if (!q.q) return 'empty q'
  if (q.kind === 'choice' || q.kind === 'multi') {
    const raws = Array.isArray(r.options) ? r.options.map(obj) : []
    const options = raws.flatMap((o) => (o && typeof o.id === 'string' && OID.test(o.id) && str(o.label, 80) ? [{ id: o.id, label: str(o.label, 80) }] : []))
    if (options.length !== raws.length || options.length < 2 || options.length > 6 || new Set(options.map((o) => o.id)).size !== options.length) {
      return 'options missing or out of range'
    }
    q.options = options
    q.allowOther = r.allowOther === true
  }
  if (q.kind === 'number') {
    const [min, max, step] = [num(r.min), num(r.max), num(r.step)]
    if (min !== undefined && max !== undefined && min > max) return 'min > max'
    Object.assign(q, str(r.unit, 12) && { unit: str(r.unit, 12) }, min !== undefined && { min }, max !== undefined && { max },
      step !== undefined && step > 0 && { step })
  }
  // A bad guess keeps the question as NEEDS AN ANSWER; a guess is never an "other".
  q.guess = q.kind === 'text' ? str(r.guess, 500) || null : (normAnswer({ ...q, allowOther: false }, r.guess) as Question['guess']) ?? null
  return q
}

// The agent's file after salvage (spec §5.3), or why nothing in it is usable.
export function parseQuestions(raw: unknown, round: number): Questionnaire | string {
  const r = obj(raw)
  if (!r || !Array.isArray(r.questions)) return 'no "questions" list'
  const dropped: string[] = []
  if (r.round !== undefined && r.round !== round) dropped.push(`round says ${String(r.round).slice(0, 10)}, petree counts ${round}`)
  const questions: Question[] = []
  r.questions.forEach((x, i) => {
    const q = parseQuestion(x)
    const why = typeof q === 'string' ? q : questions.some((y) => y.id === q.id) ? 'duplicate id'
      : questions.length >= MAX_QUESTIONS ? `past ${MAX_QUESTIONS} questions` : null
    if (why) dropped.push(`q${i + 1}: ${why}`)
    else questions.push(q as Question)
  })
  if (!questions.length) return `no valid questions${dropped.length ? ` (${dropped.join('; ')})` : ''}`
  return {
    round,
    intro: str(r.intro, 200),
    whyMore: str(r.whyMore, 200) || (round > 1 ? 'no reason given' : ''),
    outlook: r.outlook === 'last' || r.outlook === 'more' ? r.outlook : null,
    questions,
    dropped,
  }
}

export interface ReadQuestions { asked: Questionnaire | null; error: string | null }
const NONE: ReadQuestions = { asked: null, error: null }

// Built like readThreadStatus: missing, escaping or written before `since` is no questionnaire, not an error.
export function readThreadQuestions(workDir: string, since: string | null, round: number): ReadQuestions {
  const p = join(workDir, '_thread', 'questions.json')
  if (!since || !contained(p, workDir)) return NONE
  const file = readCapped(p, QUESTIONS_MAX)
  if (!file || file.mtimeMs < Date.parse(since)) return NONE
  let raw: unknown
  try {
    raw = JSON.parse(file.text)
  } catch {
    return { asked: null, error: 'not JSON, or over 32 KiB' }
  }
  const parsed = parseQuestions(raw, round)
  return typeof parsed === 'string' ? { asked: null, error: parsed } : { asked: parsed, error: null }
}

// Spec §5.4. A visit is the trailing turns archived at the current stage; the turn that moved
// the thread here is archived under the previous stage, so a fresh visit always asks first.
export function interviewPhase(task: TaskRecord): InterviewPhase {
  if (!task.interview || task.stage === 'build') return { kind: 'off' }
  const last = task.turns.at(-1)
  if (!last || last.stage !== task.stage) return { kind: 'ask', round: 1 }
  if (last.interview && !last.interview.final) return { kind: 'ask', round: last.interview.round + 1 }
  return { kind: 'write' }
}

// A questionnaire is waiting (spec §5.2): a gate in phase `ask` with a fresh, valid questions.json.
export function waitingQuestions(task: TaskRecord, home: string): ReadQuestions {
  const phase = interviewPhase(task)
  if (task.state !== 'waiting-for-you' || phase.kind !== 'ask') return NONE
  return readThreadQuestions(join(home, 'work', task.id), task.startedAt, phase.round)
}

const sameAnswer = (a: Answer, guess: Question['guess']) =>
  Array.isArray(a) && Array.isArray(guess) ? [...a].sort().join('\n') === [...guess].sort().join('\n') : a === guess

// Checks the answers against the re-read questionnaire (spec §5.5 step 3); a string is the 400 message.
export function answerRecord(asked: Questionnaire, stage: Stage, answers: unknown, final: boolean): InterviewRecord | string {
  const guesses = answers === 'guesses'
  const given = guesses ? {} : obj(answers)
  if (!given) return "answers must be an object or 'guesses'"
  const unknown = Object.keys(given).find((id) => !asked.questions.some((q) => q.id === id))
  if (unknown) return `unknown question: ${unknown.slice(0, 40)}`
  const out: Record<string, Answer | null> = {}
  let changed = 0
  for (const [i, q] of asked.questions.entries()) {
    if (Object.hasOwn(given, q.id)) {
      const a = normAnswer(q, given[q.id])
      if (a === undefined) return `Q${i + 1}: ${hint(q)}`
      out[q.id] = a
      if (!sameAnswer(a, q.guess)) changed++
    } else if (q.guess !== null) out[q.id] = q.guess
    else if (final && !guesses) out[q.id] = null
    else return `Q${i + 1} has no guess: answer it first`
  }
  return {
    stage, round: asked.round, questions: asked.questions, answers: out, how: guesses ? 'guesses' : 'answered',
    final, changed, whyMore: asked.whyMore, outlook: asked.outlook,
  }
}

// The answer as a person reads it: option labels, yes/no, number + unit, or the text.
export function answerText(q: Question, a: Answer): string {
  const label = (id: string) => q.options?.find((o) => o.id === id)?.label ?? id
  const other = (s: string) => `other: "${s}"`
  if (typeof a === 'boolean') return a ? 'yes' : 'no'
  if (typeof a === 'number') return q.unit ? `${a} ${q.unit}` : String(a)
  if (Array.isArray(a)) return a.map(label).join(', ') || 'none'
  if (typeof a === 'string') return q.kind === 'text' ? a || '(empty)' : label(a)
  return 'picks' in a ? [...a.picks.map(label), other(a.other)].join(', ') : other(a.other)
}

const DOC: Record<Stage, string> = { investigate: 'findings', spec: 'spec', build: 'build' }

// The structured note the next turn starts with (spec §5.5).
export function renderAnswers(r: InterviewRecord, note: string): string {
  const lines = [
    `## Answers to your questions (${LEVEL[r.stage]}, round ${r.round})`,
    '',
    r.how === 'guesses' ? 'The user accepted all your guesses.'
      : 'The user answered in petree\'s form. "guess kept" means they left your guess as it was.',
    '',
  ]
  r.questions.forEach((q, i) => {
    const a = r.answers[q.id]
    const tag = a === null ? '' : sameAnswer(a, q.guess) ? ' — guess kept'
      : ` — changed (your guess: ${q.guess === null ? 'none' : answerText(q, q.guess)})`
    const text = a === null ? 'no answer — decide yourself' : answerText(q, a)
    lines.push(`${i + 1}. [${q.id}] ${q.q}`)
    if (text.includes('\n')) lines.push(`   Answer${tag}:`, ...text.split('\n').map((l) => `      ${l}`))
    else lines.push(`   Answer: ${text}${tag}`)
  })
  if (r.final) lines.push('', `The user pressed WRITE IT NOW: do not ask more questions. Write the ${DOC[r.stage]}.`)
  if (note.trim()) lines.push('', '## Note from the user', '', note.trim())
  return lines.join('\n')
}
