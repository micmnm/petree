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

describe('tables', () => {
  const T = '| Name | Qty | Note |\n|:--|:-:|--:|\n| a | 1 | x |\n| b | 2 | y |'

  it('renders header, alignment and body in a scroll wrapper', () => {
    const html = renderMarkdown(T)
    expect(html).toMatch(/^<div class="md-table"><table>/)
    expect(html).toContain('<th>Name</th>'.replace('<th>', '<th class="md-left">'))
    expect(html).toContain('<th class="md-center">Qty</th>')
    expect(html).toContain('<th class="md-right">Note</th>')
    expect(html).toContain('<td class="md-right">y</td>')
    expect(html.match(/<tr>/g)).toHaveLength(3)
  })

  it('works without outer pipes', () => {
    const html = renderMarkdown('a | b\n--|--\n1 | 2')
    expect(html).toContain('<th>a</th><th>b</th>')
    expect(html).toContain('<td>1</td><td>2</td>')
  })

  it('handles escaped pipes and inline formatting in cells', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| x \\| y | **bold** `c` |')
    expect(html).toContain('<td>x | y</td>')
    expect(html).toContain('<td><strong>bold</strong> <code>c</code></td>')
  })

  it('pads and truncates ragged rows to the header width', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |')
    expect(html).toContain('<tr><td>1</td><td></td></tr>')
    expect(html).toContain('<tr><td>1</td><td>2</td></tr>')
    expect(html).not.toContain('3')
  })

  it('ends at a blank line and is not confused with an hr', () => {
    const html = renderMarkdown('| a |\n|---|\n| 1 |\n\nafter\n\n---')
    expect(html).toContain('<p>after</p>')
    expect(html).toContain('<hr>')
    expect(html.match(/<table>/g)).toHaveLength(1)
  })
})

describe('blocks', () => {
  it('joins consecutive lines into one paragraph', () => {
    expect(renderMarkdown('one\ntwo\n\nthree')).toBe('<p>one two</p>\n<p>three</p>')
  })

  it('hard-breaks on two trailing spaces or a backslash', () => {
    expect(renderMarkdown('one  \ntwo')).toBe('<p>one<br> two</p>')
    expect(renderMarkdown('one\\\ntwo')).toBe('<p>one<br> two</p>')
  })

  it('renders h4-h6 and not h7', () => {
    expect(renderMarkdown('#### a')).toBe('<h4>a</h4>')
    expect(renderMarkdown('###### f')).toBe('<h6>f</h6>')
    expect(renderMarkdown('####### g')).toBe('<p>####### g</p>')
  })

  it('renders blockquotes with paragraphs and lists', () => {
    const html = renderMarkdown('> first\n> line\n>\n> - a\n> - b')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<p>first line</p>')
    expect(html).toContain('<li>a</li>')
  })

  it('renders horizontal rules', () => {
    for (const r of ['---', '***', '___', '- - -']) expect(renderMarkdown(`a\n\n${r}\n\nb`)).toContain('<hr>')
  })
})

describe('lists', () => {
  it('supports * and + bullets', () => {
    expect(renderMarkdown('* a\n* b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>')
    expect(renderMarkdown('+ a')).toContain('<li>a</li>')
  })

  it('nests by indentation', () => {
    const html = renderMarkdown('- a\n  - b\n    - c\n- d')
    expect(html).toBe('<ul>\n<li>a\n<ul>\n<li>b\n<ul>\n<li>c</li>\n</ul></li>\n</ul></li>\n<li>d</li>\n</ul>')
  })

  it('nests ordered inside bullets and keeps the start number', () => {
    const html = renderMarkdown('- a\n  1. x\n  2. y')
    expect(html).toContain('<ol>')
    expect(renderMarkdown('3. c\n4. d')).toContain('<ol start="3">')
    expect(renderMarkdown('1. c')).toContain('<ol>')
  })

  it('renders task items as disabled checkboxes', () => {
    const html = renderMarkdown('- [ ] todo\n- [x] done')
    expect(html).toContain('<input type="checkbox" disabled> todo')
    expect(html).toContain('<input type="checkbox" disabled checked> done')
  })

  it('joins continuation lines into the item', () => {
    expect(renderMarkdown('- one\n  more\n- two')).toContain('<li>one\nmore</li>'.replace('\n', ' '))
    expect(renderMarkdown('- one\nlazy')).toContain('<li>one lazy</li>')
  })
})

describe('inline', () => {
  it('renders emphasis variants', () => {
    expect(renderMarkdown('*a* and _b_')).toBe('<p><em>a</em> and <em>b</em></p>')
    expect(renderMarkdown('***x***')).toContain('<strong><em>x</em></strong>')
    expect(renderMarkdown('~~gone~~')).toContain('<del>gone</del>')
  })

  it('does not treat underscores inside words as emphasis', () => {
    expect(renderMarkdown('snake_case_name')).toBe('<p>snake_case_name</p>')
  })

  it('renders links, autolinks and bare URLs', () => {
    expect(renderMarkdown('[a](https://x.io/p)')).toContain('<a href="https://x.io/p" target="_blank" rel="noopener noreferrer">a</a>')
    expect(renderMarkdown('<https://x.io>')).toContain('<a href="https://x.io" target="_blank" rel="noopener noreferrer">https://x.io</a>')
    const bare = renderMarkdown('see https://x.io/a_b_c.')
    expect(bare).toContain('href="https://x.io/a_b_c"')
    expect(bare).toMatch(/<\/a>\.<\/p>$/)
    expect(renderMarkdown('[m](mailto:a@b.c)')).toContain('<a href="mailto:a@b.c">m</a>')
  })

  it('allows anchors and relative paths without target', () => {
    expect(renderMarkdown('[a](#top)')).toContain('<a href="#top">a</a>')
    expect(renderMarkdown('[a](docs/x.md)')).toContain('<a href="docs/x.md">a</a>')
    expect(renderMarkdown('[a](/x)')).toContain('<a href="/x">a</a>')
  })

  it('renders images as links', () => {
    const html = renderMarkdown('![alt](https://x.io/i.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('<a href="https://x.io/i.png"')
  })

  it('keeps inline code literal', () => {
    const html = renderMarkdown('`a*b*_c_ **d** [x](https://y.io)`')
    expect(html).toBe('<p><code>a*b*_c_ **d** [x](https://y.io)</code></p>')
  })

  it('applies emphasis inside link text', () => {
    expect(renderMarkdown('[**b**](https://x.io)')).toContain('>' + '<strong>b</strong></a>')
  })
})

describe('fenced code', () => {
  it('adds a sanitized language class', () => {
    expect(renderMarkdown('```ts\nx\n```')).toContain('<pre><code class="language-ts">x</code></pre>')
    const bad = renderMarkdown('```a"onload=x\ny\n```')
    expect(bad).toContain('class="language-aonloadx"')
  })

  it('supports ~~~ fences and keeps markdown literal inside', () => {
    expect(renderMarkdown('~~~\n# not heading\n**x**\n~~~')).toContain('<pre><code># not heading\n**x**</code></pre>')
  })

  it('runs an unclosed fence to the end', () => {
    expect(renderMarkdown('```\na\n\nb')).toBe('<pre><code>a\n\nb</code></pre>')
  })
})

describe('xss', () => {
  it('escapes script tags and handlers everywhere', () => {
    for (const src of ['<script>alert(1)</script>', '# <script>x</script>', '- <img src=x onerror=alert(1)>', '> <b onclick=x>']) {
      const html = renderMarkdown(src)
      expect(html).not.toMatch(/<script|<img|<b /)
    }
  })

  it('keeps HTML inside table cells escaped', () => {
    const html = renderMarkdown('| <script>x</script> | <img src=x onerror=y> |\n|---|---|\n| <b>z</b> | [a](x) |')
    expect(html).not.toMatch(/<script|<img|<b>/)
    expect(html).toContain('&lt;script&gt;')
  })

  it('does not link javascript: or data: URLs', () => {
    for (const src of ['[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](data:text/html,<script>1</script>)', '![x](javascript:alert(1))', '[x](//evil.io)']) {
      expect(renderMarkdown(src)).not.toContain('<a ')
    }
  })

  it('cannot break out of the href attribute', () => {
    const html = renderMarkdown('[x](https://a.io/"onmouseover="alert(1))  [y](https://a.io/\'onfocus=\'x)')
    expect(html).not.toMatch(/href="[^"]*"[^>]*onmouseover/)
    expect(html).toContain('&quot;onmouseover=&quot;')
    expect(html).not.toContain("'onfocus")
    const auto = renderMarkdown('<https://a.io/"x=y>')
    expect(auto).not.toMatch(/href="https:\/\/a\.io\/"/)
  })
})

describe('realistic findings document', () => {
  const doc = [
    '# Findings',
    '',
    'The cache is **stale** after deploy; see https://example.com/issue/12.',
    '',
    '## Results',
    '',
    '| Path | Hits | Verdict |',
    '|------|-----:|:-------:|',
    '| `/api/a` | 120 | ok |',
    '| `/api/b` | 3 | **slow** |',
    '',
    '### Steps',
    '',
    '1. Reproduce',
    '   - run `make test`',
    '   - [x] check logs',
    '2. Patch',
    '',
    '> Note: do not ship before review.',
    '',
    '---',
    '',
    '```ts',
    'const a = x < y && y > 1',
    '```',
  ].join('\n')

  it('renders every block type', () => {
    const html = renderMarkdown(doc)
    expect(html).toContain('<h1>Findings</h1>')
    expect(html).toContain('<strong>stale</strong>')
    expect(html).toContain('<a href="https://example.com/issue/12"')
    expect(html).toContain('<th class="md-right">Hits</th>')
    expect(html).toContain('<td><code>/api/a</code></td>')
    expect(html).toContain('<li>Reproduce\n<ul>')
    expect(html).toContain('<li>run <code>make test</code></li>')
    expect(html).toContain('<input type="checkbox" disabled checked> check logs')
    expect(html).toContain('<li>Patch</li>')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<hr>')
    expect(html).toContain('<code class="language-ts">const a = x &lt; y &amp;&amp; y &gt; 1</code>')
  })
})
