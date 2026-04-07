/**
 * Per-workspace override for the Telegram "chat action" indicator.
 * While the default typing loop is running, tools can temporarily switch
 * the indicator to "upload_photo", "upload_video", etc. by setting an
 * override here. The router's typing loop reads this on each tick.
 */

export type ChatAction =
  | 'typing'
  | 'upload_photo'
  | 'upload_video'
  | 'upload_voice'
  | 'record_voice'

const overrides = new Map<string, ChatAction>()

export function setChatAction(workspaceId: string, action: ChatAction): void {
  overrides.set(workspaceId, action)
}

export function getChatAction(workspaceId: string): ChatAction {
  return overrides.get(workspaceId) ?? 'typing'
}

export function clearChatAction(workspaceId: string): void {
  overrides.delete(workspaceId)
}
