/**
 * Thin wrapper around @modelcontextprotocol/sdk's Client.
 *
 * Responsibilities:
 * - Build the right transport (stdio / sse / http) from McpServerConfig.
 * - Provide connect / listTools / callTool / close with sane defaults
 *   (timeouts, single retry on transient failure, isolated error capture).
 * - Never throw out raw secrets in error messages — env values stay opaque.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig, McpToolDescriptor, McpCallResult } from './types.js'
import { log } from '../../observability/logger.js'
import { withSpan } from '../../observability/tracing.js'

const DEFAULT_TIMEOUT_MS = 10_000

export interface McpClientOptions {
  /** Per-call timeout (default 10s). */
  timeoutMs?: number
  /** Allow injecting a fake Client for tests. */
  clientFactory?: () => any
}

export class McpClient {
  private client: any | null = null
  private connected = false
  private connecting: Promise<void> | null = null
  private readonly timeoutMs: number

  constructor(
    private readonly cfg: McpServerConfig,
    private readonly opts: McpClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get name(): string {
    return this.cfg.name
  }

  /** Idempotent connect. Concurrent callers share one in-flight connect. */
  async connect(): Promise<void> {
    if (this.connected) return
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      try {
        const client = this.opts.clientFactory
          ? this.opts.clientFactory()
          : new Client(
              { name: 'betsy-mcp-client', version: '0.1.0' },
              { capabilities: {} },
            )
        const transport = this.buildTransport()
        await this.withTimeout(client.connect(transport), 'connect')
        this.client = client
        this.connected = true
      } catch (e) {
        // Drop secrets from error context.
        log().warn('mcp: connect failed', {
          server: this.cfg.name,
          transport: this.cfg.transport,
          error: e instanceof Error ? e.message : String(e),
        })
        throw e
      } finally {
        this.connecting = null
      }
    })()
    return this.connecting
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    await this.connect()
    const resp = await this.withRetry(
      () => this.withTimeout(this.client!.listTools(), 'listTools'),
      'listTools',
    )
    const tools: any[] = (resp as any)?.tools ?? []
    return tools
      .filter((t) => t && typeof t.name === 'string' && t.inputSchema)
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    return withSpan(
      `betsy.mcp.${this.cfg.name}.${name}`,
      () => this.callToolImpl(name, args),
      { server: this.cfg.name, tool: name },
    )
  }

  private async callToolImpl(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.connect()
    const resp: any = await this.withRetry(
      () =>
        this.withTimeout(
          this.client!.callTool({ name, arguments: args }),
          `callTool:${name}`,
        ),
      `callTool:${name}`,
    )
    const blocks: any[] = Array.isArray(resp?.content) ? resp.content : []
    const text = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
    return {
      text,
      isError: Boolean(resp?.isError),
      structuredContent: resp?.structuredContent,
    }
  }

  async close(): Promise<void> {
    if (!this.client) {
      this.connected = false
      return
    }
    try {
      await this.client.close?.()
    } catch (e) {
      log().warn('mcp: close failed', {
        server: this.cfg.name,
        error: e instanceof Error ? e.message : String(e),
      })
    } finally {
      this.client = null
      this.connected = false
    }
  }

  private buildTransport(): any {
    const cfg = this.cfg
    if (cfg.transport === 'stdio') {
      if (!cfg.command) throw new Error(`mcp[${cfg.name}]: stdio requires command`)
      return new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env ?? undefined,
      })
    }
    if (cfg.transport === 'sse') {
      if (!cfg.url) throw new Error(`mcp[${cfg.name}]: sse requires url`)
      return new SSEClientTransport(new URL(cfg.url))
    }
    if (cfg.transport === 'http') {
      if (!cfg.url) throw new Error(`mcp[${cfg.name}]: http requires url`)
      return new StreamableHTTPClientTransport(new URL(cfg.url))
    }
    throw new Error(`mcp[${cfg.name}]: unsupported transport ${(cfg as any).transport}`)
  }

  private async withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race<T>([
        p,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `mcp[${this.cfg.name}]: ${label} timed out after ${this.timeoutMs}ms`,
                ),
              ),
            this.timeoutMs,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** One retry on transient failure. */
  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      log().warn('mcp: retry after failure', {
        server: this.cfg.name,
        op: label,
        error: e instanceof Error ? e.message : String(e),
      })
      // On a retry it's safest to drop the connection and reconnect.
      try {
        await this.close()
      } catch {}
      await this.connect()
      return await fn()
    }
  }
}
