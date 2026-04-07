/**
 * Bridges an MCP server's tools into Betsy's MemoryTool interface.
 *
 * Two responsibilities:
 * 1. Convert MCP JSON Schema (input schema) to a zod schema, since Betsy
 *    tools advertise their parameters as `z.ZodType`. We deliberately don't
 *    pull in `json-schema-to-zod` — we only need a small subset of JSON
 *    Schema features that real MCP tools use.
 * 2. Wrap callTool() so the result is JSON-serializable, isError → throw,
 *    and oversized payloads are truncated.
 */
import { z, type ZodTypeAny } from 'zod'
import type { McpClient } from './client.js'
import type { McpToolDescriptor } from './types.js'
import type { MemoryTool } from '../tools/memory-tools.js'
import { log } from '../../observability/logger.js'

const MAX_RESULT_BYTES = 10_000

/**
 * Convert a JSON Schema fragment (subset) to a zod schema.
 *
 * Supported keywords: type (string|number|integer|boolean|object|array|null),
 * properties, required, items, enum, anyOf/oneOf (best-effort union),
 * description, default, nullable, additionalProperties (object passthrough).
 *
 * Anything unknown falls back to z.any() so we never reject a tool call.
 */
export function jsonSchemaToZod(schema: any): ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.any()

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const literals = schema.enum.map((v: unknown) => z.literal(v as any))
    if (literals.length === 1) return literals[0]
    return z.union(literals as any)
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const opts = schema.anyOf.map(jsonSchemaToZod)
    return opts.length === 1 ? opts[0] : z.union(opts as any)
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const opts = schema.oneOf.map(jsonSchemaToZod)
    return opts.length === 1 ? opts[0] : z.union(opts as any)
  }

  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type

  let base: ZodTypeAny
  switch (t) {
    case 'string':
      base = z.string()
      break
    case 'number':
      base = z.number()
      break
    case 'integer':
      base = z.number().int()
      break
    case 'boolean':
      base = z.boolean()
      break
    case 'null':
      base = z.null()
      break
    case 'array': {
      const item = schema.items ? jsonSchemaToZod(schema.items) : z.any()
      base = z.array(item)
      break
    }
    case 'object':
    default: {
      const props: Record<string, ZodTypeAny> = {}
      const required: string[] = Array.isArray(schema.required) ? schema.required : []
      const properties = (schema.properties ?? {}) as Record<string, any>
      for (const [key, sub] of Object.entries(properties)) {
        let fieldSchema = jsonSchemaToZod(sub)
        if (!required.includes(key)) {
          fieldSchema = fieldSchema.optional()
        }
        props[key] = fieldSchema
      }
      // Use passthrough so tools that accept extra fields still work.
      base = z.object(props).passthrough()
      break
    }
  }

  if (typeof schema.description === 'string') {
    base = base.describe(schema.description)
  }
  if (schema.nullable === true) {
    base = base.nullable()
  }

  return base
}

/** Sanitize a tool name fragment for safe inclusion in a Gemini function name. */
function sanitize(part: string): string {
  return part.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 48)
}

export function bridgeMcpTool(
  serverName: string,
  client: McpClient,
  descriptor: McpToolDescriptor,
): MemoryTool | null {
  let parameters: ZodTypeAny
  try {
    parameters = jsonSchemaToZod(descriptor.inputSchema)
  } catch (e) {
    log().warn('mcp: skipping tool with invalid schema', {
      server: serverName,
      tool: descriptor.name,
      error: e instanceof Error ? e.message : String(e),
    })
    return null
  }

  const bridgedName = `mcp__${sanitize(serverName)}__${sanitize(descriptor.name)}`

  return {
    name: bridgedName,
    description:
      descriptor.description ??
      `MCP tool "${descriptor.name}" from server "${serverName}"`,
    parameters,
    async execute(params: any) {
      try {
        const result = await client.callTool(descriptor.name, params ?? {})
        let payload: unknown
        if (result.structuredContent !== undefined) {
          payload = result.structuredContent
        } else {
          payload = { text: result.text }
        }
        // Truncate oversized payloads to keep tokens bounded.
        const serialized = JSON.stringify(payload)
        if (serialized.length > MAX_RESULT_BYTES) {
          const truncated = serialized.slice(0, MAX_RESULT_BYTES)
          return {
            truncated: true,
            originalBytes: serialized.length,
            preview: truncated,
            isError: result.isError,
          }
        }
        if (result.isError) {
          return { error: payload, isError: true }
        }
        return payload
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log().warn('mcp: tool execution failed', {
          server: serverName,
          tool: descriptor.name,
          error: msg,
        })
        return { error: msg, isError: true }
      }
    },
  }
}
