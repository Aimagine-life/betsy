/**
 * Convert a (possibly partial / streaming) Markdown string into Telegram-safe HTML.
 *
 * Telegram supports a limited HTML subset with parse_mode='HTML':
 *   <b> <i> <u> <s> <code> <pre> <a href="..."> <blockquote>
 *
 * Design goals:
 * - Safe by default: HTML special chars (& < >) are always escaped first.
 * - Tolerant of partial input: an UNCLOSED `**`, `_`, or `` ` `` is left as
 *   literal text instead of producing broken HTML. This is critical for
 *   streaming where each draft contains a prefix of the final answer.
 * - No external deps. No regex backtracking traps.
 *
 * Supported syntax:
 *   **bold**          -> <b>bold</b>
 *   __bold__          -> <b>bold</b>
 *   *italic*          -> <i>italic</i>     (only if it doesn't look like a list bullet)
 *   _italic_          -> <i>italic</i>
 *   `code`            -> <code>code</code>
 *   ```block```       -> <pre>block</pre>
 *   - item / * item   -> • item            (line-leading bullet)
 *   [text](url)       -> <a href="url">text</a>
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c] ?? c)
}

/**
 * Find a balanced delimiter pair starting at `from` for delimiter `delim`.
 * Returns the index just after the opening delim and the index of the closing
 * delim, or null if there is no closing delim (i.e. unclosed / partial).
 */
function findClose(text: string, from: number, delim: string): number | null {
  const idx = text.indexOf(delim, from)
  return idx === -1 ? null : idx
}

export function markdownToTelegramHTML(input: string): string {
  if (!input) return ''

  // 1. Extract fenced code blocks first so their content is not processed.
  //    Use a placeholder to avoid double-escaping.
  const placeholders: string[] = []
  const PH = (i: number) => `\u0000PH${i}\u0000`

  let text = input

  // Triple-backtick blocks
  text = text.replace(/```([\s\S]*?)```/g, (_m, code) => {
    const html = `<pre>${escapeHtml(code)}</pre>`
    placeholders.push(html)
    return PH(placeholders.length - 1)
  })

  // Inline code (single backtick) — must be balanced on the same scan
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    const html = `<code>${escapeHtml(code)}</code>`
    placeholders.push(html)
    return PH(placeholders.length - 1)
  })

  // Links [text](url) — restrict url chars conservatively
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const safeUrl = escapeHtml(url)
    const safeLabel = escapeHtml(label)
    const html = `<a href="${safeUrl}">${safeLabel}</a>`
    placeholders.push(html)
    return PH(placeholders.length - 1)
  })

  // 2. Now escape the rest as HTML.
  text = escapeHtml(text)

  // 3. Bold (** or __) — only if a closing pair exists.
  text = replacePaired(text, '**', 'b')
  text = replacePaired(text, '__', 'b')

  // 4. Italic (*single* or _single_) — single delimiter, must not be part of
  //    a list bullet. We require non-space immediately after open and
  //    non-space immediately before close.
  text = replaceItalic(text, '*')
  text = replaceItalic(text, '_')

  // 5. Bullets at line start: "- " or "* " (after escape) -> "• "
  text = text.replace(/(^|\n)[\-\*] /g, (_m, p1) => `${p1}\u2022 `)

  // 6. Restore placeholders.
  text = text.replace(/\u0000PH(\d+)\u0000/g, (_m, n) => placeholders[Number(n)] ?? '')

  return text
}

function replacePaired(text: string, delim: string, tag: string): string {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf(delim, i)
    if (open === -1) {
      out.push(text.slice(i))
      break
    }
    const close = findClose(text, open + delim.length, delim)
    if (close === null) {
      // Unclosed — leave the rest as-is.
      out.push(text.slice(i))
      break
    }
    out.push(text.slice(i, open))
    const inner = text.slice(open + delim.length, close)
    out.push(`<${tag}>${inner}</${tag}>`)
    i = close + delim.length
  }
  return out.join('')
}

function replaceItalic(text: string, delim: string): string {
  // Single-char delimiter, more cautious: avoid matching across newlines and
  // avoid matching a delim that is adjacent to whitespace on the wrong side
  // (which would be ambiguous / wrong for bullets like "* item").
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf(delim, i)
    if (open === -1) {
      out.push(text.slice(i))
      break
    }
    // Skip if open is start of a bullet "*  " or beginning followed by space
    const next = text[open + 1]
    if (next === undefined || next === ' ' || next === '\n' || next === delim) {
      out.push(text.slice(i, open + 1))
      i = open + 1
      continue
    }
    // Find matching close on same line
    let close = -1
    for (let j = open + 1; j < text.length; j++) {
      const ch = text[j]
      if (ch === '\n') break
      if (ch === delim) {
        const prev = text[j - 1]
        if (prev !== ' ' && prev !== delim) {
          close = j
          break
        }
      }
    }
    if (close === -1) {
      out.push(text.slice(i))
      break
    }
    out.push(text.slice(i, open))
    const inner = text.slice(open + 1, close)
    out.push(`<i>${inner}</i>`)
    i = close + 1
  }
  return out.join('')
}
