import type { InboundEvent, ChannelAdapter, ChannelName } from '../channels/base.js'
import type { WorkspaceRepo } from '../workspaces/repo.js'
import type { PersonaRepo } from '../personas/repo.js'
import type { FactsRepo } from '../memory/facts-repo.js'
import type { LinkingService } from '../linking/service.js'
import type { runBetsy as runBetsyType, RunBetsyDeps } from '../agents/runner.js'
import {
  nextOnboardingStep,
  parseOnboardingAnswer,
  isOnboardingComplete,
} from './onboarding-flow.js'
import { handleCommand } from './commands.js'

export interface BotRouterDeps {
  wsRepo: WorkspaceRepo
  personaRepo: PersonaRepo
  factsRepo: FactsRepo
  linkingSvc: LinkingService
  channels: Partial<Record<ChannelName, ChannelAdapter>>
  runBetsyFn: typeof runBetsyType
  runBetsyDeps: RunBetsyDeps
}

const LINK_CODE_RE = /^\s*(\d{6})\s*$/

export class BotRouter {
  constructor(private deps: BotRouterDeps) {}

  attach(): void {
    for (const adapter of Object.values(this.deps.channels)) {
      if (!adapter) continue
      adapter.onMessage((ev) => this.handleInbound(ev))
    }
  }

  async handleInbound(ev: InboundEvent): Promise<void> {
    const channel = this.deps.channels[ev.channel]
    if (!channel) return

    // Resolve workspace
    const workspace =
      ev.channel === 'telegram'
        ? await this.deps.wsRepo.upsertForTelegram(Number(ev.userId))
        : await this.deps.wsRepo.upsertForMax(Number(ev.userId))

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

    // Onboarding
    if (workspace.status === 'onboarding' || !isOnboardingComplete(workspaceToProfile(workspace))) {
      await this.handleOnboarding(ev, workspace, channel)
      return
    }

    // Commands
    if (ev.text.startsWith('/')) {
      const result = await handleCommand(ev.text, workspace as any, {
        wsRepo: this.deps.wsRepo,
        factsRepo: this.deps.factsRepo,
        linkingSvc: this.deps.linkingSvc,
      })
      if (result) {
        await channel.sendMessage({ chatId: ev.chatId, text: result.text })
        return
      }
    }

    // Normal message → runBetsy
    const response = await this.deps.runBetsyFn({
      workspaceId: workspace.id,
      userMessage: ev.text,
      channel: ev.channel,
      deps: this.deps.runBetsyDeps,
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
