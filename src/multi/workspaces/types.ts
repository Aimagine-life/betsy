export type PlanType = 'trial' | 'personal' | 'pro' | 'canceled' | 'past_due'

export type WorkspaceStatus =
  | 'onboarding'
  | 'active'
  | 'canceled'
  | 'past_due'
  | 'deleted'

export type ChannelName = 'telegram' | 'max' | 'cabinet'

export type NotifyPref = 'auto' | 'telegram' | 'max'

export interface Workspace {
  id: string
  ownerTgId: number | null
  ownerMaxId: number | null
  displayName: string | null
  businessContext: string | null
  addressForm: 'ty' | 'vy'
  personaId: string
  plan: PlanType
  status: WorkspaceStatus
  tokensUsedPeriod: number
  tokensLimitPeriod: number
  periodResetAt: Date | null
  balanceKopecks: number
  lastActiveChannel: ChannelName | null
  notifyChannelPref: NotifyPref
  tz: string
  createdAt: Date
}
