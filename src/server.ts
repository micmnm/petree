import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { parseConfigText, resolveModel } from './config.js'
import type { PetreeConfig } from './config.js'
import { repoStatus, diffBranch, pushBranch, createPullRequest, taskBranch } from './gitops.js'
import type { Launcher } from './launcher.js'
import type { Scheduler } from './scheduler.js'
import { acceptNote, dropSuggestion, listSuggestions, NoteInputError, readThreadFile } from './notes.js'
import { pickImage } from './sandbox.js'
import { FOLLOWUP_STATES, RESUMABLE_STATES, STAGES, canMoveStage, threadTitle } from './store.js'
import type { Stage, TaskStore, TaskRecord } from './store.js'
import type { Response } from 'express'

export const MODELS = ['default', 'haiku', 'sonnet', 'opus']

// Shared by /push and /pr: a target must be a plain branch name, never the base
// branch, HEAD, or a refspec/ref-path trick that could redirect onto it.
function targetOrError(
  cfg: PetreeConfig,
  t: TaskRecord,
  repo: string | undefined,
  target: string | undefined,
  res: Response,
): string | null {
  if (!repo || !t.repos.includes(repo)) {
    res.status(400).json({ error: `unknown repo: ${repo}` })
    return null
  }
  const base = cfg.repos[repo]?.defaultBranch ?? 'main'
  const norm = String(target ?? '').trim().replace(/^refs\/heads\//, '')
  const valid = /^[\w.\-/]+$/.test(norm) && !norm.startsWith('refs/') && norm.toUpperCase() !== 'HEAD' && norm !== base
  if (!valid) {
    res.status(400).json({ error: 'invalid or protected target branch' })
    return null
  }
  return norm
}

export function makeApp(cfg: PetreeConfig, store: TaskStore, scheduler: Scheduler, launcher: Launcher): express.Express {
  const app = express()
  app.use(express.json())

  app.post('/api/tasks', (req, res) => {
    const { prompt, repos, model, stage } = (req.body ?? {}) as { prompt?: string; repos?: string[]; model?: string; stage?: Stage }
    if (typeof prompt !== 'string' || !prompt || !Array.isArray(repos) || repos.length === 0) {
      res.status(400).json({ error: 'prompt and repos[] are required' })
      return
    }
    if (stage !== undefined && !STAGES.includes(stage)) {
      res.status(400).json({ error: `unknown stage: ${stage}` })
      return
    }
    if (model !== undefined && !MODELS.includes(model)) {
      res.status(400).json({ error: `unknown model: ${model}` })
      return
    }
    for (const r of repos) {
      if (!Object.hasOwn(cfg.repos, r)) {
        res.status(400).json({ error: `unknown repo: ${r}` })
        return
      }
    }
    try {
      pickImage(repos, cfg)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
      return
    }
    const effectiveModel = resolveModel(model, cfg.repos[repos[0]].defaultModel, cfg.defaults.defaultModel)
    const task = store.create({
      prompt,
      repos,
      tokenBudget: cfg.defaults.tokenBudget,
      timeoutMinutes: cfg.defaults.timeoutMinutes,
      model: effectiveModel,
      stage,
    })
    void scheduler.tick()
    store.prune()
    res.status(201).json(task)
  })

  app.get('/api/tasks', (_req, res) => { res.json(store.list()) })

  app.get('/api/settings', (_req, res) => { res.json(store.getSettings()) })

  app.put('/api/settings', (req, res) => {
    const { maxAgeDays, maxPerRepoGroup } = (req.body ?? {}) as { maxAgeDays?: number; maxPerRepoGroup?: number }
    for (const [name, v] of [['maxAgeDays', maxAgeDays], ['maxPerRepoGroup', maxPerRepoGroup]] as const) {
      if (v !== undefined && (!Number.isInteger(v) || v < 1)) {
        res.status(400).json({ error: `${name} must be a positive integer` })
        return
      }
    }
    const settings = store.updateSettings({ maxAgeDays, maxPerRepoGroup })
    res.json({ ...settings, ...store.prune() })
  })

  app.post('/api/prune', (_req, res) => { res.json(store.prune()) })

  app.get('/api/repos', (_req, res) => {
    res.json(
      Object.entries(cfg.repos).map(([name, r]) => ({
        name,
        defaultBranch: r.defaultBranch,
        image: r.image,
        defaultModel: r.defaultModel,
        instructions: r.instructions,
        setup: r.setup,
        build: r.build,
        test: r.test,
        run: r.run,
        tags: r.tags,
      })),
    )
  })

  // Raw repos.yaml editor: cfg is a shared object reference held by the
  // launcher/scheduler/store closures too, so mutating its fields in place
  // (rather than replacing the reference) applies a save immediately without
  // a restart.
  app.get('/api/repos-yaml', (_req, res) => {
    const file = join(cfg.home, 'repos.yaml')
    res.json({ content: existsSync(file) ? readFileSync(file, 'utf8') : '' })
  })

  app.put('/api/repos-yaml', (req, res) => {
    const { content } = (req.body ?? {}) as { content?: string }
    if (typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'content is required' })
      return
    }
    let parsed: Omit<PetreeConfig, 'home'>
    try {
      parsed = parseConfigText(content)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
      return
    }
    writeFileSync(join(cfg.home, 'repos.yaml'), content)
    cfg.defaults = parsed.defaults
    cfg.repos = parsed.repos
    cfg.allowClone = parsed.allowClone
    res.json({ ok: true })
  })

  app.get('/api/tasks/:id', (req, res) => {
    const t = store.get(req.params.id)
    if (t) res.json(t)
    else res.sendStatus(404)
  })

  app.get('/api/tasks/:id/logs', (req, res) => {
    if (!/^[0-9a-f-]{8,36}$/.test(req.params.id)) {
      res.sendStatus(400)
      return
    }
    const file = join(cfg.home, 'logs', `${req.params.id}.log`)
    res.type('text/plain').send(existsSync(file) ? readFileSync(file, 'utf8') : '')
  })

  app.get('/api/tasks/:id/diff', (req, res) => {
    if (!/^[0-9a-f-]{8,36}$/.test(req.params.id)) { res.sendStatus(400); return }
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    const out = t.repos.map((repo) => {
      const repoDir = join(cfg.home, 'work', t.id, repo)
      const baseBranch = cfg.repos[repo]?.defaultBranch ?? 'main'
      const branch = taskBranch(t.id)
      const folder = repoDir
      const run = cfg.repos[repo]?.run ?? []
      if (!existsSync(repoDir)) {
        return { repo, branch, baseBranch, hasChanges: false, stat: '', patch: '', reviewCommand: '', folder, run }
      }
      const st = repoStatus(repoDir, baseBranch)
      const d = st.hasChanges ? diffBranch(repoDir, baseBranch) : { stat: '', patch: '' }
      const reviewCommand = `git -C <your-repo> fetch ${repoDir} ${branch} && git checkout ${branch}`
      return { repo, branch, baseBranch, hasChanges: st.hasChanges, stat: d.stat, patch: d.patch, reviewCommand, folder, run }
    })
    res.json(out)
  })

  app.post('/api/tasks/:id/push', (req, res) => {
    if (!/^[0-9a-f-]{8,36}$/.test(req.params.id)) { res.sendStatus(400); return }
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    const { repo, target } = (req.body ?? {}) as { repo?: string; target?: string }
    const norm = targetOrError(cfg, t, repo, target, res)
    if (!norm) return
    const repoDir = join(cfg.home, 'work', t.id, repo as string)
    if (!existsSync(repoDir)) { res.status(400).json({ error: 'no work dir for task' }); return }
    res.json(pushBranch(repoDir, t.id, norm))
  })

  app.post('/api/tasks/:id/pr', (req, res) => {
    if (!/^[0-9a-f-]{8,36}$/.test(req.params.id)) { res.sendStatus(400); return }
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    const { repo, target } = (req.body ?? {}) as { repo?: string; target?: string }
    const norm = targetOrError(cfg, t, repo, target, res)
    if (!norm) return
    const repoDir = join(cfg.home, 'work', t.id, repo as string)
    if (!existsSync(repoDir)) { res.status(400).json({ error: 'no work dir for task' }); return }
    const pushed = pushBranch(repoDir, t.id, norm)
    if (!pushed.ok) { res.json(pushed); return }
    const base = cfg.repos[repo as string]?.defaultBranch ?? 'main'
    const title = `petree ${t.id}: ${threadTitle(t)}`
    res.json(createPullRequest(repoDir, norm, base, title, t.turns[0]?.prompt ?? t.prompt))
  })

  app.post('/api/tasks/:id/resume', (req, res) => {
    const t = store.get(req.params.id)
    if (!t) {
      res.sendStatus(404)
      return
    }
    const { model } = (req.body ?? {}) as { model?: string }
    if (model !== undefined && !MODELS.includes(model)) {
      res.status(400).json({ error: `unknown model: ${model}` })
      return
    }
    // Only these states may re-run the same prompt in place. A done task must
    // go through /next so its finished turn gets archived, not silently
    // overwritten by /resume re-running the old prompt.
    if (!RESUMABLE_STATES.includes(t.state)) {
      res.status(409).json({ error: `cannot resume from state ${t.state}` })
      return
    }
    // Omitted model keeps the task's current one, same convention as /next;
    // resolving it when absent could override a previously-resolved value
    // with a different (e.g. since-changed) global default.
    const effectiveModel = model !== undefined
      ? resolveModel(model, cfg.repos[t.repos[0]]?.defaultModel ?? null, cfg.defaults.defaultModel)
      : undefined
    try {
      res.json(store.resume(t.id, effectiveModel))
      void scheduler.tick()
    } catch {
      res.status(409).json({ error: `cannot resume from state ${t.state}` })
    }
  })


  app.post('/api/tasks/:id/next', (req, res) => {
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    const { prompt = '', model, stage } = (req.body ?? {}) as { prompt?: string; model?: string; stage?: Stage }
    if (typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt must be a string' })
      return
    }
    if (model !== undefined && !MODELS.includes(model)) {
      res.status(400).json({ error: `unknown model: ${model}` })
      return
    }
    if (stage !== undefined && !STAGES.includes(stage)) {
      res.status(400).json({ error: `unknown stage: ${stage}` })
      return
    }
    if (!FOLLOWUP_STATES.includes(t.state)) {
      res.status(409).json({ error: `cannot follow up from state ${t.state}` })
      return
    }
    if (stage !== undefined && !canMoveStage(t.state, t.stage, stage)) {
      res.status(400).json({ error: `illegal stage move ${t.stage} -> ${stage} from state ${t.state}` })
      return
    }
    if (!prompt.trim() && !t.comments.some((c) => !c.consumed) && (stage === undefined || stage === t.stage)) {
      res.status(400).json({ error: 'prompt, a pending comment, or a stage change is required' })
      return
    }
    // Omitted model keeps the task's current one; a given model resolves the
    // same way task creation does ('default' -> config defaults). The repo may
    // have been removed from repos.yaml since the task was created.
    const effectiveModel = model !== undefined
      ? resolveModel(model, cfg.repos[t.repos[0]]?.defaultModel ?? null, cfg.defaults.defaultModel)
      : undefined
    res.json(store.followUp(t.id, prompt, effectiveModel, stage))
    void scheduler.tick()
  })

  app.post('/api/tasks/:id/comments', (req, res) => {
    if (!/^[0-9a-f-]{8,36}$/.test(req.params.id)) { res.sendStatus(400); return }
    if (!store.get(req.params.id)) { res.sendStatus(404); return }
    const { text } = (req.body ?? {}) as { text?: string }
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text is required' })
      return
    }
    res.status(201).json(store.addComment(req.params.id, text))
  })

  app.get('/api/tasks/:id/thread', (req, res) => {
    if (!/^[0-9a-f-]{8,36}$/.test(req.params.id)) { res.sendStatus(400); return }
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    const workDir = join(cfg.home, 'work', t.id)
    res.json({
      spec: readThreadFile(workDir, 'spec.md'),
      findings: readThreadFile(workDir, 'findings.md'),
      suggestions: listSuggestions(join(cfg.home, 'notes'), workDir, t.repos),
    })
  })

  const noteRoute = (act: (t: TaskRecord, body: Record<string, string>) => void): express.RequestHandler => (req, res) => {
    const id = String(req.params.id)
    if (!/^[0-9a-f-]{8,36}$/.test(id)) { res.sendStatus(400); return }
    const t = store.get(id)
    if (!t) { res.sendStatus(404); return }
    try {
      act(t, (req.body ?? {}) as Record<string, string>)
      res.json({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(err instanceof NoteInputError ? 400 : 500).json({ error: message })
    }
  }

  app.post('/api/tasks/:id/notes/accept', noteRoute((t, b) => {
    if (typeof b.text !== 'string' || typeof b.summary !== 'string') throw new NoteInputError('text and summary are required')
    acceptNote(join(cfg.home, 'notes'), join(cfg.home, 'work', t.id),
      { repo: b.repo, topic: b.topic, text: b.text, summary: b.summary }, t.repos)
  }))

  app.post('/api/tasks/:id/notes/drop', noteRoute((t, b) =>
    dropSuggestion(join(cfg.home, 'work', t.id), b.repo, b.topic, t.repos)))

  app.post('/api/tasks/:id/stop', async (req, res) => {
    const t = store.get(req.params.id)
    if (!t) {
      res.sendStatus(404)
      return
    }
    // Queued and not yet picked up by the scheduler: no process exists, so cancel
    // it directly rather than going through the launcher.
    if (t.state === 'queued') {
      try {
        res.json(store.transition(t.id, 'cancelled'))
      } catch {
        res.status(409).json({ error: `cannot stop from state ${t.state}` })
      }
      return
    }
    // Gate state: the container already exited, so dropping the thread is a plain transition.
    if (t.state === 'waiting-for-you') {
      res.json(store.transition(t.id, 'cancelled'))
      return
    }
    if (t.state !== 'provisioning' && t.state !== 'running') {
      res.status(409).json({ error: `cannot stop from state ${t.state}` })
      return
    }
    const stopped = await launcher.stop(t.id)
    if (!stopped) {
      res.status(409).json({ error: 'task has no active process to stop' })
      return
    }
    res.json(store.get(t.id))
  })

  app.get('/', (_req, res) => {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dashboard.html'), 'utf8')
    res.type('html').send(html)
  })

  // Browser modules the dashboard imports. Allowlisted by name — never a path
  // taken from the request.
  for (const name of ['markdown.js', 'activity.js']) {
    app.get(`/${name}`, (_req, res) => {
      const file = join(dirname(fileURLToPath(import.meta.url)), name)
      res.type('application/javascript').send(readFileSync(file, 'utf8'))
    })
  }

  return app
}
