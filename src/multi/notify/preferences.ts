import type { ChannelName } from '../channels/base.js'

export interface NotifyWorkspace {
  ownerTgId: number | null
  ownerMaxId: number | null
  lastActiveChannel: ChannelName | null
  notifyChannelPref: 'auto' | 'telegram' | 'max'
}

export interface PickInput {
  workspace: NotifyWorkspace
  preferredChannel: ChannelName
  availableChannels: ChannelName[]
}

export type PickReason =
  | 'user_override'
  | 'preferred_at_creation'
  | 'last_active'
  | 'any_available'
  | 'no_channels'

export interface PickResult {
  channel: ChannelName | null
  reason: PickReason
}

function ownerHasChannel(ws: NotifyWorkspace, channel: ChannelName): boolean {
  if (channel === 'telegram') return ws.ownerTgId !== null
  if (channel === 'max') return ws.ownerMaxId !== null
  return false
}

function isReady(
  ws: NotifyWorkspace,
  channel: ChannelName,
  available: ChannelName[],
): boolean {
  return ownerHasChannel(ws, channel) && available.includes(channel)
}

export function pickNotifyChannel(input: PickInput): PickResult {
  const { workspace, preferredChannel, availableChannels } = input

  // Rule 1: explicit user override
  if (workspace.notifyChannelPref !== 'auto') {
    if (isReady(workspace, workspace.notifyChannelPref, availableChannels)) {
      return { channel: workspace.notifyChannelPref, reason: 'user_override' }
    }
    // override unavailable — fall through to automatic rules
  }

  // Rule 2: preferred_channel (stored at creation) if available
  if (isReady(workspace, preferredChannel, availableChannels)) {
    return { channel: preferredChannel, reason: 'preferred_at_creation' }
  }

  // Rule 3: last_active_channel
  if (
    workspace.lastActiveChannel &&
    isReady(workspace, workspace.lastActiveChannel, availableChannels)
  ) {
    return { channel: workspace.lastActiveChannel, reason: 'last_active' }
  }

  // Rule 4: any available channel where owner has contact
  for (const channel of availableChannels) {
    if (ownerHasChannel(workspace, channel)) {
      return { channel, reason: 'any_available' }
    }
  }

  return { channel: null, reason: 'no_channels' }
}
