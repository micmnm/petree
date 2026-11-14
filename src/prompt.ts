import type { PetreeConfig, RepoConfig } from './config.js'
import { interviewPhase } from './interview.js'
import type { Stage, TaskRecord } from './store.js'

// Builds the prompt handed to `claude -p`: stored prompt, stage instructions,
// repo notes, note-suggestion rules, then the registry's repo conventions
// (config.ts / repos.yaml). Composed at launch so repos.yaml edits apply to
// re-runs and resumes without rewriting stored tasks.

function hasConventions(repo: RepoConfig): boolean {
  return Boolean(repo.instructions) || repo.setup.length > 0 || repo.build.length > 0 || repo.test.length > 0
}

function commandBlock(title: string, note: string, commands: string[]): string[] {
  if (!commands.length) return []
  return ['', `**${title}** — ${note}`, ...commands.map((c) => `- \`${c}\``)]
}

function repoSection(name: string, repo: RepoConfig): string {
  const lines = [`### ${name} — checked out at \`/work/${name}\``]
  if (repo.instructions) lines.push('', repo.instructions)
  lines.push(...commandBlock('Setup', 'run these before changing anything', repo.setup))
  lines.push(...commandBlock('Build', 'must pass before you report success', repo.build))
  lines.push(...commandBlock('Tests', 'must pass before you report success', repo.test))
  return lines.join('\n')
}

const BUILD_BASE = [
  'Do what the prompt above asks. Only when it asks for nothing specific (e.g. an',
  'approve with no text), implement `/work/_thread/spec.md`, or `/work/_thread/findings.md`',
  'if there is no spec. Do not ask interactive questions: make a reasonable call and',
  'list open questions in your final message.',
]

// Dropped when PARTY MODE is off (the Task/Agent tools are disallowed too).
const BUILD_SUBAGENTS = [
  'For multi-part work, maximise parallelism. First break the work down with the',
  '`planning-and-task-breakdown` skill into tasks marked independent or dependent.',
  'Dispatch every independent task to its own subagent in parallel (one message with',
  'several Agent calls, typically one per repo or per independent slice), each told to',
  'follow the `incremental-implementation` and `test-driven-development` skills.',
  'Run dependent tasks after their prerequisites. You, the lead agent, integrate the',
  'results, then run every Build and Tests command and fix failures. Optionally finish',
  'with a `code-review-and-quality` pass by a subagent.',
]

export const STAGE_INSTRUCTIONS: Record<Stage, string> = {
  investigate: [
    'Explore the repos and the question above; do not modify any repo files.',
    'Do not ask interactive questions: list open questions instead.',
    'Write your findings to `/work/_thread/findings.md`, ending with the findings,',
    'the open questions, and a recommendation on whether this is worth a spec.',
  ].join('\n'),
  spec: [
    'Use the `spec-driven-development` skill to write a spec for the work above',
    '(`/work/_thread/findings.md` holds earlier findings, if any).',
    'Write the spec to `/work/_thread/spec.md`, not into a repo: it may span several.',
    'Do not wait for answers or ask interactive questions: list open questions at the',
    'end of the spec and in your final message.',
  ].join('\n'),
  build: [...BUILD_BASE, '', ...BUILD_SUBAGENTS].join('\n'),
}

// The §5.3 example; the agent copies its shape into /work/_thread/questions.json.
const QUESTIONS_SHAPE = `\`\`\`json
{
  "round": 1,
  "intro": "Before I write the retry spec, three things the code can't tell me.",
  "outlook": "last",
  "questions": [
    { "id": "scope", "kind": "choice", "q": "Which REST tasks should retry?",
      "why": "Retrying a POST can double-charge unless it has an idempotency key.",
      "options": [ { "id": "idem", "label": "Idempotent methods only (GET, PUT, DELETE)" },
                   { "id": "all", "label": "All methods, POST with an idempotency key" } ],
      "allowOther": true, "guess": "idem" },
    { "id": "attempts", "kind": "number", "q": "How many attempts at most?",
      "why": "Sets the worst-case latency of a failing task.", "unit": "attempts",
      "min": 1, "max": 10, "guess": 3 },
    { "id": "on-429", "kind": "yesno", "q": "Honour Retry-After on 429 and 503?",
      "why": "Some upstreams send hours; we may want a ceiling.", "guess": true }
  ]
}
\`\`\`
Kinds and their guess: "choice" (one option id), "multi" (an array of option ids), "yesno"
(true or false), "number" (within "min".."max"; "unit" and "step" optional), "text" (a string).
Ids use lowercase letters, digits and hyphens; choice and multi take 2 to 6 options.`

// The stage block, by interview phase (spec §5.4).
function stageSection(task: TaskRecord): string[] {
  const base = task.stage === 'build' && !task.party ? BUILD_BASE.join('\n') : STAGE_INSTRUCTIONS[task.stage]
  const phase = interviewPhase(task)
  if (phase.kind !== 'ask') {
    // In `write`, a last turn with a record is a WRITE IT NOW round.
    const decisions = phase.kind === 'write' && task.turns.at(-1)?.interview
      ? ['', "Record the user's answers from this thread under a `Decisions` heading in the document; do not ask more questions."]
      : []
    return [`## Stage: ${task.stage}`, '', base, ...decisions]
  }
  const inv = task.stage === 'investigate'
  const doc = inv ? 'findings' : 'spec'
  if (phase.round > 1) {
    return [
      `## Stage: ${task.stage} — your questions were answered (above)`,
      '',
      `Write the ${doc} now, following the instructions below, and record the answers under a`,
      `\`Decisions\` heading. Only if the answers raised questions that block the ${doc}, write a new`,
      `\`/work/_thread/questions.json\` instead (round ${phase.round}, 1 to 8 questions, same shape), with`,
      '"whyMore": one line on why you need another round, and "outlook" as before. Then stop.',
      'The user can end the questions at any time; ask only what you truly need.',
      '',
      base,
    ]
  }
  const afterScout = !inv && task.turns.some((t) => t.interview?.stage === 'investigate')
  return [
    `## Stage: ${task.stage} — interview first`,
    '',
    `Before you write the ${doc}, interview the user with a questionnaire.`,
    '',
    inv ? '1. Explore the repos and the question first; do not modify any repo files.'
      : '1. Explore first: read the repos, `/work/_thread/findings.md` if present, and this thread,\n'
        + '   so you only ask what the code and the thread cannot tell you. Do not modify repo files.',
    '2. If the `interview-me` skill is available, use it to decide what to ask',
    '   (`brainstorming` and `spec-driven-development` may help too). Its one-question-at-a-time',
    '   rule does not apply here: petree shows all your questions in one form and sends back all',
    '   the answers at once.',
    '3. Ask 1 to 8 questions (never more than 8) whose answers would change what you write.',
    '   Give each your best guess and one short line on why you ask. Prefer choice, multi,',
    '   yesno and number over text. Never ask what this thread already answered.',
    '4. Write them to `/work/_thread/questions.json`, exactly in this shape:',
    '',
    QUESTIONS_SHAPE,
    '',
    `   Set "round" to 1 and "outlook" to "last" if you expect to write the ${doc} after these`,
    '   answers, "more" if you expect another round.',
    `5. Then stop. Do not write \`/work/_thread/${doc}.md\` this turn. In status.txt set`,
    '   needs-you to "Answer <N> questions".',
    '',
    ...(afterScout ? [
      'The SCOUT answers above already settled the scope. Ask only what writing the plan newly',
      'raised; if nothing did, write the spec now.',
      '',
    ] : []),
    `If nothing is worth asking, do not write questions.json: write the ${doc} now, following`,
    'the normal instructions:',
    '',
    base,
  ]
}

function notesSections(repos: string[]): string[] {
  const read = repos.map(
    (r) => `- ${r}: read \`/petree/notes/${r}/INDEX.md\` if present, opening a note only when relevant; read \`/work/${r}/CLAUDE.md\` if present.`,
  )
  const write = repos.map((r) => `\`/work/_thread/notes/${r}/<topic>.md\``)
  return [
    '## Repo notes',
    '',
    ...read,
    '',
    '## Suggesting notes',
    '',
    'If you learned something non-obvious about a repo that code and tests do not show',
    '(how to run it, gotchas, why something is odd), write it as a short file at',
    `${write.join(' or ')} (lowercase-hyphen topic names). Never write anything else there.`,
  ]
}

const STATUS_SECTION = [
  '## Thread status (do this last, every turn)',
  '',
  'Overwrite `/work/_thread/status.txt` with exactly three lines:',
  'topic: <the thread\'s subject in at most 6 words>',
  'status: <one sentence: where the thread stands after this turn>',
  'needs-you: <one sentence: the decision or action you need from the user, or "nothing">',
]

// `setup` names what claudeMounts loaded (spec §5.4); empty → no section.
export function userSetupSection(setup: string[]): string[] {
  if (!setup.length) return []
  const what = setup.length > 1 ? `${setup.slice(0, -1).join(', ')} and ${setup.at(-1)}` : setup[0]
  return [
    '## The user\'s own setup',
    '',
    `The user's own ${what} are loaded, read-only. Where they conflict with this prompt's stage`,
    'instructions or the `/work/_thread/` file contracts (status.txt, questions.json, findings.md,',
    'spec.md), this prompt wins. You run unattended in a sandbox: instructions that assume an',
    'interactive user, the user\'s machine (local paths, local tools, MCP servers that aren\'t',
    'connected) or asking before acting don\'t apply; skip those steps and say so in your final',
    'message. Never copy instruction or skill text into repo files, documents, commits or PRs.',
    '',
  ]
}

export function composePrompt(task: TaskRecord, cfg: PetreeConfig, setup: string[] = []): string {
  const head = [
    ...(task.prompt ? [task.prompt, ''] : []),
    ...stageSection(task),
    '',
    ...notesSections(task.repos),
    '',
    ...userSetupSection(setup),
    ...STATUS_SECTION,
  ]
  const conventions = repoConventions(task, cfg)
  return [...head, ...(conventions ? ['', conventions] : [])].join('\n')
}

function repoConventions(task: TaskRecord, cfg: PetreeConfig): string {
  const sections: string[] = []
  let hasGates = false
  for (const name of task.repos) {
    const repo = cfg.repos[name]
    // Unknown repo names are rejected at task creation; a task can still outlive
    // its entry in repos.yaml, in which case there is nothing to append for it.
    if (!repo || !hasConventions(repo)) continue
    sections.push(repoSection(name, repo))
    if (repo.build.length || repo.test.length) hasGates = true
  }

  const global = cfg.defaults.instructions
  if (!sections.length && !global) return ''

  const out = [
    '---',
    '',
    '## Repo conventions',
    '',
    'These come from petree\'s repo registry (`~/.petree/repos.yaml`), not from the',
    'task author. They apply in addition to the task above. If a convention truly',
    'conflicts with the task, follow the task and say so in your final message.',
  ]
  if (global) out.push('', global)
  for (const section of sections) out.push('', section)
  if (hasGates) {
    out.push(
      '',
      'Before you finish, every Build and Tests command listed above must have been',
      'run in this session and passed. If one fails and you cannot fix it, state that',
      'plainly in your final message — do not report success.',
    )
  }
  return out.join('\n')
}
