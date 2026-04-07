// Wave 1C — Workspace skills: mustache-lite template renderer.
// Replaces `{{expression}}` with safeEval(expression, scope). undefined → ''.
import { safeEval } from './safe-eval.js'

/**
 * Render a string template. Any `{{expr}}` is evaluated against scope using
 * the safe-eval expression language. undefined/null becomes empty string.
 * Non-strings (numbers, booleans, objects) are stringified.
 */
export function renderTemplate(template: string, scope: Record<string, any>): string {
  if (typeof template !== 'string') return ''
  return template.replace(/\{\{([\s\S]*?)\}\}/g, (_match, expr: string) => {
    const trimmed = expr.trim()
    if (trimmed.length === 0) return ''
    let value: unknown
    try {
      value = safeEval(trimmed, scope)
    } catch {
      return ''
    }
    if (value == null) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  })
}

/**
 * Recursively render templates in any value: strings get rendered,
 * arrays/objects are walked. Used for tool params.
 */
export function renderValue(value: any, scope: Record<string, any>): any {
  if (typeof value === 'string') return renderTemplate(value, scope)
  if (Array.isArray(value)) return value.map((v) => renderValue(v, scope))
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(value)) {
      // Skip dangerous keys defensively.
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
      out[k] = renderValue(v, scope)
    }
    return out
  }
  return value
}
