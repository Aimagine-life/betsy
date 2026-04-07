import { describe, it, expect } from 'vitest'
import { parseSkillYaml, SkillParseError } from '../../../src/multi/skills/parser.js'

describe('parseSkillYaml', () => {
  it('parses a minimal valid skill', () => {
    const yaml = `
name: hello
description: simple greet
trigger:
  type: manual
steps:
  - kind: prompt
    prompt: hi
`
    const skill = parseSkillYaml(yaml)
    expect(skill.name).toBe('hello')
    expect(skill.trigger.type).toBe('manual')
    expect(skill.steps).toHaveLength(1)
  })

  it('parses cron trigger and tool step', () => {
    const yaml = `
name: cron_skill
trigger:
  type: cron
  cron: "0 8 * * *"
steps:
  - kind: tool
    tool: remember
    params:
      kind: fact
      content: hello
`
    const skill = parseSkillYaml(yaml)
    expect(skill.trigger.cron).toBe('0 8 * * *')
    expect((skill.steps[0] as any).tool).toBe('remember')
  })

  it('parses nested condition + loop', () => {
    const yaml = `
name: nested
trigger:
  type: manual
steps:
  - kind: condition
    if: "vars.x == 1"
    then:
      - kind: loop
        over: "items"
        as: "item"
        do:
          - kind: prompt
            prompt: "{{item}}"
    else:
      - kind: prompt
        prompt: "no"
`
    const skill = parseSkillYaml(yaml)
    expect((skill.steps[0] as any).kind).toBe('condition')
  })

  it('rejects empty input', () => {
    expect(() => parseSkillYaml('')).toThrow(SkillParseError)
  })

  it('rejects invalid YAML', () => {
    expect(() => parseSkillYaml(': : :\n  - oops')).toThrow(SkillParseError)
  })

  it('rejects missing trigger', () => {
    const yaml = `
name: bad
steps:
  - kind: prompt
    prompt: x
`
    expect(() => parseSkillYaml(yaml)).toThrow(SkillParseError)
  })

  it('rejects cron trigger without cron expression', () => {
    const yaml = `
name: bad
trigger:
  type: cron
steps:
  - kind: prompt
    prompt: x
`
    expect(() => parseSkillYaml(yaml)).toThrow(/cron is required/)
  })

  it('rejects keyword trigger without keywords', () => {
    const yaml = `
name: bad
trigger:
  type: keyword
steps:
  - kind: prompt
    prompt: x
`
    expect(() => parseSkillYaml(yaml)).toThrow(/keywords/)
  })

  it('rejects unknown step kind', () => {
    const yaml = `
name: bad
trigger:
  type: manual
steps:
  - kind: explode
`
    expect(() => parseSkillYaml(yaml)).toThrow(SkillParseError)
  })

  it('parses cyrillic and emoji content', () => {
    const yaml = `
name: russian
description: Утренняя сводка 🌅
trigger:
  type: manual
steps:
  - kind: prompt
    prompt: "Доброе утро! 👋"
`
    const skill = parseSkillYaml(yaml)
    expect(skill.description).toContain('🌅')
    expect((skill.steps[0] as any).prompt).toContain('Доброе')
  })
})
