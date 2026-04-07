// Wave 2A — LearnerAgent: the nightly self-improvement service.
//
// Orchestrates:
//   1. Pull the last 24h of conversation for a workspace.
//   2. Detect repeating patterns (pattern-detector).
//   3. For each pattern, generate a candidate skill YAML (skill-generator).
//   4. Deduplicate against existing candidates AND already-live skills.
//   5. Insert surviving candidates into bc_skill_candidates.
//
// The whole thing is defensive: a failure inside one workspace never leaks
// into another, and any single pattern failing to generate never crashes
// the whole run.
import type { Pool } from 'pg'
import { asAdmin } from '../db/rls.js'
import type { ConversationRepo } from '../memory/conversation-repo.js'
import type { SkillsRepo } from '../skills/repo.js'
import type { CandidatesRepo } from './candidates-repo.js'
import type { PatternDetectorLLM } from './pattern-detector.js'
import type { SkillGeneratorLLM } from './skill-generator.js'
import { detectPatterns } from './pattern-detector.js'
import { generateSkillFromPattern, SkillGenerationError } from './skill-generator.js'
import type { ConversationPattern } from './types.js'
import { log } from '../observability/logger.js'

const MIN_HISTORY = 10
const HISTORY_LIMIT = 500

export interface LearnerDeps {
  pool: Pool
  convRepo: ConversationRepo
  skillsRepo: SkillsRepo
  candidatesRepo: CandidatesRepo
  patternLLM: PatternDetectorLLM
  generatorLLM: SkillGeneratorLLM
  /** Names of tools the generator is allowed to reference. */
  availableTools: () => string[]
}

export interface LearnerRunResult {
  workspaceId: string
  messagesAnalysed: number
  patternsFound: number
  candidatesCreated: number
  candidatesSkipped: number
  errors: string[]
}

export class Learner {
  constructor(private deps: LearnerDeps) {}

  /**
   * Run the learner for a single workspace over the last `lookbackHours`.
   * Never throws; aggregates errors into the returned result.
   */
  async runForWorkspace(
    workspaceId: string,
    lookbackHours = 24,
  ): Promise<LearnerRunResult> {
    const result: LearnerRunResult = {
      workspaceId,
      messagesAnalysed: 0,
      patternsFound: 0,
      candidatesCreated: 0,
      candidatesSkipped: 0,
      errors: [],
    }

    try {
      // Best-effort: expire old candidates first so listPending stays clean.
      try {
        const expired = await this.deps.candidatesRepo.expireOld(workspaceId)
        if (expired > 0) {
          log().info('learner: expired old candidates', { workspaceId, expired })
        }
      } catch (e) {
        log().warn('learner: expireOld failed', {
          workspaceId,
          error: e instanceof Error ? e.message : String(e),
        })
      }

      const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000)
      const history = await this.deps.convRepo.listSince(
        workspaceId,
        since,
        HISTORY_LIMIT,
      )
      result.messagesAnalysed = history.length

      if (history.length < MIN_HISTORY) {
        log().info('learner: history too short, skipping', {
          workspaceId,
          size: history.length,
        })
        return result
      }

      let patterns: ConversationPattern[]
      try {
        patterns = await detectPatterns(history, this.deps.patternLLM)
      } catch (e) {
        result.errors.push(
          `detectPatterns: ${e instanceof Error ? e.message : String(e)}`,
        )
        return result
      }
      result.patternsFound = patterns.length
      if (patterns.length === 0) {
        log().info('learner: no patterns', { workspaceId })
        return result
      }

      // Snapshot existing names to dedupe against.
      const [existingCandidates, existingSkills] = await Promise.all([
        this.deps.candidatesRepo.list(workspaceId).catch(() => []),
        this.deps.skillsRepo.list(workspaceId).catch(() => []),
      ])
      const takenNames = new Set<string>([
        ...existingCandidates.map((c) => c.name.toLowerCase()),
        ...existingSkills.map((s) => s.name.toLowerCase()),
      ])

      const availableTools = this.deps.availableTools()

      for (const pattern of patterns) {
        try {
          const generated = await generateSkillFromPattern(
            pattern,
            this.deps.generatorLLM,
            availableTools,
          )
          const nameKey = generated.name.toLowerCase()
          if (takenNames.has(nameKey)) {
            log().info('learner: skipping duplicate candidate name', {
              workspaceId,
              name: generated.name,
            })
            result.candidatesSkipped += 1
            continue
          }
          await this.deps.candidatesRepo.insert(workspaceId, {
            name: generated.name,
            description: generated.description,
            yaml: generated.yaml,
            rationale: generated.rationale,
            sourcePattern: pattern as unknown as Record<string, unknown>,
          })
          takenNames.add(nameKey)
          result.candidatesCreated += 1
        } catch (e) {
          const msg =
            e instanceof SkillGenerationError
              ? e.message
              : e instanceof Error
                ? e.message
                : String(e)
          log().warn('learner: candidate generation failed, skipping', {
            workspaceId,
            pattern: pattern.description,
            error: msg,
          })
          result.errors.push(msg)
          result.candidatesSkipped += 1
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log().error('learner: unexpected error in workspace run', {
        workspaceId,
        error: msg,
      })
      result.errors.push(msg)
    }

    log().info('learner: workspace run done', { ...result })
    return result
  }

  /**
   * Enumerate every active workspace (bypassing RLS via asAdmin) and run
   * the learner for each.  Per-workspace failures are isolated.
   */
  async runNightly(): Promise<LearnerRunResult[]> {
    const ids = await asAdmin(this.deps.pool, async (c) => {
      const { rows } = await c.query(
        `select id from workspaces where status = 'active'`,
      )
      return rows.map((r: any) => r.id as string)
    })
    log().info('learner: nightly start', { workspaceCount: ids.length })
    const results: LearnerRunResult[] = []
    for (const id of ids) {
      try {
        results.push(await this.runForWorkspace(id))
      } catch (e) {
        log().error('learner: workspace run threw (should not happen)', {
          workspaceId: id,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    log().info('learner: nightly done', {
      workspaces: results.length,
      totalCandidates: results.reduce((a, r) => a + r.candidatesCreated, 0),
    })
    return results
  }

  /**
   * Register a nightly pg-boss cron.  Kept thin — callers can skip this if
   * they schedule via their own mechanism.
   */
  async registerCron(boss: {
    schedule: (queue: string, cron: string, data?: unknown) => Promise<void>
    work: (queue: string, handler: () => Promise<void>) => Promise<void>
  }): Promise<void> {
    const queue = 'learner:nightly'
    await boss.work(queue, async () => {
      await this.runNightly()
    })
    // 03:00 UTC every day.
    await boss.schedule(queue, '0 3 * * *')
    log().info('learner: cron registered', { queue })
  }
}
