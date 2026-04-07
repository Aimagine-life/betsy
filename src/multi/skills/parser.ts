// Wave 1C — Workspace skills: YAML parser + zod validation
import yaml from 'js-yaml'
import { z } from 'zod'
import type { WorkspaceSkill } from './types.js'

const stepSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal('tool'),
      tool: z.string().min(1),
      params: z.record(z.any()).default({}),
      saveAs: z.string().optional(),
    }),
    z.object({
      kind: z.literal('prompt'),
      prompt: z.string().min(1),
      saveAs: z.string().optional(),
    }),
    z.object({
      kind: z.literal('condition'),
      if: z.string().min(1),
      then: z.array(stepSchema),
      else: z.array(stepSchema).optional(),
    }),
    z.object({
      kind: z.literal('loop'),
      over: z.string().min(1),
      as: z.string().min(1),
      do: z.array(stepSchema),
    }),
  ]),
)

const triggerSchema = z.object({
  type: z.enum(['manual', 'cron', 'keyword', 'event']),
  cron: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  event: z.string().optional(),
})

const skillSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  trigger: triggerSchema,
  steps: z.array(stepSchema).min(1),
})

export class SkillParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'SkillParseError'
  }
}

/**
 * Parse a YAML document into a validated WorkspaceSkill.
 * Throws SkillParseError with a human-friendly message on any failure.
 */
export function parseSkillYaml(yamlText: string): WorkspaceSkill {
  if (typeof yamlText !== 'string' || yamlText.trim().length === 0) {
    throw new SkillParseError('skill YAML is empty')
  }
  let raw: unknown
  try {
    raw = yaml.load(yamlText, { schema: yaml.CORE_SCHEMA })
  } catch (e) {
    throw new SkillParseError(
      `invalid YAML: ${e instanceof Error ? e.message : String(e)}`,
      e,
    )
  }
  if (raw == null || typeof raw !== 'object') {
    throw new SkillParseError('skill YAML must be a mapping at the top level')
  }
  const parsed = skillSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
    throw new SkillParseError(`skill schema validation failed: ${issues}`)
  }
  // Cross-field checks
  const t = parsed.data.trigger
  if (t.type === 'cron' && !t.cron) {
    throw new SkillParseError('trigger.cron is required when trigger.type is "cron"')
  }
  if (t.type === 'keyword' && (!t.keywords || t.keywords.length === 0)) {
    throw new SkillParseError(
      'trigger.keywords must be non-empty when trigger.type is "keyword"',
    )
  }
  if (t.type === 'event' && !t.event) {
    throw new SkillParseError('trigger.event is required when trigger.type is "event"')
  }
  return parsed.data as WorkspaceSkill
}
