import type { Pool } from 'pg'
import { withWorkspace } from '../db/rls.js'
import { DEFAULT_BEHAVIOR, type BehaviorConfig, type Persona } from './types.js'

function rowToPersona(r: any): Persona {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    presetId: r.preset_id,
    name: r.name,
    gender: r.gender,
    voiceId: r.voice_id,
    personalityPrompt: r.personality_prompt,
    biography: r.biography,
    avatarS3Key: r.avatar_s3_key,
    referenceFrontS3Key: r.reference_front_s3_key,
    referenceThreeQS3Key: r.reference_three_q_s3_key,
    referenceProfileS3Key: r.reference_profile_s3_key,
    behaviorConfig: { ...DEFAULT_BEHAVIOR, ...(r.behavior_config ?? {}) },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface CreatePersonaInput {
  presetId?: string | null
  name: string
  gender?: string | null
  voiceId?: string
  personalityPrompt?: string | null
  biography?: string | null
  behaviorConfig?: BehaviorConfig
}

export class PersonaRepo {
  constructor(private pool: Pool) {}

  async create(workspaceId: string, input: CreatePersonaInput): Promise<Persona> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `insert into bc_personas
          (workspace_id, preset_id, name, gender, voice_id, personality_prompt, biography, behavior_config)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning *`,
        [
          workspaceId,
          input.presetId ?? null,
          input.name,
          input.gender ?? null,
          input.voiceId ?? 'Aoede',
          input.personalityPrompt ?? null,
          input.biography ?? null,
          JSON.stringify(input.behaviorConfig ?? DEFAULT_BEHAVIOR),
        ],
      )
      return rowToPersona(rows[0])
    })
  }

  async findById(workspaceId: string, id: string): Promise<Persona | null> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_personas where id = $1`,
        [id],
      )
      return rows[0] ? rowToPersona(rows[0]) : null
    })
  }

  async findByWorkspace(workspaceId: string): Promise<Persona | null> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_personas
         order by created_at desc
         limit 1`,
      )
      return rows[0] ? rowToPersona(rows[0]) : null
    })
  }

  async updateBehavior(
    workspaceId: string,
    id: string,
    behavior: BehaviorConfig,
  ): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(
        `update bc_personas
         set behavior_config = $2, updated_at = now()
         where id = $1`,
        [id, JSON.stringify(behavior)],
      )
    })
  }

  async updateAvatarKeys(
    workspaceId: string,
    id: string,
    keys: {
      avatarS3Key?: string | null
      referenceFrontS3Key?: string | null
      referenceThreeQS3Key?: string | null
      referenceProfileS3Key?: string | null
    },
  ): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(
        `update bc_personas
         set avatar_s3_key = coalesce($2, avatar_s3_key),
             reference_front_s3_key = coalesce($3, reference_front_s3_key),
             reference_three_q_s3_key = coalesce($4, reference_three_q_s3_key),
             reference_profile_s3_key = coalesce($5, reference_profile_s3_key),
             updated_at = now()
         where id = $1`,
        [
          id,
          keys.avatarS3Key ?? null,
          keys.referenceFrontS3Key ?? null,
          keys.referenceThreeQS3Key ?? null,
          keys.referenceProfileS3Key ?? null,
        ],
      )
    })
  }

  async updateText(
    workspaceId: string,
    id: string,
    fields: { name?: string; biography?: string; personalityPrompt?: string; voiceId?: string },
  ): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(
        `update bc_personas
         set name = coalesce($2, name),
             biography = coalesce($3, biography),
             personality_prompt = coalesce($4, personality_prompt),
             voice_id = coalesce($5, voice_id),
             updated_at = now()
         where id = $1`,
        [
          id,
          fields.name ?? null,
          fields.biography ?? null,
          fields.personalityPrompt ?? null,
          fields.voiceId ?? null,
        ],
      )
    })
  }
}
