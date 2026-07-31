import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../src/markdown.js'

describe('renderMarkdown', () => {
  it('escapes HTML before formatting (no injection)', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('renders headings', () => {
    expect(renderMarkdown('# Title')).toContain('<h1>Title</h1>')
    expect(renderMarkdown('### Small')).toContain('<h3>Small</h3>')
  })

  it('renders bold and inline code', () => {
    expect(renderMarkdown('a **b** c')).toContain('<strong>b</strong>')
    expect(renderMarkdown('use `x` here')).toContain('<code>x</code>')
  })

  it('renders fenced code blocks with escaped content', () => {
    const html = renderMarkdown('```\n<b>hi</b>\n```')
    expect(html).toContain('<pre><code>')
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;')
  })

  it('renders unordered and ordered list items', () => {
    const ul = renderMarkdown('- one\n- two')
    expect(ul).toContain('<li>one</li>')
    expect(ul).toContain('<li>two</li>')
    const ol = renderMarkdown('1. first\n2. second')
    expect(ol).toContain('<li>first</li>')
  })

  it('wraps plain lines in paragraphs', () => {
    expect(renderMarkdown('hello world')).toContain('<p>hello world</p>')
  })
})
