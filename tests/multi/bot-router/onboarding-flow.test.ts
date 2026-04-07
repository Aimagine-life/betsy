import { describe, it, expect } from 'vitest'
import {
  nextOnboardingStep,
  parseOnboardingAnswer,
  ONBOARDING_STEPS,
  isOnboardingComplete,
} from '../../../src/multi/bot-router/onboarding-flow.js'

describe('onboarding FSM', () => {
  it('first step is name question', () => {
    const step = nextOnboardingStep({})
    expect(step?.key).toBe('name')
    expect(step?.question).toMatch(/как тебя зовут|name/i)
  })

  it('advances through 3 steps in order', () => {
    let profile: Record<string, unknown> = {}
    const seen: string[] = []
    for (let i = 0; i < 3; i++) {
      const s = nextOnboardingStep(profile)
      expect(s).not.toBeNull()
      seen.push(s!.key)
      profile = { ...profile, [s!.key]: 'x' }
    }
    expect(nextOnboardingStep(profile)).toBeNull()
    expect(seen).toEqual(['name', 'business_context', 'address_form'])
  })

  it('isOnboardingComplete returns true when all set', () => {
    expect(isOnboardingComplete({})).toBe(false)
    expect(isOnboardingComplete({ name: 'K' })).toBe(false)
    expect(
      isOnboardingComplete({
        name: 'K',
        business_context: 'builds AI',
        address_form: 'ty',
      }),
    ).toBe(true)
  })

  it('parseOnboardingAnswer normalizes address form from ty/вы', () => {
    const tyStep = ONBOARDING_STEPS.find((s) => s.key === 'address_form')!
    expect(parseOnboardingAnswer(tyStep, 'на ты')).toEqual({ address_form: 'ty' })
    expect(parseOnboardingAnswer(tyStep, 'на вы')).toEqual({ address_form: 'vy' })
    expect(parseOnboardingAnswer(tyStep, 'ты')).toEqual({ address_form: 'ty' })
    expect(parseOnboardingAnswer(tyStep, 'ВЫ')).toEqual({ address_form: 'vy' })
  })

  it('parseOnboardingAnswer trims text for name and business_context', () => {
    const nameStep = ONBOARDING_STEPS.find((s) => s.key === 'name')!
    expect(parseOnboardingAnswer(nameStep, '  Константин  ')).toEqual({
      name: 'Константин',
    })
  })
})
