import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createFetchUrlTool,
  htmlToText,
} from '../../../../src/multi/agents/tools/fetch-url-tool.js'

describe('htmlToText', () => {
  it('strips script and style blocks with their content', () => {
    const html =
      '<html><head><style>body{color:red}</style><script>alert(1)</script></head><body>Hello</body></html>'
    const { text } = htmlToText(html)
    expect(text).not.toContain('alert')
    expect(text).not.toContain('color:red')
    expect(text).toContain('Hello')
  })

  it('extracts <title>', () => {
    const { title } = htmlToText('<html><head><title> My Page </title></head><body>x</body></html>')
    expect(title).toBe('My Page')
  })

  it('strips nested tags and decodes entities', () => {
    const html =
      '<div><p>Tom &amp; Jerry</p><p>5 &lt; 7 &gt; 3</p><p>&quot;hi&quot; &#39;ok&#39;</p></div>'
    const { text } = htmlToText(html)
    expect(text).toContain('Tom & Jerry')
    expect(text).toContain('5 < 7 > 3')
    expect(text).toContain('"hi" \'ok\'')
  })

  it('handles emojis and cyrillic via numeric entities', () => {
    const html = '<p>Привет &#128512; мир</p>'
    const { text } = htmlToText(html)
    expect(text).toContain('Привет')
    expect(text).toContain('мир')
    expect(text).toContain('\u{1F600}')
  })

  it('inserts newlines for block tags', () => {
    const { text } = htmlToText('<p>one</p><p>two</p><p>three</p>')
    expect(text.split('\n').length).toBeGreaterThanOrEqual(3)
  })

  it('removes HTML comments', () => {
    const { text } = htmlToText('<p>before<!-- secret -->after</p>')
    expect(text).not.toContain('secret')
    expect(text).toContain('before')
    expect(text).toContain('after')
  })
})

// ---- execute() tests with mocked global fetch -----------------------------

const realFetch = globalThis.fetch

function mockFetchOnce(opts: {
  status?: number
  contentType?: string
  body?: string
  bodyBytes?: Uint8Array
}) {
  const status = opts.status ?? 200
  const ct = opts.contentType ?? 'text/html; charset=utf-8'
  const bodyBytes =
    opts.bodyBytes ?? new TextEncoder().encode(opts.body ?? '')
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bodyBytes)
      controller.close()
    },
  })
  const fakeResp = new Response(stream, {
    status,
    headers: { 'content-type': ct },
  })
  ;(globalThis as any).fetch = vi.fn(async () => fakeResp)
}

describe('fetch_url tool execute()', () => {
  afterEach(() => {
    ;(globalThis as any).fetch = realFetch
    vi.restoreAllMocks()
  })

  it('returns parsed text and title for a normal HTML response', async () => {
    mockFetchOnce({
      body: '<html><head><title>Hi</title></head><body><p>Hello world</p></body></html>',
    })
    const t = createFetchUrlTool()
    const r: any = await t.execute({ url: 'https://example.com/page' })
    expect(r.title).toBe('Hi')
    expect(r.text).toContain('Hello world')
    expect(r.truncated).toBe(false)
    expect(r.url).toBe('https://example.com/page')
  })

  it('truncates output to max_chars', async () => {
    const big = 'A'.repeat(5000)
    mockFetchOnce({ body: `<p>${big}</p>` })
    const t = createFetchUrlTool()
    const r: any = await t.execute({ url: 'https://example.com/', max_chars: 1000 })
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(1000 + 20)
    expect(r.text.endsWith('…[truncated]')).toBe(true)
  })

  it('rejects non-text content types', async () => {
    mockFetchOnce({ contentType: 'application/octet-stream', body: 'binary' })
    const t = createFetchUrlTool()
    const r: any = await t.execute({ url: 'https://example.com/' })
    expect(r.error).toMatch(/unsupported content-type/)
  })

  it('returns http status error on non-2xx', async () => {
    mockFetchOnce({ status: 500, body: '' })
    const t = createFetchUrlTool()
    const r: any = await t.execute({ url: 'https://example.com/' })
    expect(r.error).toMatch(/http 500/)
  })

  it('blocks SSRF targets', async () => {
    const t = createFetchUrlTool()
    const blocked = [
      'http://localhost/x',
      'http://127.0.0.1/x',
      'http://127.0.0.5/x',
      'http://10.0.0.1/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/x',
      'http://172.16.0.1/x',
      'http://[::1]/x',
      'ftp://example.com/x',
    ]
    for (const url of blocked) {
      const r: any = await t.execute({ url })
      expect(r.error, `should block ${url}`).toMatch(/blocked|invalid/)
    }
  })

  it('aborts on timeout (fetch never resolves)', async () => {
    ;(globalThis as any).fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            ;(err as any).name = 'AbortError'
            reject(err)
          })
        }),
    )
    // Replace AbortSignal.timeout with a fast version so the test runs quick
    const origTimeout = AbortSignal.timeout
    AbortSignal.timeout = ((_ms: number) => {
      const c = new AbortController()
      setTimeout(() => c.abort(), 20)
      return c.signal
    }) as any
    try {
      const t = createFetchUrlTool()
      const r: any = await t.execute({ url: 'https://example.com/slow' })
      expect(r.error).toMatch(/fetch failed/)
    } finally {
      AbortSignal.timeout = origTimeout
    }
  })
})

// ---- gated network test ---------------------------------------------------

const NETWORK = process.env.BC_TEST_NETWORK === '1'
describe.skipIf(!NETWORK)('fetch_url real network', () => {
  it('fetches example.com and finds Example Domain', async () => {
    const t = createFetchUrlTool()
    const r: any = await t.execute({ url: 'https://example.com/' })
    expect(r.text).toContain('Example Domain')
  }, 15_000)
})
