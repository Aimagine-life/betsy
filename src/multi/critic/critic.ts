/**
 * Wave 2B — CriticAgent.
 *
 * Lightweight pre-send validator. Called from runBetsy (non-stream path)
 * BEFORE the assistant message is persisted + emitted to the user, gated by
 * the `BC_CRITIC_ENABLED=1` feature flag.
 *
 * Design notes:
 *  - Uses gemini-2.5-flash (NOT pro) — must be fast, we're in the critical
 *    reply path.
 *  - Uses Gemini structured output (responseMimeType + responseSchema) so we
 *    never have to parse free-form text.
 *  - Fail-open: any error, timeout, or malformed response → `{ ok: true }`.
 *    Better to send the original draft than to stall the user.
 *  - One-shot only. No rewrite loops — caller applies `suggested` at most once
 *    and otherwise falls back to the original draft.
 */
import type { GoogleGenAI } from '@google/genai'
import { log } from '../observability/logger.js'
import { CRITIC_SYSTEM_PROMPT, buildCriticUserPrompt } from './prompt.js'
import type {
  CriticInput,
  CriticIssue,
  CriticIssueKind,
  CriticResult,
} from './types.js'

export interface CriticDeps {
  gemini: GoogleGenAI
  /** Override model — default gemini-2.5-flash. */
  model?: string
  /** Abort budget for a single review call, ms. Default 8000. */
  timeoutMs?: number
}

const DEFAULT_MODEL = 'gemini-2.5-flash'
const DEFAULT_TIMEOUT_MS = 8000
const MAX_SUGGESTED_LEN = 5000

const VALID_KINDS: ReadonlySet<CriticIssueKind> = new Set([
  'persona_mismatch',
  'fact_conflict',
  'leak',
  'length',
  'tone',
])

/**
 * JSON schema passed to Gemini as `responseSchema`. Mirrors CriticResult
 * minus `durationMs` (that's filled locally by the caller).
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['persona_mismatch', 'fact_conflict', 'leak', 'length', 'tone'],
          },
          detail: { type: 'string' },
        },
        required: ['kind', 'detail'],
      },
    },
    suggested: { type: 'string' },
  },
  required: ['ok', 'issues'],
} as const

export class Critic {
  constructor(private deps: CriticDeps) {}

  async review(input: CriticInput): Promise<CriticResult> {
    const t0 = Date.now()
    const model = this.deps.model ?? DEFAULT_MODEL
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const failOpen = (reason: string, extra?: Record<string, unknown>): CriticResult => {
      log().warn('critic: fail-open', {
        reason,
        ms: Date.now() - t0,
        draftLen: input.draftResponse.length,
        ...extra,
      })
      return { ok: true, issues: [], durationMs: Date.now() - t0 }
    }

    // Build payload
    const userPrompt = buildCriticUserPrompt({
      draftResponse: input.draftResponse,
      userMessage: input.userMessage,
      personaPrompt: input.personaPrompt,
      ownerFacts: input.ownerFacts,
      channel: input.channel,
    })

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)

    let rawText: string
    try {
      const resp: any = await this.deps.gemini.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        config: {
          systemInstruction: CRITIC_SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA as any,
          temperature: 0.1,
          maxOutputTokens: 2048,
          abortSignal: ac.signal,
        } as any,
      })
      rawText =
        (resp as any).text ??
        (resp as any).candidates?.[0]?.content?.parts?.[0]?.text ??
        ''
      rawText = String(rawText).trim()
    } catch (e) {
      clearTimeout(timer)
      const msg = e instanceof Error ? e.message : String(e)
      if (ac.signal.aborted) return failOpen('timeout', { timeoutMs })
      return failOpen('gemini_error', { error: msg })
    }
    clearTimeout(timer)

    if (!rawText) return failOpen('empty_response')

    let parsed: any
    try {
      parsed = JSON.parse(rawText)
    } catch {
      // Try to salvage JSON block
      const m = rawText.match(/\{[\s\S]*\}/)
      if (!m) return failOpen('invalid_json', { raw: rawText.slice(0, 200) })
      try {
        parsed = JSON.parse(m[0])
      } catch {
        return failOpen('invalid_json', { raw: rawText.slice(0, 200) })
      }
    }

    if (typeof parsed !== 'object' || parsed === null || typeof parsed.ok !== 'boolean') {
      return failOpen('shape_mismatch', { raw: rawText.slice(0, 200) })
    }

    const issues: CriticIssue[] = Array.isArray(parsed.issues)
      ? parsed.issues
          .filter(
            (it: any) =>
              it &&
              typeof it.kind === 'string' &&
              VALID_KINDS.has(it.kind) &&
              typeof it.detail === 'string',
          )
          .map((it: any) => ({ kind: it.kind as CriticIssueKind, detail: it.detail }))
      : []

    let suggested: string | undefined
    if (typeof parsed.suggested === 'string' && parsed.suggested.trim().length > 0) {
      suggested = parsed.suggested
    }

    const durationMs = Date.now() - t0
    log().info('critic: reviewed', {
      ok: parsed.ok,
      issueCount: issues.length,
      draftLen: input.draftResponse.length,
      suggestedLen: suggested?.length ?? 0,
      ms: durationMs,
    })

    return {
      ok: Boolean(parsed.ok),
      issues,
      suggested,
      durationMs,
    }
  }
}

/**
 * Helper used by the runner: decide whether a critic result should replace
 * the original draft. Encapsulates every guardrail (length limits, identity
 * check, empty suggestion) in one place so both tests and runner agree.
 */
export function shouldApplySuggestion(
  original: string,
  result: CriticResult,
): { apply: boolean; reason?: string } {
  if (result.ok) return { apply: false, reason: 'ok' }
  if (!result.suggested) return { apply: false, reason: 'no_suggestion' }
  const suggested = result.suggested
  if (suggested.length <= 10) return { apply: false, reason: 'suggested_too_short' }
  if (suggested.length > MAX_SUGGESTED_LEN)
    return { apply: false, reason: 'suggested_too_long' }
  if (suggested.trim() === original.trim())
    return { apply: false, reason: 'suggested_identical' }
  return { apply: true }
}
