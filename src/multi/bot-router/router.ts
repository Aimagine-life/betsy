import type { InboundEvent, ChannelAdapter, ChannelName } from '../channels/base.js'
import type { WorkspaceRepo } from '../workspaces/repo.js'
import type { PersonaRepo } from '../personas/repo.js'
import type { FactsRepo } from '../memory/facts-repo.js'
import type { ConversationRepo } from '../memory/conversation-repo.js'
import type { LinkingService } from '../linking/service.js'
import type {
  runBetsy as runBetsyType,
  runBetsyStream as runBetsyStreamType,
  RunBetsyDeps,
} from '../agents/runner.js'
import {
  nextOnboardingStep,
  parseOnboardingAnswer,
  isOnboardingComplete,
} from './onboarding-flow.js'
import { handleCommand } from './commands.js'
import { log } from '../observability/logger.js'

export interface BotRouterDeps {
  wsRepo: WorkspaceRepo
  personaRepo: PersonaRepo
  factsRepo: FactsRepo
  convRepo?: ConversationRepo
  linkingSvc: LinkingService
  channels: Partial<Record<ChannelName, ChannelAdapter>>
  runBetsyFn: typeof runBetsyType
  /** Optional streaming variant; when present and the channel supports
   *  streamMessage, used in preference to runBetsyFn for normal messages. */
  runBetsyStreamFn?: typeof runBetsyStreamType
  runBetsyDeps: RunBetsyDeps
}

const LINK_CODE_RE = /^\s*(\d{6})\s*$/

function startTypingLoop(channel: ChannelAdapter, chatId: string): () => void {
  if (!channel.sendTyping) return () => {}
  let stopped = false
  const tick = async () => {
    if (stopped) return
    try {
      await channel.sendTyping!(chatId)
    } catch {
      // ignore
    }
  }
  void tick()
  const interval = setInterval(tick, 4000)
  return () => {
    stopped = true
    clearInterval(interval)
  }
}

export class BotRouter {
  constructor(private deps: BotRouterDeps) {}

  attach(): void {
    for (const adapter of Object.values(this.deps.channels)) {
      if (!adapter) continue
      adapter.onMessage((ev) => this.handleInbound(ev))
    }
  }

  async handleInbound(ev: InboundEvent): Promise<void> {
    log().info('inbound received', {
      channel: ev.channel,
      userId: String(ev.userId),
      chatId: String(ev.chatId),
      textLen: ev.text?.length ?? 0,
      hasVoice: Boolean((ev as any).voice),
    })
    try {
      const channel = this.deps.channels[ev.channel]
      if (!channel) {
        log().warn('inbound: no channel adapter', { channel: ev.channel })
        return
      }

      // Resolve workspace
      const workspace =
        ev.channel === 'telegram'
          ? await this.deps.wsRepo.upsertForTelegram(Number(ev.userId))
          : await this.deps.wsRepo.upsertForMax(Number(ev.userId))

      log().info('workspace resolved', {
        workspaceId: workspace.id,
        status: workspace.status,
        displayName: workspace.displayName,
      })

      await this.deps.wsRepo.updateLastActiveChannel(workspace.id, ev.channel)

      // Try link code match
      const linkMatch = ev.text.match(LINK_CODE_RE)
      if (linkMatch && workspace.status !== 'onboarding') {
        const result = await this.deps.linkingSvc.verifyAndLink(linkMatch[1], {
          fromChannel: ev.channel,
          newChannelUserId: Number(ev.userId),
        })
        if (result.success) {
          await channel.sendMessage({
            chatId: ev.chatId,
            text: `✅ Канал ${ev.channel} подключён! Теперь мы с тобой на связи и здесь тоже 💙`,
          })
          return
        } else if (result.reason === 'invalid_or_expired') {
          // silently fall through — maybe user just sent a 6-digit number
        } else {
          await channel.sendMessage({
            chatId: ev.chatId,
            text: `⚠️ Не получилось связать: ${result.reason}`,
          })
          return
        }
      }

      // Commands for active workspace go through commands handler
      // (onboarding flow has its own / handling and shouldn't intercept commands here)
      if (ev.text.startsWith('/') && workspace.status !== 'onboarding') {
        log().info('routing: command (active)', { workspaceId: workspace.id, cmd: ev.text.split(' ')[0] })
        const result = await handleCommand(ev.text, workspace as any, {
          wsRepo: this.deps.wsRepo,
          factsRepo: this.deps.factsRepo,
          convRepo: this.deps.convRepo,
          linkingSvc: this.deps.linkingSvc,
        })
        if (result) {
          await channel.sendMessage({ chatId: ev.chatId, text: result.text })
          return
        }
      }

      // Onboarding only when status is explicitly 'onboarding'.
      // Trust the workspace status — if active, onboarding is done.
      if (workspace.status === 'onboarding') {
        log().info('routing: onboarding', { workspaceId: workspace.id })
        await this.handleOnboarding(ev, workspace, channel)
        return
      }

      // Normal message → runBetsy. Prefer streaming path when:
      //  - the channel adapter supports streamMessage,
      //  - the streaming runner is wired in,
      //  - the persona is NOT in voice_always mode (voice needs full text up front).
      const persona = await this.deps.personaRepo.findByWorkspace(workspace.id)
      const voiceAlways = persona?.behaviorConfig?.voice === 'voice_always'
      const canStream = Boolean(
        channel.streamMessage && this.deps.runBetsyStreamFn && !voiceAlways,
      )

      if (canStream) {
        log().info('routing: runBetsyStream', { workspaceId: workspace.id })
        const stopTyping = startTypingLoop(channel, ev.chatId)
        try {
          const { textStream, done } = await this.deps.runBetsyStreamFn!({
            workspaceId: workspace.id,
            userMessage: ev.text,
            channel: ev.channel,
            deps: this.deps.runBetsyDeps,
          })
          await channel.streamMessage!({ chatId: ev.chatId, textStream })
          const result = await done
          log().info('runBetsyStream returned', {
            workspaceId: workspace.id,
            textLen: result.text?.length ?? 0,
            toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
          })
        } finally {
          stopTyping()
        }
      } else {
        log().info('routing: runBetsy', { workspaceId: workspace.id })
        const stopTyping = startTypingLoop(channel, ev.chatId)
        let response
        try {
          response = await this.deps.runBetsyFn({
            workspaceId: workspace.id,
            userMessage: ev.text,
            channel: ev.channel,
            deps: this.deps.runBetsyDeps,
          })
        } finally {
          stopTyping()
        }
        log().info('runBetsy returned', {
          workspaceId: workspace.id,
          textLen: response.text?.length ?? 0,
          hasAudio: Boolean(response.audio),
          toolCalls: Array.isArray(response.toolCalls) ? response.toolCalls.length : 0,
        })

        await channel.sendMessage({
          chatId: ev.chatId,
          text: response.text,
          audio: response.audio && {
            base64: response.audio.base64,
            mimeType: response.audio.mimeType,
          },
        })
      }
      log().info('inbound: response sent', { workspaceId: workspace.id })
    } catch (err) {
      log().error('inbound failed', {
        channel: ev.channel,
        userId: String(ev.userId),
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      })
      // Best-effort user notification
      try {
        const ch = this.deps.channels[ev.channel]
        if (ch) {
          await ch.sendMessage({
            chatId: ev.chatId,
            text: 'Ой, у меня сейчас сбой. Я уже разбираюсь, попробуй ещё раз через минуту 💙',
          })
        }
      } catch (notifyErr) {
        log().error('inbound: failed to notify user about error', {
          error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        })
      }
    }
  }

  private async handleOnboarding(
    ev: InboundEvent,
    workspace: { id: string; displayName: string | null; businessContext: string | null; addressForm: string },
    channel: ChannelAdapter,
  ): Promise<void> {
    const profile = workspaceToProfile(workspace)

    if (ev.text.trim() && !ev.text.startsWith('/')) {
      // Store answer for current step
      const currentStep = nextOnboardingStep(profile)
      if (currentStep) {
        const patch = parseOnboardingAnswer(currentStep, ev.text)
        const value = patch[currentStep.key]
        if (currentStep.key === 'name' && typeof value === 'string') {
          await this.deps.wsRepo.updateDisplayName(workspace.id, value)
          profile.name = value
        } else if (currentStep.key === 'business_context' && typeof value === 'string') {
          await this.deps.wsRepo.updateBusinessContext(workspace.id, value)
          profile.business_context = value
        } else if (currentStep.key === 'address_form') {
          await this.deps.wsRepo.updateStatus(workspace.id, 'onboarding')
          profile.address_form = value
        }
      }
    }

    const next = nextOnboardingStep(profile)
    if (next) {
      await channel.sendMessage({ chatId: ev.chatId, text: next.question })
      return
    }

    // Onboarding complete — ensure persona exists, activate workspace
    const existing = await this.deps.personaRepo.findByWorkspace(workspace.id)
    if (!existing) {
      await this.deps.personaRepo.create(workspace.id, {
        presetId: 'betsy',
        name: 'Betsy',
        gender: 'female',
        voiceId: 'Aoede',
      })
    }
    await this.deps.wsRepo.updateStatus(workspace.id, 'active')

    await channel.sendMessage({
      chatId: ev.chatId,
      text:
        `Приятно познакомиться, ${profile.name}! 💙\n\n` +
        `Теперь я буду здесь — можешь писать мне что угодно. Я запомню важное.\n\n` +
        `Подробнее: /help`,
    })
  }
}

function workspaceToProfile(ws: {
  displayName: string | null
  businessContext: string | null
  addressForm: string
}): Record<string, unknown> {
  return {
    name: ws.displayName,
    business_context: ws.businessContext,
    address_form: ws.addressForm,
  }
}
