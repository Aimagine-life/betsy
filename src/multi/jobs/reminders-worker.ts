import type { ChannelAdapter, ChannelName } from '../channels/base.js'
import type { WorkspaceRepo } from '../workspaces/repo.js'
import type { RemindersRepo } from '../reminders/repo.js'
import { pickNotifyChannel } from '../notify/preferences.js'

export interface RemindersWorkerDeps {
  wsRepo: Pick<WorkspaceRepo, 'findById'>
  remindersRepo: Pick<RemindersRepo, 'listDuePending' | 'markFired'>
  channels: Partial<Record<ChannelName, ChannelAdapter>>
  resolveOwnerChatId: (
    workspace: { ownerTgId: number | null; ownerMaxId: number | null },
    channel: ChannelName,
  ) => string | null
}

export async function processPendingReminders(
  deps: RemindersWorkerDeps,
): Promise<number> {
  const due = await deps.remindersRepo.listDuePending(50)
  if (due.length === 0) return 0

  const available = Object.keys(deps.channels).filter(
    (k) => deps.channels[k as ChannelName] !== undefined,
  ) as ChannelName[]

  let processed = 0
  for (const r of due) {
    const workspace = await deps.wsRepo.findById(r.workspaceId)
    if (!workspace) continue

    const pick = pickNotifyChannel({
      workspace: {
        ownerTgId: workspace.ownerTgId,
        ownerMaxId: workspace.ownerMaxId,
        lastActiveChannel: workspace.lastActiveChannel as ChannelName | null,
        notifyChannelPref: workspace.notifyChannelPref as 'auto' | 'telegram' | 'max',
      },
      preferredChannel: r.preferredChannel as ChannelName,
      availableChannels: available,
    })

    if (!pick.channel) continue

    const adapter = deps.channels[pick.channel]
    if (!adapter) continue

    const chatId = deps.resolveOwnerChatId(workspace, pick.channel)
    if (!chatId) continue

    try {
      await adapter.sendMessage({
        chatId,
        text: `🔔 Напоминание: ${r.text}`,
      })
      await deps.remindersRepo.markFired(workspace.id, r.id)
      processed++
    } catch (e) {
      console.error(`[reminders-worker] failed to send ${r.id}:`, e)
    }
  }

  return processed
}

export interface RemindersWorker {
  start(): void
  stop(): Promise<void>
}

export function startRemindersWorker(
  deps: RemindersWorkerDeps,
  intervalMs: number,
): RemindersWorker {
  let stopping = false
  let timer: NodeJS.Timeout | null = null

  const tick = async () => {
    if (stopping) return
    try {
      await processPendingReminders(deps)
    } catch (e) {
      console.error('[reminders-worker] tick failed:', e)
    }
    if (!stopping) {
      timer = setTimeout(tick, intervalMs)
    }
  }

  return {
    start() {
      timer = setTimeout(tick, intervalMs)
    },
    async stop() {
      stopping = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
