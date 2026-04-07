// Wave 2A — LearnerAgent: candidate persistence (bc_skill_candidates).
//
// All access goes through withWorkspace() so Postgres RLS enforces tenant
// isolation.  Approving a candidate is transactional: the candidate row is
// marked approved AND the YAML is upserted into bc_workspace_skills within
// the same DB session.
import type { Pool, PoolClient } from 'pg'
import { withWorkspace } from '../db/rls.js'
import { SkillsRepo } from '../skills/repo.js'
import { parseSkillYaml } from '../skills/parser.js'
import type { SkillCandidate, SkillCandidateStatus } from './types.js'
import { log } from '../observability/logger.js'

function rowToCandidate(r: any): SkillCandidate {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    description: r.description,
    yaml: r.yaml,
    rationale: r.rationale ?? '',
    sourcePattern: r.source_pattern ?? null,
    status: r.status as SkillCandidateStatus,
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? null,
    expiresAt: r.expires_at,
  }
}

export interface InsertCandidateInput {
  name: string
  description: string
  yaml: string
  rationale: string
  sourcePattern?: unknown
}

export class CandidatesRepo {
  constructor(private pool: Pool) {}

  async list(workspaceId: string): Promise<SkillCandidate[]> {
    return withWorkspace(this.pool, workspaceId, async (c) => {
      const { rows } = await c.query(
        `select * from bc_skill_candidates order by created_at desc`,
      )
      return rows.map(rowToCandidate)
    })
  }

  async listPending(workspaceId: string): Promise<SkillCandidate[]> {
    return withWorkspace(this.pool, workspaceId, async (c) => {
      const { rows } = await c.query(
        `select * from bc_skill_candidates
          where status = 'pending'
            and expires_at > now()
          order by created_at desc`,
      )
      return rows.map(rowToCandidate)
    })
  }

  async get(workspaceId: string, id: string): Promise<SkillCandidate | null> {
    return withWorkspace(this.pool, workspaceId, async (c) => {
      const { rows } = await c.query(
        `select * from bc_skill_candidates where id = $1`,
        [id],
      )
      return rows[0] ? rowToCandidate(rows[0]) : null
    })
  }

  async getByName(
    workspaceId: string,
    name: string,
  ): Promise<SkillCandidate | null> {
    return withWorkspace(this.pool, workspaceId, async (c) => {
      const { rows } = await c.query(
        `select * from bc_skill_candidates where name = $1`,
        [name],
      )
      return rows[0] ? rowToCandidate(rows[0]) : null
    })
  }

  async insert(
    workspaceId: string,
    input: InsertCandidateInput,
  ): Promise<SkillCandidate> {
    return withWorkspace(this.pool, workspaceId, async (c) => {
      const { rows } = await c.query(
        `insert into bc_skill_candidates
           (workspace_id, name, description, yaml, rationale, source_pattern)
         values ($1, $2, $3, $4, $5, $6)
         returning *`,
        [
          workspaceId,
          input.name,
          input.description,
          input.yaml,
          input.rationale,
          input.sourcePattern != null ? JSON.stringify(input.sourcePattern) : null,
        ],
      )
      return rowToCandidate(rows[0])
    })
  }

  /**
   * Approve a candidate: mark it approved AND promote it into
   * bc_workspace_skills.  Uses a single RLS session (no nested
   * withWorkspace) so the whole thing is one transaction.
   */
  async approve(workspaceId: string, id: string): Promise<SkillCandidate> {
    return withWorkspace(this.pool, workspaceId, async (c) => {
      await c.query('begin')
      try {
        const { rows } = await c.query(
          `update bc_skill_candidates
              set status = 'approved', decided_at = now()
            where id = $1 and status = 'pending'
            returning *`,
          [id],
        )
        if (rows.length === 0) {
          throw new Error(`candidate ${id} not found or not pending`)
        }
        const cand = rowToCandidate(rows[0])

        // Validate YAML one more time so we don't promote garbage even if
        // something got edited directly in the DB.
        const skill = parseSkillYaml(cand.yaml)

        await upsertSkillInClient(c, workspaceId, {
          name: skill.name,
          description: skill.description,
          yaml: cand.yaml,
          triggerType: skill.trigger.type,
          triggerConfig: {
            cron: skill.trigger.cron,
            keywords: skill.trigger.keywords,
            event: skill.trigger.event,
          },
          enabled: true,
          createdBy: 'learner',
        })

        await c.query('commit')
        log().info('learner.candidates: approved', {
          workspaceId,
          id,
          name: cand.name,
        })
        return cand
      } catch (e) {
        await c.query('rollback')
        throw e
      }
    })
  }

  async reject(
    workspaceId: string,
    id: string,
    _reason?: string,
  ): Promise<SkillCandidate | null> {
    return withWorkspace(this.pool, workspaceId, async (c) => {
      const { rows } = await c.query(
        `update bc_skill_candidates
            set status = 'rejected', decided_at = now()
          where id = $1 and status = 'pending'
          returning *`,
        [id],
      )
      return rows[0] ? rowToCandidate(rows[0]) : null
    })
  }

  /**
   * Expire pending candidates past their expires_at. Returns count expired.
   * Run periodically (e.g. alongside the nightly learner pass).
   */
  async expireOld(workspaceId: string): Promise<number> {
    return withWorkspace(this.pool, workspaceId, async (c) => {
      const res = await c.query(
        `update bc_skill_candidates
            set status = 'expired', decided_at = now()
          where status = 'pending' and expires_at <= now()`,
      )
      return res.rowCount ?? 0
    })
  }
}

/**
 * Inline upsert that uses an already-open client (needed because approve()
 * wraps two statements in a single transaction inside withWorkspace).
 * Mirrors SkillsRepo.upsert exactly.
 */
async function upsertSkillInClient(
  client: PoolClient,
  workspaceId: string,
  input: {
    name: string
    description?: string
    yaml: string
    triggerType: string
    triggerConfig: Record<string, any>
    enabled: boolean
    createdBy: string
  },
): Promise<void> {
  await client.query(
    `insert into bc_workspace_skills
       (workspace_id, name, description, yaml, trigger_type, trigger_config, enabled, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (workspace_id, name) do update set
       description    = excluded.description,
       yaml           = excluded.yaml,
       trigger_type   = excluded.trigger_type,
       trigger_config = excluded.trigger_config,
       enabled        = excluded.enabled,
       updated_at     = now()`,
    [
      workspaceId,
      input.name,
      input.description ?? null,
      input.yaml,
      input.triggerType,
      input.triggerConfig,
      input.enabled,
      input.createdBy,
    ],
  )
}

// Silence unused warning for SkillsRepo import — kept for documentation of the
// shape we mirror; may be used in a future cross-reference check.
void SkillsRepo
