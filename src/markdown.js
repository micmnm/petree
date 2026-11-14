// Dependency-free markdown → HTML (CommonMark/GFM subset). Escapes ALL input
// first and only then adds markup, so container-sourced text can never inject
// HTML. Control chars \u0001-\u0003 are internal placeholders and are stripped
// from input.
function escapeHtml(s) {
  return s
    .replace(/[\u0001-\u0003]/g, '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

const BR = '\u0003'

// Link safety boundary: http(s), mailto, #anchors, and relative paths only.
// `url` is already HTML-escaped, so quotes cannot break out of the attribute.
function link(url, textHtml) {
  const ext = /^https?:/i.test(url)
  const ok = ext || /^mailto:/i.test(url) || url.startsWith('#') || /^(?:\/(?!\/)|\?|[^:/?#]+(?:[/?#]|$))/.test(url)
  if (!ok) return null
  return `<a href="${url}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${textHtml}</a>`
}

// s is already HTML-escaped. Code spans and links are stashed behind
// placeholders so later passes (emphasis, bare URLs) can't touch their insides.
function inline(s) {
  const stash = []
  const hold = (html) => `\u0001${stash.push(html) - 1}\u0002`

  function fmt(t) {
    t = t.replace(/&lt;((?:https?:\/\/|mailto:)(?:(?!&gt;)\S)+)&gt;/gi, (m, u) => {
      const a = link(u, u)
      return a ? hold(a) : m
    })
    t = t.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (m, bang, text, url) => {
      const a = link(url, fmt(text) || url)
      return a ? hold(a) : m
    })
    t = t.replace(/(^|[^\w/"=>])(https?:\/\/(?:(?!&(?:lt|gt|quot|#39);)\S)+)/gi, (m, pre, u) => {
      const tail = u.match(/[.,:!?)]+$/)
      if (tail) u = u.slice(0, -tail[0].length)
      return pre + hold(link(u, u)) + (tail ? tail[0] : '')
    })
    return t
      .replace(/\*\*\*(\S|\S[^*]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(\S|\S[\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)__(\S|\S[\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/\*(\S|\S[^*]*?\S)\*/g, '<em>$1</em>')
      .replace(/(^|\W)_(\S|\S[^_]*?\S)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(\S|\S[\s\S]*?\S)~~/g, '<del>$1</del>')
  }

  let out = fmt(s.replace(/`([^`]+)`/g, (m, c) => hold(`<code>${c}</code>`)))
  while (/\u0001\d+\u0002/.test(out)) out = out.replace(/\u0001(\d+)\u0002/g, (m, n) => stash[n])
  return out
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^ {0,3}>/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

function splitRow(line) {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (/(^|[^\\])\|$/.test(t)) t = t.slice(0, -1)
  return t.replace(/\\\|/g, '\u0001').split('|').map((c) => c.replace(/\u0001/g, '|').trim())
}

const isTableStart = (line, next) =>
  next !== undefined && line.includes('|') && next.includes('|') && SEP.test(next) &&
  splitRow(line).length === splitRow(next).length

const isBlockStart = (line, next) =>
  FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line) || isTableStart(line, next)

const indentOf = (l) => l.match(/^ */)[0].length

function parseTable(lines, i) {
  const head = splitRow(lines[i])
  const align = splitRow(lines[i + 1]).map((c) =>
    c.startsWith(':') ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : '')
  const cell = (tag, c, k) => `<${tag}${align[k] ? ` class="md-${align[k]}"` : ''}>${inline(escapeHtml(c))}</${tag}>`
  const rows = []
  i += 2
  while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
    const cells = splitRow(lines[i])
    // pad or truncate to header width
    const row = head.map((_, k) => cell('td', cells[k] ?? '', k))
    rows.push(`<tr>${row.join('')}</tr>`)
    i++
  }
  const thead = `<thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead>`
  const tbody = rows.length ? `<tbody>${rows.join('')}</tbody>` : ''
  return [`<div class="md-table"><table>${thead}${tbody}</table></div>`, i]
}

function parseList(lines, i) {
  const first = lines[i].match(ITEM)
  const base = first[1].length
  const ordered = /\d/.test(first[2])
  const items = []
  let m = first

  while (i < lines.length) {
    // m is the marker match of lines[i]: start a new item
    const content = [m[3]]
    const rest = []
    i++
    while (i < lines.length) {
      const l = lines[i]
      if (l.trim() === '') {
        let j = i
        while (j < lines.length && lines[j].trim() === '') j++
        if (j >= lines.length) { i = j; break }
        const n = lines[j]
        const nm = n.match(ITEM)
        const nested = indentOf(n) > base + 1 || (indentOf(n) > base && !nm)
        if (!nested && !(nm && indentOf(n) <= base + 1 && nm[1].length >= base && /\d/.test(nm[2]) === ordered)) break
        for (; i < j; i++) rest.push('')
        continue
      }
      const lm = l.match(ITEM)
      const ind = indentOf(l)
      if (ind > base + 1 || (ind > base && !lm)) { rest.push(l); i++; continue }
      if (lm) break
      if (ind <= base && !isBlockStart(l, lines[i + 1]) && rest.length === 0) { content.push(l.trim()); i++; continue }
      break
    }
    const cut = Math.min(...rest.filter((l) => l !== '').map(indentOf), Infinity)
    const body = content.concat(rest.map((l) => l.slice(Math.min(cut, indentOf(l)))))
    let box = ''
    const task = body[0].match(/^\[([ xX])\]\s+/)
    if (task) {
      body[0] = body[0].slice(task[0].length)
      box = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> `
    }
    const blocks = parseBlocks(body)
    // tight list: first paragraph is not wrapped in <p>
    if (blocks[0] && /^<p>[\s\S]*<\/p>$/.test(blocks[0])) blocks[0] = blocks[0].slice(3, -4)
    items.push(`<li${task ? ' class="md-task"' : ''}>${box}${blocks.join('\n')}</li>`)

    if (i >= lines.length) break
    m = lines[i].match(ITEM)
    if (!m || indentOf(lines[i]) > base + 1 || m[1].length < base || /\d/.test(m[2]) !== ordered) break
  }

  const start = ordered && parseInt(first[2], 10) !== 1 ? ` start="${parseInt(first[2], 10)}"` : ''
  const tag = ordered ? 'ol' : 'ul'
  return [`<${tag}${start}>\n${items.join('\n')}\n</${tag}>`, i]
}

function parseBlocks(lines) {
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { i++; continue }

    const f = line.match(FENCE)
    if (f) {
      const ch = f[1][0]
      const lang = f[2].replace(/[^\w-]/g, '')
      const buf = []
      i++
      // closing fence: same char, at least as long, nothing else; unclosed runs to the end
      while (i < lines.length && !new RegExp(`^ {0,3}${ch}{${f[1].length},}\\s*$`).test(lines[i])) {
        buf.push(escapeHtml(lines[i]))
        i++
      }
      i++
      out.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${buf.join('\n')}</code></pre>`)
      continue
    }

    const h = line.match(HEADING)
    if (h) {
      out.push(`<h${h[1].length}>${inline(escapeHtml(h[2]))}</h${h[1].length}>`)
      i++
      continue
    }

    if (isTableStart(line, lines[i + 1])) {
      const [html, next] = parseTable(lines, i)
      out.push(html)
      i = next
      continue
    }

    if (HR.test(line)) { out.push('<hr>'); i++; continue }

    if (QUOTE.test(line)) {
      const buf = []
      while (i < lines.length && QUOTE.test(lines[i])) { buf.push(lines[i].replace(/^ {0,3}> ?/, '')); i++ }
      out.push(`<blockquote>\n${parseBlocks(buf).join('\n')}\n</blockquote>`)
      continue
    }

    if (ITEM.test(line)) {
      const [html, next] = parseList(lines, i)
      out.push(html)
      i = next
      continue
    }

    // paragraph: consecutive text lines; two trailing spaces or `\` is a hard break
    const buf = []
    while (i < lines.length && lines[i].trim() !== '' && (buf.length === 0 || !isBlockStart(lines[i], lines[i + 1]))) {
      buf.push(lines[i])
      i++
    }
    const text = buf
      .map((l, k) => escapeHtml(l.trim().replace(/\\$/, '')) + (k < buf.length - 1 && /( {2,}|\\)$/.test(l) ? BR : ''))
      .join(' ')
    out.push(`<p>${inline(text).replace(/\u0003/g, '<br>')}</p>`)
  }
  return out
}

export function renderMarkdown(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/^[ \t]+/, (w) => w.replace(/\t/g, '    ')))
  return parseBlocks(lines).join('\n')
}
