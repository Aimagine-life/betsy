import { describe, it, expect } from 'vitest'
import {
  generateSkillFromPattern,
  SkillGenerationError,
  type SkillGeneratorLLM,
} from '../../../src/multi/learner/skill-generator.js'
import type { ConversationPattern } from '../../../src/multi/learner/types.js'

const pattern: ConversationPattern = {
  description: 'morning weather brief',
  triggerExamples: ['погода', 'что по погоде'],
  toolSequence: ['recall', 'google_search'],
  frequency: 3,
  confidence: 0.9,
}

function fakeLLM(payload: unknown): SkillGeneratorLLM {
  return {
    async generateJson() {
      return JSON.stringify(payload)
    },
  }
}

const validYaml = `name: morning_weather
description: утренний прогноз
trigger:
  type: manual
steps:
  - kind: tool
    tool: google_search
    params:
      query: погода сегодня
`

describe('generateSkillFromPattern', () => {
  it('returns a candidate on happy path', async () => {
    const llm = fakeLLM({
      name: 'morning_weather',
      description: 'утренний прогноз',
      yaml: validYaml,
      rationale: 'юзер каждый день спрашивает погоду',
    })
    const out = await generateSkillFromPattern(pattern, llm, [
      'google_search',
      'recall',
    ])
    expect(out.name).toBe('morning_weather')
    expect(out.yaml).toContain('google_search')
    expect(out.rationale).toMatch(/юзер/)
  })

  it('throws when YAML is invalid', async () => {
    const llm = fakeLLM({
      name: 'bad',
      description: 'x',
      yaml: 'this is: [not valid skill yaml',
      rationale: '',
    })
    await expect(
      generateSkillFromPattern(pattern, llm, ['google_search']),
    ).rejects.toBeInstanceOf(SkillGenerationError)
  })

  it('throws when YAML references unknown tool', async () => {
    const yamlUnknownTool = `name: bad
trigger:
  type: manual
steps:
  - kind: tool
    tool: unknown_tool
    params: {}
`
    const llm = fakeLLM({
      name: 'bad',
      description: 'x',
      yaml: yamlUnknownTool,
      rationale: '',
    })
    await expect(
      generateSkillFromPattern(pattern, llm, ['google_search']),
    ).rejects.toThrow(/unknown tools/)
  })

  it('throws on non-JSON LLM response', async () => {
    const llm: SkillGeneratorLLM = {
      async generateJson() {
        return 'sorry, I cannot'
      },
    }
    await expect(
      generateSkillFromPattern(pattern, llm, []),
    ).rejects.toBeInstanceOf(SkillGenerationError)
  })

  it('throws when LLM throws', async () => {
    const llm: SkillGeneratorLLM = {
      async generateJson() {
        throw new Error('network')
      },
    }
    await expect(
      generateSkillFromPattern(pattern, llm, []),
    ).rejects.toBeInstanceOf(SkillGenerationError)
  })
})
