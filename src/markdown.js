// Minimal, dependency-free markdown → HTML. Escapes ALL input first so
// container-sourced result text can never inject markup.
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function inline(s) {
  // s is already HTML-escaped; apply bold then inline code
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

export function renderMarkdown(text) {
  const lines = String(text).split('\n')
  const out = []
  let i = 0
  let listType = null // 'ul' | 'ol' | null
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null } }

  while (i < lines.length) {
    const line = lines[i]

    // fenced code block
    if (line.trim().startsWith('```')) {
      closeList()
      const buf = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(escapeHtml(lines[i])); i++ }
      i++ // skip closing fence
      out.push('<pre><code>' + buf.join('\n') + '</code></pre>')
      continue
    }

    // heading
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      closeList()
      const level = h[1].length
      out.push(`<h${level}>` + inline(escapeHtml(h[2])) + `</h${level}>`)
      i++
      continue
    }

    // list item (unordered or ordered)
    const ul = line.match(/^\s*-\s+(.*)$/)
    const ol = line.match(/^\s*\d+\.\s+(.*)$/)
    if (ul || ol) {
      const type = ul ? 'ul' : 'ol'
      if (listType !== type) { closeList(); out.push(`<${type}>`); listType = type }
      out.push('<li>' + inline(escapeHtml((ul || ol)[1])) + '</li>')
      i++
      continue
    }

    // blank line
    if (line.trim() === '') { closeList(); i++; continue }

    // paragraph
    closeList()
    out.push('<p>' + inline(escapeHtml(line)) + '</p>')
    i++
  }
  closeList()
  return out.join('\n')
}
