// Turns a raw stream-json task log into a readable activity view: a progress
// header (how far along, what was touched, what broke), the agent's current
// todo list, and a timeline of turns and tool calls — instead of a wall of JSON.
//
// Every value here is container-sourced, so this module escapes ALL input before
// building markup, exactly like markdown.js. Callers get finished HTML.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// Timeline render cap. Long runs stay responsive; the header always reports how
// many events were dropped, so a truncated view never reads as the whole run.
export const MAX_ENTRIES = 400

const TOOL_ICONS = {
  Bash: '❯', Read: '▤', Edit: '✎', MultiEdit: '✎', Write: '✎', NotebookEdit: '✎',
  Glob: '🔍', Grep: '🔍', Task: '🤖', Agent: '🤖', TodoWrite: '☑',
  WebFetch: '🌐', WebSearch: '🌐',
}
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

function clip(s, n = 160) {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

// Paths in tool inputs are absolute container paths; the tail is what identifies
// the file to a human reading the timeline.
function shortPath(p) {
  const parts = String(p ?? '').split('/').filter(Boolean)
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : parts.join('/')
}

function flattenContent(c) {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c
    .map((b) => (typeof b === 'string' ? b : b && typeof b === 'object' ? (b.text ?? (b.type === 'image' ? '[image]' : '')) : ''))
    .filter(Boolean)
    .join('\n')
}

// One-line "what did this call actually do", per tool. Falls back to whichever
// well-known input field is present so unknown/MCP tools still read sensibly.
function toolLine(name, input) {
  const i = input && typeof input === 'object' ? input : {}
  switch (name) {
    case 'Bash': return clip(i.command || i.description)
    case 'Read': return shortPath(i.file_path || i.notebook_path)
    case 'Edit': case 'MultiEdit': case 'Write': return shortPath(i.file_path)
    case 'NotebookEdit': return shortPath(i.notebook_path || i.file_path)
    case 'Glob': case 'Grep': return clip(i.pattern) + (i.path ? ' in ' + shortPath(i.path) : '')
    case 'Task': case 'Agent': return clip(i.description || i.prompt)
    case 'WebFetch': return clip(i.url)
    case 'WebSearch': return clip(i.query)
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? i.todos : []
      const done = todos.filter((t) => t && t.status === 'completed').length
      return todos.length ? `${done}/${todos.length} steps done` : ''
    }
    default:
      return clip(i.description || i.file_path || i.path || i.pattern || i.query || i.url || i.command ||
        (Object.keys(i).length ? JSON.stringify(i) : ''))
  }
}

function pushFile(stats, p) {
  const f = shortPath(p)
  if (f && !stats.files.includes(f)) stats.files.push(f)
}

/**
 * Parse a raw log (stream-json lines plus any stderr noise) into a timeline and
 * run statistics. Unparseable lines are kept as `raw` entries — petree's log is
 * the container's whole stdout/stderr, not only Claude's protocol.
 */
export function summarizeLog(text) {
  const stats = {
    turns: 0, toolCalls: 0, toolCounts: {}, files: [], commands: 0,
    tokens: 0, errors: 0, sessionId: null, model: null,
    durationMs: null, costUsd: null, numTurns: null,
    finished: null, todos: [], lines: 0, noise: 0,
  }
  const entries = []
  const byToolId = new Map() // tool_use id -> its timeline entry, so results attach to the call
  const seenBlocks = new Map() // assistant message id -> blocks already rendered
  const countedUsage = new Set()

  const add = (e) => { entries.push(e); return e }

  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    stats.lines++
    let msg
    try { msg = JSON.parse(line) } catch { msg = null }
    if (msg === null || typeof msg !== 'object') {
      stats.noise++
      add({ kind: 'raw', icon: '·', name: '', summary: clip(line, 200), detail: line })
      continue
    }

    if (msg.type === 'system' && msg.subtype === 'init') {
      stats.sessionId = msg.session_id ?? stats.sessionId
      stats.model = msg.model ?? stats.model
      const tools = Array.isArray(msg.tools) ? msg.tools.length : null
      add({
        kind: 'init', icon: '◆', name: 'session started',
        summary: [msg.model, tools !== null ? `${tools} tools` : '', msg.permissionMode].filter(Boolean).join(' · '),
        detail: msg.cwd ? `cwd ${msg.cwd}` : '',
      })
      continue
    }

    if (msg.type === 'assistant' && msg.message) {
      const id = msg.message.id ?? null
      const sub = msg.parent_tool_use_id ? 'subagent' : ''
      if (id === null || !seenBlocks.has(id)) { stats.turns++; if (id !== null) seenBlocks.set(id, 0) }
      const u = msg.message.usage
      // Same accounting as the runner: non-cached input+output, once per message id.
      if (u && (id === null || !countedUsage.has(id))) {
        if (id !== null) countedUsage.add(id)
        stats.tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
      }
      // stream-json repeats a message once per content block; render only blocks
      // we haven't seen for this id yet.
      const blocks = Array.isArray(msg.message.content) ? msg.message.content
        : typeof msg.message.content === 'string' ? [{ type: 'text', text: msg.message.content }] : []
      const from = id === null ? 0 : seenBlocks.get(id) ?? 0
      if (id !== null) seenBlocks.set(id, Math.max(from, blocks.length))
      for (const b of blocks.slice(from)) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && String(b.text ?? '').trim()) {
          add({ kind: 'text', icon: '💬', name: sub ? 'subagent' : '', summary: clip(b.text, 200), detail: b.text })
        } else if (b.type === 'thinking' && String(b.thinking ?? '').trim()) {
          add({ kind: 'thinking', icon: '✳', name: 'thinking', summary: clip(b.thinking, 200), detail: b.thinking })
        } else if (b.type === 'tool_use') {
          const name = String(b.name ?? 'tool')
          stats.toolCalls++
          stats.toolCounts[name] = (stats.toolCounts[name] ?? 0) + 1
          if (name === 'Bash') stats.commands++
          if (WRITE_TOOLS.has(name)) pushFile(stats, b.input?.file_path || b.input?.notebook_path)
          if (name === 'TodoWrite' && Array.isArray(b.input?.todos)) stats.todos = b.input.todos
          const entry = add({
            kind: 'tool', icon: TOOL_ICONS[name] ?? '⚙', name, tag: sub,
            summary: toolLine(name, b.input), detail: JSON.stringify(b.input ?? {}, null, 2),
          })
          if (b.id) byToolId.set(b.id, entry)
        }
      }
      continue
    }

    if (msg.type === 'user' && msg.message) {
      const blocks = Array.isArray(msg.message.content) ? msg.message.content : []
      for (const b of blocks) {
        if (!b || b.type !== 'tool_result') continue
        const out = flattenContent(b.content)
        if (b.is_error) stats.errors++
        const call = b.tool_use_id ? byToolId.get(b.tool_use_id) : null
        if (call) { call.ok = !b.is_error; call.output = out }
        else {
          add({
            kind: 'tool', icon: b.is_error ? '✕' : '↩', name: 'tool result',
            summary: clip(out, 160), ok: !b.is_error, output: out, detail: '',
          })
        }
      }
      continue
    }

    if (msg.type === 'result') {
      const ok = !msg.is_error
      const body = String(msg.result ?? msg.subtype ?? '')
      if (!ok) stats.errors++
      stats.durationMs = typeof msg.duration_ms === 'number' ? msg.duration_ms : stats.durationMs
      stats.costUsd = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : stats.costUsd
      stats.numTurns = typeof msg.num_turns === 'number' ? msg.num_turns : stats.numTurns
      stats.finished = { ok, text: body }
      add({
        kind: ok ? 'result' : 'error', icon: ok ? '✔' : '✕',
        name: ok ? 'result' : 'failed', summary: clip(body, 200), detail: body, ok,
      })
      continue
    }
    // stream_event partials and other protocol chatter carry no standalone
    // meaning here — the assembled assistant/user/result messages above cover it.
  }

  const hidden = Math.max(0, entries.length - MAX_ENTRIES)
  return { stats, entries: hidden ? entries.slice(-MAX_ENTRIES) : entries, hidden, total: entries.length }
}

// --- rendering -----------------------------------------------------------

function fmtInt(n) { return Number(n).toLocaleString('en-US') }

function fmtDuration(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function tile(label, value, tone = '') {
  return `<div class="tile"><div class="tile-l">${escapeHtml(label)}</div><div class="tile-v ${tone}">${escapeHtml(value)}</div></div>`
}

// Budget meter: fill severity escalates with consumption, the track is a lighter
// step of the same ramp, and the percentage is spelled out so color never carries
// the state alone.
function meter(used, budget) {
  if (!budget || budget <= 0) return ''
  const pct = Math.min(100, Math.round((used / budget) * 100))
  const level = pct >= 90 ? 'critical' : pct >= 70 ? 'warn' : 'ok'
  const note = pct >= 90 ? ' — near budget' : pct >= 70 ? ' — over 70%' : ''
  return `<div class="meter-wrap">
    <div class="meter-top"><span>token budget</span><span class="mono">${escapeHtml(fmtInt(used))} / ${escapeHtml(fmtInt(budget))} · ${pct}%${escapeHtml(note)}</span></div>
    <div class="meter" role="img" aria-label="${pct}% of token budget used"><div class="meter-fill ${level}" style="width:${pct}%"></div></div>
  </div>`
}

const TODO_MARK = { completed: ['✔', 'done'], in_progress: ['▸', 'doing'], pending: ['○', 'todo'] }

function renderTodos(todos) {
  if (!Array.isArray(todos) || !todos.length) return ''
  const done = todos.filter((t) => t && t.status === 'completed').length
  const items = todos.map((t) => {
    const status = t && typeof t.status === 'string' ? t.status : 'pending'
    const [mark, word] = TODO_MARK[status] ?? TODO_MARK.pending
    const label = status === 'in_progress' && t.activeForm ? t.activeForm : t?.content ?? ''
    return `<li class="todo ${escapeHtml(status)}"><span class="todo-m" aria-hidden="true">${mark}</span><span class="todo-w">${escapeHtml(word)}</span> ${escapeHtml(label)}</li>`
  }).join('')
  return `<div class="plan"><div class="plan-h">plan <span class="muted">${done}/${todos.length} done</span></div><ul class="todos">${items}</ul></div>`
}

function detailsBlock(label, body, extraClass = '') {
  if (!String(body ?? '').trim()) return ''
  return `<details class="ev-more ${extraClass}"><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(body)}</pre></details>`
}

function renderEntry(e, k) {
  const parts = []
  parts.push(`<span class="ev-ico" aria-hidden="true">${escapeHtml(e.icon)}</span>`)
  const head = []
  if (e.name) head.push(`<span class="ev-name">${escapeHtml(e.name)}</span>`)
  if (e.summary) head.push(`<span class="ev-sum">${escapeHtml(e.summary)}</span>`)
  if (e.tag) head.push(`<span class="ev-tag">${escapeHtml(e.tag)}</span>`)
  if (e.ok === false) head.push('<span class="ev-tag bad">✕ error</span>')
  else if (e.ok === true && e.kind === 'tool') head.push('<span class="ev-tag good">✔ ok</span>')
  // TodoWrite's list is not expanded inline — the header already shows the
  // current plan, and repeating it per call buries the rest of the timeline.
  const body = [`<div class="ev-head">${head.join(' ')}</div>`]
  // Long prose is clipped in the head; the full text stays one click away.
  if (e.kind === 'text' || e.kind === 'thinking' || e.kind === 'result' || e.kind === 'error') {
    if (String(e.detail ?? '').length > String(e.summary ?? '').length) body.push(detailsBlock('full text', e.detail))
  } else if (e.kind === 'tool') {
    body.push(detailsBlock('input', e.detail))
    body.push(detailsBlock('output', e.output))
  } else if (e.kind === 'raw' && String(e.detail ?? '').length > String(e.summary ?? '').length) {
    body.push(detailsBlock('line', e.detail))
  }
  parts.push(`<div class="ev-main">${body.join('')}</div>`)
  return `<li class="ev ev-${escapeHtml(e.kind)}" data-k="${k}">${parts.join('')}</li>`
}

/**
 * Render the Log tab's activity view.
 * `task` (optional) supplies state/token figures the log alone can't be trusted
 * for — the store is authoritative for tokens used and budget.
 */
export function renderActivity(text, task = {}) {
  const { stats, entries, hidden, total } = summarizeLog(text)
  if (!total) return '<p class="muted">No log output yet.</p>'

  // A log that already carries a result is over, whatever the store still says
  // (the task row is only marked terminal after the container exits).
  const running = !stats.finished && ['queued', 'provisioning', 'running'].includes(task.state)
  const last = entries[entries.length - 1]
  const nowLabel = stats.finished
    ? (stats.finished.ok ? 'finished' : 'failed')
    : running ? 'now' : 'last activity'
  const nowText = stats.finished
    ? stats.finished.text || (stats.finished.ok ? 'done' : 'failed')
    : last ? [last.name, last.summary].filter(Boolean).join(' · ') : '—'

  const topTools = Object.entries(stats.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 6)
  const used = typeof task.tokensUsed === 'number' ? task.tokensUsed : stats.tokens

  const tiles = [
    tile('turns', fmtInt(stats.numTurns ?? stats.turns)),
    tile('tool calls', fmtInt(stats.toolCalls)),
    tile('files touched', fmtInt(stats.files.length)),
    tile('commands', fmtInt(stats.commands)),
    tile('errors', fmtInt(stats.errors), stats.errors ? 'bad' : ''),
    stats.durationMs !== null ? tile('duration', fmtDuration(stats.durationMs)) : '',
    stats.costUsd !== null ? tile('cost', '$' + stats.costUsd.toFixed(2)) : '',
  ].join('')

  const chips = topTools.length
    ? `<div class="chips">${topTools.map(([n, c]) => `<span class="chip">${escapeHtml(n)} <b>${c}</b></span>`).join('')}</div>`
    : ''
  const filesLine = stats.files.length
    ? `<div class="files"><span class="muted">files</span> ${stats.files.slice(0, 12).map((f) => `<span class="chip mono">${escapeHtml(f)}</span>`).join('')}${stats.files.length > 12 ? `<span class="muted"> +${stats.files.length - 12} more</span>` : ''}</div>`
    : ''

  const note = hidden
    ? `<p class="muted small">showing the last ${fmtInt(entries.length)} of ${fmtInt(total)} events — use Raw for the full log</p>`
    : ''

  return `<div class="act">
    <div class="now ${running ? 'live' : ''} ${stats.finished && !stats.finished.ok ? 'bad' : ''}">
      <span class="now-l">${escapeHtml(nowLabel)}</span>
      <span class="now-t">${escapeHtml(clip(nowText, 180))}</span>
    </div>
    <div class="tiles">${tiles}</div>
    ${meter(used, task.tokenBudget)}
    ${chips}${filesLine}
    ${renderTodos(stats.todos)}
    ${note}
    <ol class="timeline">${entries.map((e, i) => renderEntry(e, i)).join('')}</ol>
  </div>`
}
