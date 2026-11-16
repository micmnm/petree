// Pure, DOM-free OPTIONS page logic: route (de)serialization, draft-dirty
// bookkeeping, and the global search index/ranking. Sibling to markdown.js
// and activity.js — named exports, plain data in and out, no browser globals.
//
// Routes: #/options[/repos | /repo/<name> | /recruit | /rules
//           | /claude[/skills|/plugins|/mcp] | /raw]
const TABS = ['repos', 'rules', 'claude', 'raw']
const CLAUDE_SUBS = ['skills', 'plugins', 'mcp']

export function parseOptionsHash(hash) {
  const m = /^#\/options(?:\/(.*))?$/.exec(String(hash ?? ''))
  if (!m) return null
  const [head = '', rest = ''] = (m[1] ?? '').split('/')
  if (head === 'repo') return rest ? { tab: 'repos', repo: decodeURIComponent(rest) } : { tab: 'repos' }
  if (head === 'recruit') return { tab: 'repos', recruit: true }
  if (head === 'claude') return { tab: 'claude', sub: CLAUDE_SUBS.includes(rest) ? rest : 'skills' }
  return { tab: TABS.includes(head) ? head : 'repos' }
}

// Inverse of parseOptionsHash. Bare `#/options` has no canonical inverse —
// it normalizes to `#/options/repos`, so round-tripping only holds from the
// routes parseOptionsHash itself produces.
export function optionsHash(route) {
  if (!route) return '#/options/repos'
  if (route.repo != null) return `#/options/repo/${encodeURIComponent(route.repo)}`
  if (route.recruit) return '#/options/recruit'
  if (route.tab === 'claude') return `#/options/claude/${CLAUDE_SUBS.includes(route.sub) ? route.sub : 'skills'}`
  return `#/options/${TABS.includes(route.tab) ? route.tab : 'repos'}`
}

// Fields that are lists on the wire; `tags` additionally splits on commas
// (the only one a human types as one comma-joined string) and is deduped.
const LIST_FIELDS = ['setup', 'build', 'test', 'run', 'tags']

// Ported unchanged from dashboard.html's norm(f) (options-page-save-contract).
export function normFields(fields) {
  const out = {}
  for (const k of Object.keys(fields).sort()) {
    let v = fields[k]
    if (LIST_FIELDS.includes(k)) {
      v = [].concat(v ?? []).flatMap((s) => (k === 'tags' ? String(s).split(',') : [s])).map((s) => String(s).trim()).filter(Boolean)
      if (k === 'tags') v = [...new Set(v)].sort()
    } else if (typeof v === 'string') v = v.trim()
    if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) out[k] = v
  }
  return out
}

// `orig` is either the JSON-stringified normalized baseline (as stored in a
// draft's `.orig`) or the original fields themselves.
export function isDirty(orig, fields) {
  const baseline = typeof orig === 'string' ? orig : JSON.stringify(normFields(orig))
  return JSON.stringify(normFields(fields)) !== baseline
}

// items: [{ name, dirty }]. "" for none pending.
export function dirtySummary(items) {
  const names = (items ?? []).filter((i) => i && i.dirty).map((i) => i.name)
  return names.length ? `${names.length} unsaved: ${names.join(', ')}` : ''
}

// Ported unchanged from dashboard.html's fwd(h).
export function forwardHash(moved, hash) {
  let h = hash
  while (h && moved[h]) h = moved[h]
  return h
}

const KIND_ORDER = ['repo', 'setting', 'skill', 'plugin', 'mcp', 'tag', 'page']

// detail from whichever of `keys` are present on `o`, joined with " · ".
const detailOf = (o, keys) => keys.map((k) => o[k]).filter(Boolean).join(' · ')

export function buildSearchIndex({ repos = [], settingsFields = [], claude = {} } = {}) {
  const index = []

  for (const r of repos) {
    const tags = Array.isArray(r.tags) ? r.tags : []
    index.push({
      kind: 'repo', label: r.name,
      detail: [tags.join(', '), r.defaultBranch, r.image].filter(Boolean).join(' · '),
      hash: optionsHash({ tab: 'repos', repo: r.name }),
    })
  }

  const tagCounts = new Map()
  for (const r of repos) for (const t of Array.isArray(r.tags) ? r.tags : []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
  for (const [tag, count] of tagCounts) {
    index.push({ kind: 'tag', label: tag, detail: `${count} repo${count === 1 ? '' : 's'}`, hash: optionsHash({ tab: 'repos' }) })
  }

  for (const s of settingsFields) {
    index.push({ kind: 'setting', label: s.label, detail: s.help ?? '', hash: optionsHash({ tab: 'rules' }) })
  }

  for (const s of claude.skills ?? []) {
    index.push({ kind: 'skill', label: s.name, detail: s.description ?? '', hash: optionsHash({ tab: 'claude', sub: 'skills' }) })
  }
  for (const p of claude.plugins ?? []) {
    index.push({ kind: 'plugin', label: p.name, detail: detailOf(p, ['marketplace', 'version']), hash: optionsHash({ tab: 'claude', sub: 'plugins' }) })
  }
  for (const m of claude.mcp ?? []) {
    index.push({ kind: 'mcp', label: m.name, detail: detailOf(m, ['scope', 'transport']), hash: optionsHash({ tab: 'claude', sub: 'mcp' }) })
  }

  index.push({ kind: 'page', label: 'RAW repos.yaml', detail: '', hash: optionsHash({ tab: 'raw' }) })
  return index
}

// label prefix (3) > label substring (2) > detail substring (1); ties by kind order then label.
export function searchOptions(index, query, limit = 8) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return []
  const scored = []
  for (const e of index ?? []) {
    const label = String(e.label ?? '').toLowerCase()
    const detail = String(e.detail ?? '').toLowerCase()
    const score = label.startsWith(q) ? 3 : label.includes(q) ? 2 : detail.includes(q) ? 1 : 0
    if (score) scored.push({ e, score })
  }
  scored.sort((a, b) =>
    b.score - a.score ||
    KIND_ORDER.indexOf(a.e.kind) - KIND_ORDER.indexOf(b.e.kind) ||
    String(a.e.label).localeCompare(String(b.e.label)))
  return scored.slice(0, limit).map((s) => s.e)
}
