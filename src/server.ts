import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import {
  claudeMounts, listing, pluginAllowlist, sandboxReport, scanClaudeHome, settingsOf, settingsYaml, syncClaudeHome,
  validateSettings, writeMcpFile,
} from './claude-home.js'
import { parseConfigText, resolveModel, repoHostKind } from './config.js'
import type { PetreeConfig } from './config.js'
import { ensureGitConfig, localCheckout, repoStatus, diffBranch, pushBranch, taskBranch, headSha } from './gitops.js'
import { openPr, pollPrs } from './prs.js'
import type { Launcher } from './launcher.js'
import type { Scheduler } from './scheduler.js'
import { cardFor } from './inbox.js'
import { answerRecord, recap, renderAnswers, waitingQuestions } from './interview.js'
import { acceptNote, dropSuggestion, listSuggestions, NoteInputError, readThreadFile, readThreadStatus } from './notes.js'
import { pickImage } from './sandbox.js'
import { nowPlaying, questStats, readSlice, sliceStats } from './stats.js'
import { hud, repoUsage } from './usage.js'
import {
  DEFAULT_KEYS, REPO_KEYS, NotEditable, addRepo, hashText, pickFields, readRepoFields,
  removeRepo, repoEditable, replaceRepo, setDefaults,
} from './repos-yaml.js'
import { FOLLOWUP_STATES, RESUMABLE_STATES, STAGES, LMSTUDIO_PREFIX, canMoveStage } from './store.js'
import type { Stage, TaskStore, TaskRecord, Settings } from './store.js'
import type { Response } from 'express'

export const MODELS = ['default', 'haiku', 'sonnet', 'opus']

const LMSTUDIO_TIER_RE = /^lmstudio-(high|med|low)$/
// Conservative charset for a bare LM Studio model id, shared between the
// custom-pick request form and the Settings tier mappings — same defensive
// allowlist style as targetOrError's branch-name check below.
const LMSTUDIO_MODEL_ID_RE = /^[\w.\-/:]+$/
const LMSTUDIO_CUSTOM_RE = /^lmstudio-custom:([\w.\-/:]+)$/
const LMSTUDIO_TIER_FIELD = {
  high: 'lmStudioHighModel', med: 'lmStudioMedModel', low: 'lmStudioLowModel',
} as const

// Resolves a requested (always-defined) model string into the value to store
// on task.model. An LM Studio tier/custom request resolves against Settings
// instead of resolveModel()/repos.yaml; anything else falls through to the
// existing cloud-model allowlist + resolveModel(). Callers handle `model ===
// undefined` themselves — it means different things at each call site ("use
// configured defaults" on create, "don't change it" on resume/next/restore).
function resolveTaskModel(
  model: string,
  store: TaskStore,
  repoDefaultModel: string | null,
  globalDefaultModel: string | null,
): { model: string | null } | { error: string } {
  const tier = LMSTUDIO_TIER_RE.exec(model)
  if (tier) {
    const field = LMSTUDIO_TIER_FIELD[tier[1] as 'high' | 'med' | 'low']
    const id = store.getSettings()[field]
    if (!id) return { error: `no model mapped to lmstudio tier "${tier[1]}" — set it in Options first` }
    return { model: `${LMSTUDIO_PREFIX}${id}` }
  }
  const custom = LMSTUDIO_CUSTOM_RE.exec(model)
  if (custom) return { model: `${LMSTUDIO_PREFIX}${custom[1]}` }
  if (!MODELS.includes(model)) return { error: `unknown model: ${model}` }
  return { model: resolveModel(model, repoDefaultModel, globalDefaultModel) }
}

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
  // A live agent could rewrite .git between the host restoring its config and git reading it.
  if (t.state === 'running' || t.state === 'provisioning') {
    res.status(409).json({ error: `cannot ship while ${t.state}` })
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
    const { prompt, repos, model, stage, party, autoPlay, interview = true } = (req.body ?? {}) as
      { prompt?: string; repos?: string[]; model?: string; stage?: Stage; party?: boolean; autoPlay?: boolean; interview?: boolean }
    if ((party !== undefined && typeof party !== 'boolean') || (autoPlay !== undefined && typeof autoPlay !== 'boolean')
      || typeof interview !== 'boolean') {
      res.status(400).json({ error: 'party, autoPlay and interview must be booleans' })
      return
    }
    if (typeof prompt !== 'string' || !prompt || !Array.isArray(repos) || repos.length === 0) {
      res.status(400).json({ error: 'prompt and repos[] are required' })
      return
    }
    if (stage !== undefined && !STAGES.includes(stage)) {
      res.status(400).json({ error: `unknown stage: ${stage}` })
      return
    }
    const repoDefaultModel = cfg.repos[repos[0]]?.defaultModel ?? null
    const resolved = model !== undefined
      ? resolveTaskModel(model, store, repoDefaultModel, cfg.defaults.defaultModel)
      : { model: resolveModel(undefined, repoDefaultModel, cfg.defaults.defaultModel) }
    if ('error' in resolved) {
      res.status(400).json({ error: resolved.error })
      return
    }
    for (const r of repos) {
      if (!Object.hasOwn(cfg.repos, r)) {
        res.status(400).json({ error: `unknown repo: ${r}` })
        return
      }
    }
    const repoHosts = repos.map(r => repoHostKind(cfg.repos[r].url))
    const uniqueHosts = new Set(repoHosts.filter(h => h !== 'unknown'))
    if (uniqueHosts.size > 1) {
      res.status(400).json({ error: 'cannot mix GitHub and Azure repos in one thread' })
      return
    }
    try {
      pickImage(repos, cfg)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
      return
    }
    const effectiveModel = resolved.model
    const task = store.create({
      prompt,
      repos,
      tokenBudget: cfg.defaults.tokenBudget,
      timeoutMinutes: cfg.defaults.timeoutMinutes,
      model: effectiveModel,
      stage,
      party,
      autoPlay,
      interview,
    })
    void scheduler.tick()
    store.sweep()
    res.status(201).json(task)
  })

  const withCard = (t: TaskRecord) =>
    ({ ...t, card: cardFor(t, readThreadStatus(join(cfg.home, 'work', t.id), t.startedAt), cfg, undefined, waitingQuestions(t, cfg.home).asked) })

  app.get('/api/tasks', (req, res) => {
    res.json(store.list().filter((t) => req.query.archived === '1' || !t.archivedAt).map(withCard))
  })

  app.get('/api/settings', (_req, res) => { res.json(store.getSettings()) })

  app.put('/api/settings', (req, res) => {
    const {
      binDays, hallOfFameDays, lmStudioBaseUrl, lmStudioHighModel, lmStudioMedModel, lmStudioLowModel,
    } = (req.body ?? {}) as Partial<Settings>
    for (const [name, v] of [['binDays', binDays], ['hallOfFameDays', hallOfFameDays]] as const) {
      if (v !== undefined && (!Number.isInteger(v) || v < 1)) {
        res.status(400).json({ error: `${name} must be a positive integer` })
        return
      }
    }
    for (const [name, v] of [
      ['lmStudioBaseUrl', lmStudioBaseUrl], ['lmStudioHighModel', lmStudioHighModel],
      ['lmStudioMedModel', lmStudioMedModel], ['lmStudioLowModel', lmStudioLowModel],
    ] as const) {
      if (v !== undefined && v !== null && typeof v !== 'string') {
        res.status(400).json({ error: `${name} must be a string or null` })
        return
      }
    }
    for (const [name, v] of [
      ['lmStudioHighModel', lmStudioHighModel], ['lmStudioMedModel', lmStudioMedModel], ['lmStudioLowModel', lmStudioLowModel],
    ] as const) {
      if (v && !LMSTUDIO_MODEL_ID_RE.test(v)) {
        res.status(400).json({ error: `${name} contains invalid characters` })
        return
      }
    }
    if (lmStudioBaseUrl) {
      try {
        new URL(lmStudioBaseUrl)
      } catch {
        res.status(400).json({ error: 'lmStudioBaseUrl must be a valid URL' })
        return
      }
    }
    // An empty string from the dashboard's text inputs means "clear this field" —
    // normalize to null so it round-trips the same way as an explicit null.
    const norm = (v: string | null | undefined) => (v === '' ? null : v)
    const settings = store.updateSettings({
      binDays, hallOfFameDays,
      lmStudioBaseUrl: norm(lmStudioBaseUrl), lmStudioHighModel: norm(lmStudioHighModel),
      lmStudioMedModel: norm(lmStudioMedModel), lmStudioLowModel: norm(lmStudioLowModel),
    })
    res.json({ ...settings, archived: store.sweep() })
  })

  // Host-side proxy to LM Studio's own REST API — the sandbox container never
  // talks to LM Studio directly for anything except inference (see
  // sandbox.ts); listing models and health-checking happen from here, on the
  // host, where LM Studio's base URL (e.g. localhost:1234) is directly
  // reachable without any container networking.
  app.get('/api/lmstudio/models', async (req, res) => {
    // ?baseUrl lets GAME RULES' LOAD MODELS try a typed-but-unsaved URL;
    // only SAVE persists it.
    const { baseUrl } = req.query as { baseUrl?: string }
    const lmStudioBaseUrl = baseUrl ?? store.getSettings().lmStudioBaseUrl
    if (baseUrl !== undefined) {
      try {
        new URL(baseUrl)
      } catch {
        res.status(400).json({ error: 'baseUrl must be a valid URL' })
        return
      }
    }
    if (!lmStudioBaseUrl) {
      res.json({ reachable: false, models: [] })
      return
    }
    try {
      const r = await fetch(`${lmStudioBaseUrl}/api/v1/models`, { signal: AbortSignal.timeout(5000) })
      if (!r.ok) throw new Error(`status ${r.status}`)
      const body = (await r.json()) as { data?: Array<{ id: string }> }
      res.json({ reachable: true, models: body.data ?? [] })
    } catch {
      res.json({ reachable: false, models: [] })
    }
  })

  app.get('/api/lmstudio/health', async (_req, res) => {
    const { lmStudioBaseUrl } = store.getSettings()
    if (!lmStudioBaseUrl) {
      res.json({ reachable: false })
      return
    }
    try {
      const r = await fetch(`${lmStudioBaseUrl}/api/v1/models`, { signal: AbortSignal.timeout(5000) })
      res.json({ reachable: r.ok })
    } catch {
      res.json({ reachable: false })
    }
  })

  app.post('/api/prune', (_req, res) => { res.json({ archived: store.sweep() }) })

  // Archived rows count too: XP is lifetime.
  app.get('/api/hud', (_req, res) => { res.json(hud(store.list())) })

  app.get('/api/repos', async (_req, res) => {
    const usage = repoUsage(store.list(), cfg)
    res.json(
      await Promise.all(
        Object.entries(cfg.repos).map(async ([name, r]) => ({
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
          path: r.path ?? null,
          local: r.path ? await localCheckout(r.path) : null,
          usage: usage[name],
        })),
      ),
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

  // Structured repo editing: splice one block into repos.yaml (see repos-yaml.ts),
  // validate the whole result, then write atomically and apply to cfg in place.
  const reposFile = () => join(cfg.home, 'repos.yaml')
  const readReposText = () => (existsSync(reposFile()) ? readFileSync(reposFile(), 'utf8') : '')
  const REPO_NAME = /^[\w.-]+$/

  // Replies with the error and returns false unless the write may proceed.
  function applyEdit(res: Response, edit: () => string): boolean {
    let next: string
    try {
      next = edit()
    } catch (err) {
      res.status(err instanceof NotEditable ? 422 : 400).json({ error: err instanceof Error ? err.message : String(err) })
      return false
    }
    let parsed: Omit<PetreeConfig, 'home'>
    try {
      parsed = parseConfigText(next)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
      return false
    }
    const tmp = `${reposFile()}.tmp`
    writeFileSync(tmp, next)
    renameSync(tmp, reposFile())
    cfg.defaults = parsed.defaults
    cfg.repos = parsed.repos
    cfg.allowClone = parsed.allowClone
    return true
  }

  // A mismatch (or a missing hash where one is required) means the file moved on.
  function hashOk(res: Response, text: string, hash: unknown, required: boolean): boolean {
    if (hash === undefined && !required) return true
    if (hash === hashText(text)) return true
    res.status(409).json({ error: 'repos.yaml changed on disk — reload' })
    return false
  }

  app.get('/api/repos/:name', (req, res) => {
    const { name } = req.params
    if (!Object.hasOwn(cfg.repos, name)) { res.sendStatus(404); return }
    const text = readReposText()
    res.json({ name, fields: readRepoFields(text, name), editable: repoEditable(text, name) === true, hash: hashText(text) })
  })

  app.put('/api/repos/:name', (req, res) => {
    const { name } = req.params
    const { fields, hash } = (req.body ?? {}) as { fields?: Record<string, unknown>; hash?: unknown }
    if (!Object.hasOwn(cfg.repos, name)) { res.sendStatus(404); return }
    if (!fields || typeof fields !== 'object') { res.status(400).json({ error: 'fields is required' }); return }
    const text = readReposText()
    if (!hashOk(res, text, hash, true)) return
    if (applyEdit(res, () => replaceRepo(text, name, pickFields(fields, REPO_KEYS)))) res.json({ ok: true, hash: hashText(readReposText()) })
  })

  app.post('/api/repos', (req, res) => {
    const { name, fields, hash } = (req.body ?? {}) as { name?: string; fields?: Record<string, unknown>; hash?: unknown }
    if (typeof name !== 'string' || !REPO_NAME.test(name) || !fields || typeof fields !== 'object') {
      res.status(400).json({ error: 'name and fields are required' })
      return
    }
    if (Object.hasOwn(cfg.repos, name)) { res.status(409).json({ error: `repo ${name} already exists` }); return }
    const text = readReposText()
    if (!hashOk(res, text, hash, false)) return
    if (applyEdit(res, () => addRepo(text, name, pickFields(fields, REPO_KEYS)))) res.status(201).json({ ok: true, hash: hashText(readReposText()) })
  })

  app.delete('/api/repos/:name', (req, res) => {
    const { name } = req.params
    if (!Object.hasOwn(cfg.repos, name)) { res.sendStatus(404); return }
    const text = readReposText()
    if (!hashOk(res, text, req.query.hash, true)) return
    if (store.list().some((t) => t.repos.includes(name) && !t.bin && !t.archivedAt)) {
      res.status(409).json({ error: `repo ${name} is used by an active thread` })
      return
    }
    if (applyEdit(res, () => removeRepo(text, name))) res.json({ ok: true, hash: hashText(readReposText()) })
  })

  app.put('/api/defaults', (req, res) => {
    const { hash, claude_home, ...rest } = (req.body ?? {}) as Record<string, unknown>
    const patch = pickFields(rest, DEFAULT_KEYS)
    for (const [k, v] of Object.entries(patch)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        res.status(400).json({ error: `${k} must be a non-negative number` })
        return
      }
    }
    const scan = claude_home !== undefined ? scanClaudeHome(cfg) : null
    const ch = scan && validateSettings(claude_home, scan)
    if (typeof ch === 'string') { res.status(400).json({ error: ch }); return }
    if (ch) patch.claude_home = settingsYaml(ch)
    const text = readReposText()
    if (!hashOk(res, text, hash, false)) return
    // The MCP file first: if it can't be written, repos.yaml isn't either (spec §8).
    if (ch && scan) {
      try { writeMcpFile(cfg.home, scan, ch.mcp) } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
        return
      }
    }
    if (applyEdit(res, () => setDefaults(text, patch))) res.json({ ok: true, hash: hashText(readReposText()) })
  })

  // GAME RULES › FROM YOUR ~/.claude: names and flags only, never file bodies or secret values.
  app.get('/api/claude-home', (_req, res) => {
    const scan = scanClaudeHome(cfg)
    const s = settingsOf(cfg)
    res.json({ ...listing(scan), mcpError: scan.mcpError,
      chosen: { ...s, plugins: pluginAllowlist(s, scan), pluginsSaved: s.plugins !== null } })
  })

  app.post('/api/claude-home/sync', (req, res) => {
    try {
      res.json(syncClaudeHome(cfg, { dryRun: (req.body ?? {}).dryRun === true }))
    } catch (err) {
      res.status(err instanceof NotEditable ? 422 : 500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/tasks/:id', (req, res) => {
    const t = store.get(req.params.id)
    if (t) res.json(withCard(t))
    else res.sendStatus(404)
  })

  app.get('/api/tasks/:id/stats', (req, res) => {
    if (!/^[0-9a-f-]{8,36}$/.test(req.params.id)) { res.sendStatus(400); return }
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    // A run has no result event (duration_ms) until it ends, so its time so far is the wall clock.
    const text = t.state === 'running' ? readSlice(join(cfg.home, 'logs', `${t.id}.log`), t.logOffset) : null
    const live = text !== null
      ? sliceStats(text, t.repos.flatMap((r) => cfg.repos[r]?.test ?? []),
        t.startedAt ? Math.max(0, Date.now() - Date.parse(t.startedAt)) : 0)
      : null
    // windowUsd feeds the ≈ window share; null means the dashboard shows none (spec §5.9).
    // sandbox compares the run's init event with the current allowlists, not a launch snapshot.
    const sandbox = sandboxReport(text ?? readSlice(join(cfg.home, 'logs', `${t.id}.log`), t.logOffset), claudeMounts(cfg))
    res.json({ ...questStats(t, live), windowUsd: cfg.defaults.windowUsd ?? null, now: text !== null ? nowPlaying(text) : null, sandbox })
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
      ensureGitConfig(repoDir, cfg.repos[repo]?.url ?? '')
      const st = repoStatus(repoDir, baseBranch)
      const d = st.hasChanges ? diffBranch(repoDir, baseBranch) : { stat: '', patch: '' }
      const reviewCommand = `git -C <your-repo> fetch ${repoDir} ${branch} && git checkout ${branch}`
      return { repo, branch, baseBranch, hasChanges: st.hasChanges, stat: d.stat, patch: d.patch, reviewCommand, folder, run }
    })
    res.json(out)
  })

  app.post('/api/tasks/:id/push', async (req, res) => {
    if (!/^[0-9a-f-]{8,36}$/.test(req.params.id)) { res.sendStatus(400); return }
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    const { repo, target } = (req.body ?? {}) as { repo?: string; target?: string }
    const norm = targetOrError(cfg, t, repo, target, res)
    if (!norm) return
    const repoDir = join(cfg.home, 'work', t.id, repo as string)
    if (!existsSync(repoDir)) { res.status(400).json({ error: 'no work dir for task' }); return }
    ensureGitConfig(repoDir, cfg.repos[repo as string]?.url ?? '')
    const pushed = pushBranch(repoDir, t.id, norm, cfg.repos[repo as string]?.url ?? '')
    if (pushed.ok) {
      store.setDelivery(t.id, repo as string, { target: norm, prHead: headSha(repoDir) })
      await pollPrs(store, cfg, t.id)
    }
    res.json(pushed)
  })

  app.post('/api/tasks/:id/pr', async (req, res) => {
    if (!/^[0-9a-f-]{8,36}$/.test(req.params.id)) { res.sendStatus(400); return }
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    const { repo, target } = (req.body ?? {}) as { repo?: string; target?: string }
    const norm = targetOrError(cfg, t, repo, target, res)
    if (!norm) return
    const repoDir = join(cfg.home, 'work', t.id, repo as string)
    if (!existsSync(repoDir)) { res.status(400).json({ error: 'no work dir for task' }); return }
    const made = await openPr(store, cfg, t, repo as string, norm)
    void pollPrs(store, cfg, t.id)
    res.json(made)
  })

  app.post('/api/tasks/:id/resume', (req, res) => {
    const t = store.get(req.params.id)
    if (!t) {
      res.sendStatus(404)
      return
    }
    if (t.bin) { res.status(409).json({ error: 'restore first' }); return }
    const { model } = (req.body ?? {}) as { model?: string }
    const resumeResolved = model !== undefined
      ? resolveTaskModel(model, store, cfg.repos[t.repos[0]]?.defaultModel ?? null, cfg.defaults.defaultModel)
      : undefined
    if (resumeResolved && 'error' in resumeResolved) {
      res.status(400).json({ error: resumeResolved.error })
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
    const effectiveModel = resumeResolved?.model
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
    if (t.bin) { res.status(409).json({ error: 'restore first' }); return }
    const { prompt = '', model, stage, answers, comments, final } = (req.body ?? {}) as
      { prompt?: string; model?: string; stage?: Stage; answers?: unknown; comments?: unknown; final?: unknown }
    if (typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt must be a string' })
      return
    }
    const nextResolved = model !== undefined
      ? resolveTaskModel(model, store, cfg.repos[t.repos[0]]?.defaultModel ?? null, cfg.defaults.defaultModel)
      : undefined
    if (nextResolved && 'error' in nextResolved) {
      res.status(400).json({ error: nextResolved.error })
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
    // Omitted model keeps the task's current one; a given model resolves the
    // same way task creation does ('default' -> config defaults). The repo may
    // have been removed from repos.yaml since the task was created.
    const effectiveModel = nextResolved?.model
    // Answers to a questionnaire (spec §5.5): checked against the file re-read now, never the client's copy.
    if (answers !== undefined) {
      const { asked } = waitingQuestions(t, cfg.home)
      if (!asked) { res.status(409).json({ error: 'no questions waiting' }); return }
      if (stage !== undefined && stage !== t.stage) { res.status(400).json({ error: 'answers cannot move the stage' }); return }
      if (final !== undefined && typeof final !== 'boolean') { res.status(400).json({ error: 'final must be a boolean' }); return }
      const record = answerRecord(asked, t.stage, answers, final === true, comments)
      if (typeof record === 'string') { res.status(400).json({ error: record }); return }
      res.json(store.followUp(t.id, renderAnswers(record, prompt), effectiveModel, t.stage, record))
      void scheduler.tick()
      return
    }
    if (!prompt.trim() && !t.comments.some((c) => !c.consumed) && (stage === undefined || stage === t.stage)) {
      res.status(400).json({ error: 'prompt, a pending comment, or a stage change is required' })
      return
    }
    res.json(store.followUp(t.id, prompt, effectiveModel, stage))
    void scheduler.tick()
  })

  app.post('/api/tasks/:id/comments', (req, res) => {
    if (!/^[0-9a-f-]{8,36}$/.test(req.params.id)) { res.sendStatus(400); return }
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    if (t.bin) { res.status(409).json({ error: 'restore first' }); return }
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
    const waiting = waitingQuestions(t, cfg.home)
    res.json({
      spec: readThreadFile(workDir, 'spec.md'),
      findings: readThreadFile(workDir, 'findings.md'),
      suggestions: listSuggestions(join(cfg.home, 'notes'), workDir, t.repos),
      questions: waiting.asked,
      questionsError: waiting.error,
      interview: t.turns.flatMap((x) => x.interview ?? []).map(recap),
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

  // GAME OVER: settled threads are only binned; a live one is stopped first.
  app.post('/api/tasks/:id/drop', async (req, res) => {
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    if (t.bin) { res.status(409).json({ error: 'already binned' }); return }
    if (t.state === 'queued') {
      store.transition(t.id, 'cancelled')
    } else if (t.state === 'provisioning' || t.state === 'running') {
      if (!await launcher.stop(t.id)) { res.status(409).json({ error: 'task has no active process to stop' }); return }
    } else if (!['waiting-for-you', 'done', 'failed', 'cancelled'].includes(t.state)) {
      res.status(409).json({ error: `cannot drop from state ${t.state}` })
      return
    }
    res.json(store.bin(t.id, 'game-over', 'dropped by you'))
  })

  // QUEST COMPLETE: findings or answer were the point; counts as a victory.
  app.post('/api/tasks/:id/done', (req, res) => {
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    const noCommits = !Object.values(t.delivery).some((d) => d.ahead > 0)
    if (t.bin || !(t.state === 'waiting-for-you' || (t.state === 'done' && noCommits))) {
      res.status(409).json({ error: `cannot complete from state ${t.bin ? 'binned' : t.state}` })
      return
    }
    res.json(store.bin(t.id, 'hall-of-fame', 'finished · findings kept'))
  })

  // CONTINUE?
  app.post('/api/tasks/:id/restore', (req, res) => {
    const t = store.get(req.params.id)
    if (!t) { res.sendStatus(404); return }
    const { model } = (req.body ?? {}) as { model?: string }
    const resolved = model !== undefined
      ? resolveTaskModel(model, store, cfg.repos[t.repos[0]]?.defaultModel ?? null, cfg.defaults.defaultModel)
      : undefined
    if (resolved && 'error' in resolved) {
      res.status(400).json({ error: resolved.error })
      return
    }
    try {
      res.json(store.restore(t.id, resolved?.model))
      void scheduler.tick()
    } catch {
      res.status(409).json({ error: 'only a game-over thread that is not archived can be restored' })
    }
  })

  app.get('/', (_req, res) => {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dashboard.html'), 'utf8')
    // no-cache: browsers revalidate (ETag) on every load, so an upgrade never runs stale UI code.
    res.set('Cache-Control', 'no-cache').type('html').send(html)
  })

  // Browser modules the dashboard imports. Allowlisted by name — never a path
  // taken from the request.
  for (const name of ['markdown.js', 'activity.js']) {
    app.get(`/${name}`, (_req, res) => {
      const file = join(dirname(fileURLToPath(import.meta.url)), name)
      res.set('Cache-Control', 'no-cache').type('application/javascript').send(readFileSync(file, 'utf8'))
    })
  }

  return app
}
