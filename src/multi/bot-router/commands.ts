import type { Workspace, NotifyPref } from '../workspaces/types.js'
import type { WorkspaceRepo } from '../workspaces/repo.js'
import type { FactsRepo } from '../memory/facts-repo.js'
import type { LinkingService } from '../linking/service.js'

export interface CommandDeps {
  wsRepo: WorkspaceRepo
  factsRepo: FactsRepo
  linkingSvc: LinkingService
}

export interface CommandResult {
  text: string
}

function fmt(msg: string): CommandResult {
  return { text: msg }
}

export async function handleCommand(
  rawText: string,
  workspace: Workspace,
  deps: CommandDeps,
): Promise<CommandResult | null> {
  const text = rawText.trim()
  if (!text.startsWith('/')) return null

  const [cmd, ...args] = text.split(/\s+/)

  if (cmd === '/start') {
    return fmt(
      `Привет, ${workspace.displayName ?? 'друг'}! Я Betsy 👋\n\n` +
        `Напиши мне что-нибудь — я помню всё что ты мне рассказывал.\n\n` +
        `Команды: /help /status /plan /notify /link /forget /cancel`,
    )
  }

  if (cmd === '/help') {
    return fmt(
      `Что я умею:\n\n` +
        `• Просто общаться с тобой — помню, что ты рассказывал\n` +
        `• Ставить напоминания в удобный канал\n` +
        `• Искать в интернете через Google\n` +
        `• Присылать селфи по запросу\n\n` +
        `Команды:\n` +
        `/status — тариф и лимит токенов\n` +
        `/plan — сменить тариф\n` +
        `/notify [telegram|max|auto] — куда писать напоминания\n` +
        `/link — получить код для подключения второго канала\n` +
        `/forget confirm — очистить всю память о тебе\n` +
        `/cancel confirm — отменить подписку`,
    )
  }

  if (cmd === '/status') {
    const used = workspace.tokensUsedPeriod
    const limit = workspace.tokensLimitPeriod
    const pct = Math.min(100, Math.round((used / limit) * 100))
    const balance = (workspace.balanceKopecks / 100).toFixed(2)
    return fmt(
      `📊 Твой статус\n\n` +
        `Тариф: ${workspace.plan}\n` +
        `Статус: ${workspace.status}\n` +
        `Токены: ${used} / ${limit} (${pct}%)\n` +
        `Кошелёк: ${balance} ₽\n` +
        `Канал уведомлений: ${workspace.notifyChannelPref}`,
    )
  }

  if (cmd === '/plan') {
    return fmt(
      `💰 Тарифы\n\n` +
        `• Trial — 7 дней бесплатно\n` +
        `• Personal — 990 ₽/мес, 1M токенов\n` +
        `• Pro — 2490 ₽/мес, 3M токенов\n\n` +
        `Смена тарифа через кабинет: https://crew.betsyai.io`,
    )
  }

  if (cmd === '/notify') {
    const val = args[0]?.toLowerCase()
    if (!val) {
      return fmt(
        `🔔 Куда писать напоминания\n\nТекущее: ${workspace.notifyChannelPref}\n\n` +
          `Использование: /notify telegram, /notify max, или /notify auto`,
      )
    }
    if (val !== 'telegram' && val !== 'max' && val !== 'auto') {
      return fmt(
        `Не понимаю. Используй: /notify telegram, /notify max, или /notify auto`,
      )
    }
    await deps.wsRepo.updateNotifyPref(workspace.id, val as NotifyPref)
    return fmt(`✅ Теперь буду писать тебе в: ${val}`)
  }

  if (cmd === '/link') {
    try {
      const code = await deps.linkingSvc.generateCode(workspace.id)
      return fmt(
        `🔗 Код для связывания второго канала:\n\n` +
          `<b>${code}</b>\n\n` +
          `Открой Betsy в другом мессенджере (Telegram или MAX) и пришли этот код. ` +
          `Код действует 10 минут.`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('rate limit')) {
        return fmt(`⏳ Слишком много попыток. Подожди час и попробуй снова.`)
      }
      return fmt(`❌ Не получилось создать код. Попробуй позже.`)
    }
  }

  if (cmd === '/forget') {
    if (args[0]?.toLowerCase() !== 'confirm') {
      return fmt(
        `⚠️ Это удалит всё что я о тебе помню, навсегда.\n\n` +
          `Если уверен — напиши: /forget confirm`,
      )
    }
    await deps.factsRepo.forgetAll(workspace.id)
    return fmt(`✅ Я забыл всё о тебе. Начнём заново?`)
  }

  if (cmd === '/cancel') {
    if (args[0]?.toLowerCase() !== 'confirm') {
      return fmt(
        `⚠️ Отменить подписку? Доступ останется до конца оплаченного периода, ` +
          `память сохранится 6 месяцев на случай возврата.\n\n` +
          `Если уверен — напиши: /cancel confirm`,
      )
    }
    await deps.wsRepo.updateStatus(workspace.id, 'canceled')
    return fmt(
      `Подписка отменена. Доступ остался до конца периода. Если захочешь вернуться — просто напиши мне 💙`,
    )
  }

  return fmt(`Неизвестная команда: ${cmd}\nПопробуй /help`)
}
