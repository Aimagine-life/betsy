// Wave 2A — LearnerAgent: root-agent tools for inspecting and deciding
// on pending candidates.  The root agent calls these on behalf of the
// user; nothing here runs generated code automatically — approval is
// the only path from candidate to live skill.
import { z } from 'zod'
import type { MemoryTool } from '../agents/tools/memory-tools.js'
import type { CandidatesRepo } from './candidates-repo.js'

export interface LearnerToolsDeps {
  workspaceId: string
  candidatesRepo: CandidatesRepo
}

export function createLearnerTools(deps: LearnerToolsDeps): MemoryTool[] {
  const { workspaceId, candidatesRepo } = deps

  const listParams = z.object({})
  const listPending: MemoryTool = {
    name: 'list_skill_candidates',
    description:
      'Вернуть список предлагаемых LearnerAgent скилов, ждущих решения пользователя. Используй когда юзер спрашивает "что ты там предлагала автоматизировать?" или хочет посмотреть накопленные идеи.',
    parameters: listParams,
    async execute() {
      const rows = await candidatesRepo.listPending(workspaceId)
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        rationale: r.rationale,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
      }))
    },
  }

  const approveParams = z.object({
    id: z.string().min(1).describe('ID кандидата (из list_skill_candidates)'),
  })
  const approve: MemoryTool = {
    name: 'approve_skill_candidate',
    description:
      'Одобрить кандидат-скил — он промоутится в рабочие воркспейс-скилы и сразу становится активен. Вызывай ТОЛЬКО после явного согласия пользователя.',
    parameters: approveParams,
    async execute(params) {
      const { id } = approveParams.parse(params)
      try {
        const cand = await candidatesRepo.approve(workspaceId, id)
        return { ok: true, name: cand.name, status: cand.status }
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }
      }
    },
  }

  const rejectParams = z.object({
    id: z.string().min(1),
    reason: z.string().optional(),
  })
  const reject: MemoryTool = {
    name: 'reject_skill_candidate',
    description:
      'Отклонить предложенный кандидат-скил. Используй когда юзер говорит что не хочет такой скил.',
    parameters: rejectParams,
    async execute(params) {
      const { id, reason } = rejectParams.parse(params)
      const cand = await candidatesRepo.reject(workspaceId, id, reason)
      if (!cand) {
        return { ok: false, error: 'candidate not found or not pending' }
      }
      return { ok: true, name: cand.name, status: cand.status }
    },
  }

  return [listPending, approve, reject]
}
