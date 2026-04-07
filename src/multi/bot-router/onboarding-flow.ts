export interface OnboardingStep {
  key: 'name' | 'business_context' | 'address_form'
  question: string
  buttons?: { id: string; label: string }[]
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    key: 'name',
    question: 'Привет! Я Betsy 👋 Как тебя зовут?',
  },
  {
    key: 'business_context',
    question:
      'Расскажи в двух словах, чем ты занимаешься — это поможет мне быть тебе полезной.',
  },
  {
    key: 'address_form',
    question: 'И последний вопрос: как удобнее — на «ты» или на «вы»?',
    buttons: [
      { id: 'addr:ty', label: 'На «ты»' },
      { id: 'addr:vy', label: 'На «вы»' },
    ],
  },
]

export function nextOnboardingStep(
  profile: Record<string, unknown>,
): OnboardingStep | null {
  for (const step of ONBOARDING_STEPS) {
    if (profile[step.key] == null || profile[step.key] === '') return step
  }
  return null
}

export function isOnboardingComplete(profile: Record<string, unknown>): boolean {
  return ONBOARDING_STEPS.every(
    (s) =>
      profile[s.key] !== null &&
      profile[s.key] !== undefined &&
      profile[s.key] !== '',
  )
}

export function parseOnboardingAnswer(
  step: OnboardingStep,
  answer: string,
): Record<string, string> {
  const trimmed = answer.trim()
  if (step.key === 'address_form') {
    const lower = trimmed.toLowerCase()
    if (lower.includes('ты')) return { address_form: 'ty' }
    if (lower.includes('вы')) return { address_form: 'vy' }
    return { address_form: 'ty' }
  }
  return { [step.key]: trimmed }
}
