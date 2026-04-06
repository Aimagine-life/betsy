export type VoiceMode = 'text_only' | 'voice_on_reply' | 'voice_always' | 'auto'
export type SelfieMode = 'never' | 'on_request' | 'special_moments' | 'auto'
export type VideoMode = 'never' | 'on_request' | 'auto'

export interface BehaviorConfig {
  voice: VoiceMode
  selfie: SelfieMode
  video: VideoMode
}

export interface Persona {
  id: string
  workspaceId: string
  presetId: string | null
  name: string
  gender: string | null
  voiceId: string
  personalityPrompt: string | null
  biography: string | null
  avatarS3Key: string | null
  referenceFrontS3Key: string | null
  referenceThreeQS3Key: string | null
  referenceProfileS3Key: string | null
  behaviorConfig: BehaviorConfig
  createdAt: Date
  updatedAt: Date
}

export const DEFAULT_BEHAVIOR: BehaviorConfig = {
  voice: 'auto',
  selfie: 'on_request',
  video: 'on_request',
}
