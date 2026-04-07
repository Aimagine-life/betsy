import { z } from 'zod'
import { log } from '../../observability/logger.js'
import type { MemoryTool } from './memory-tools.js'

/** Max raw bytes we'll read from a remote response before aborting. */
const MAX_RAW_BYTES = 1024 * 1024 // 1 MB
/** Hard request timeout. */
const FETCH_TIMEOUT_MS = 10_000

const paramsSchema = z.object({
  url: z.string().url(),
  max_chars: z.number().int().min(500).max(20_000).optional(),
})

/**
 * Hostnames / patterns that must never be reached from this tool.
 * Defends against SSRF to localhost, link-local, and RFC1918 ranges.
 */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '0.0.0.0') return true
  if (h === '::1' || h === '::') return true
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  // IPv4 dotted-quad checks
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 127) return true
    if (a === 10) return true
    if (a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
  }
  return false
}

function isBlockedUrl(raw: string): { blocked: true; reason: string } | { blocked: false } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { blocked: true, reason: 'invalid url' }
  }
  const proto = parsed.protocol.toLowerCase()
  if (proto !== 'http:' && proto !== 'https:') {
    return { blocked: true, reason: `protocol ${proto} not allowed` }
  }
  if (isBlockedHost(parsed.hostname)) {
    return { blocked: true, reason: `host ${parsed.hostname} is blocked` }
  }
  return { blocked: false }
}

/** Decode the small set of HTML entities we care about. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = Number(code)
      if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return ''
      try {
        return String.fromCodePoint(n)
      } catch {
        return ''
      }
    })
    .replace(/&amp;/g, '&')
}

/** Stringify HTML to plain text using only regex — no new deps. */
export function htmlToText(html: string): { text: string; title?: string } {
  let s = html
  // 1. Strip script & style blocks (with their content)
  s = s.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
  // 2. Strip HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  // 3. Extract <title> if present (after stripping script/style)
  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim().replace(/\s+/g, ' ') : undefined
  // 4. Replace block-level tags with newlines so structure is preserved
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n')
  s = s.replace(/<\/?(p|li|h[1-6]|tr|div|section|article|header|footer)[^>]*>/gi, '\n')
  // 5. Drop everything else
  s = s.replace(/<[^>]+>/g, '')
  // 6. Decode entities
  s = decodeEntities(s)
  // 7. Collapse whitespace
  s = s.replace(/\r\n?/g, '\n')
  s = s.replace(/[ \t\f\v]+/g, ' ')
  s = s.replace(/ *\n */g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  s = s.trim()
  return { text: s, title }
}

export interface FetchUrlResult {
  url: string
  title?: string
  text: string
  truncated: boolean
}

/**
 * Build the fetch_url tool. Sub-agents (esp. research) use this to deepen
 * after a web search.
 */
export function createFetchUrlTool(): MemoryTool {
  return {
    name: 'fetch_url',
    description:
      'Скачать страницу по URL и вернуть её текст (до 8KB по умолчанию). Используй для углубления после web_search.',
    parameters: paramsSchema,
    async execute(rawParams) {
      const params = paramsSchema.parse(rawParams)
      const maxChars = params.max_chars ?? 8000

      const block = isBlockedUrl(params.url)
      if (block.blocked) {
        return { error: `blocked: ${block.reason}`, url: params.url }
      }

      let resp: Response
      try {
        resp = await fetch(params.url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log().warn('fetch_url: network error', { url: params.url, error: msg })
        return { error: `fetch failed: ${msg}`, url: params.url }
      }

      if (!resp.ok) {
        return { error: `http ${resp.status}`, url: params.url }
      }

      const ct = (resp.headers.get('content-type') ?? '').toLowerCase()
      if (!ct.includes('text/') && !ct.includes('application/xhtml')) {
        return { error: `unsupported content-type: ${ct || 'unknown'}`, url: params.url }
      }

      // Read body but cap at MAX_RAW_BYTES
      const reader = resp.body?.getReader()
      let raw = ''
      let totalBytes = 0
      if (reader) {
        const decoder = new TextDecoder('utf-8', { fatal: false })
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            totalBytes += value.byteLength
            if (totalBytes > MAX_RAW_BYTES) {
              try {
                await reader.cancel()
              } catch {
                /* ignore */
              }
              return { error: 'response too large', url: params.url }
            }
            raw += decoder.decode(value, { stream: true })
          }
        }
        raw += decoder.decode()
      } else {
        raw = await resp.text()
        if (raw.length > MAX_RAW_BYTES) {
          return { error: 'response too large', url: params.url }
        }
      }

      const { text, title } = htmlToText(raw)
      let truncated = false
      let outText = text
      if (outText.length > maxChars) {
        outText = outText.slice(0, maxChars) + '…[truncated]'
        truncated = true
      }

      const result: FetchUrlResult = {
        url: params.url,
        text: outText,
        truncated,
      }
      if (title) result.title = title
      return result
    },
  }
}
