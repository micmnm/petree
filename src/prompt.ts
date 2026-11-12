import type { PetreeConfig, RepoConfig } from './config.js'
import type { Stage, TaskRecord } from './store.js'

// Builds the prompt actually handed to `claude -p`: the task the user typed,
// followed by the standing conventions the registry declares for the repos it
// touches (see config.ts / repos.yaml). Composition happens at launch time
// rather than at task creation, so edits to repos.yaml apply to re-runs and
// resumes without rewriting stored tasks.

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
  build: [
    'Implement `/work/_thread/spec.md` if it exists; otherwise implement the task above',
    '(plus `/work/_thread/findings.md` if present). Do not ask interactive questions:',
    'make a reasonable call and list open questions in your final message.',
    '',
    'Maximise parallelism. First break the work down with the',
    '`planning-and-task-breakdown` skill into tasks marked independent or dependent.',
    'Dispatch every independent task to its own subagent in parallel (one message with',
    'several Agent calls, typically one per repo or per independent slice), each told to',
    'follow the `incremental-implementation` and `test-driven-development` skills.',
    'Run dependent tasks after their prerequisites. You, the lead agent, integrate the',
    'results, then run every Build and Tests command and fix failures. Optionally finish',
    'with a `code-review-and-quality` pass by a subagent.',
  ].join('\n'),
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

export function composePrompt(task: TaskRecord, cfg: PetreeConfig): string {
  const head = [
    ...(task.prompt ? [task.prompt, ''] : []),
    `## Stage: ${task.stage}`,
    '',
    STAGE_INSTRUCTIONS[task.stage],
    '',
    ...notesSections(task.repos),
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
