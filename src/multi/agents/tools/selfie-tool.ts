import { z } from 'zod'
import type { GoogleGenAI } from '@google/genai'
import type { PersonaRepo } from '../../personas/repo.js'
import type { S3Storage } from '../../storage/s3.js'
import type { FactsRepo } from '../../memory/facts-repo.js'
import type { FactKind } from '../../memory/types.js'
import type { MemoryTool } from './memory-tools.js'
import {
  generateSelfie as realGenerateSelfie,
  type SelfieInput,
  type SelfieOutput,
} from '../../gemini/selfie.js'
import { getGeminiImage, getGeminiImageFallback } from '../../gemini/client.js'
import { pushPendingMedia } from '../pending-media.js'
import { setChatAction, clearChatAction } from '../chat-action-state.js'
import { log } from '../../observability/logger.js'

export interface SelfieToolDeps {
  personaRepo: PersonaRepo
  s3: S3Storage
  /** Optional — when present, successful selfie generations are written as
   *  atomic facts so semantic memory can recall them later. */
  factsRepo?: FactsRepo
  gemini: GoogleGenAI
  workspaceId: string
  /** Inject for testability. Defaults to real Nano Banana 2 call. */
  generateFn?: (
    gemini: GoogleGenAI,
    input: SelfieInput,
    fallbackGemini?: GoogleGenAI,
  ) => Promise<SelfieOutput>
}

export function createSelfieTool(deps: SelfieToolDeps): MemoryTool {
  const { personaRepo, s3, factsRepo, workspaceId } = deps
  // Image-gen models live in us-central1; use the dedicated image client
  // built in gemini/client.ts. Falls back to the injected one for tests.
  const gemini = (() => {
    try {
      return getGeminiImage()
    } catch {
      return deps.gemini
    }
  })()
  const fallbackGemini = (() => {
    try {
      return getGeminiImageFallback()
    } catch {
      return undefined
    }
  })()
  const generateFn = deps.generateFn ?? realGenerateSelfie

  const params = z.object({
    // Allow empty/short scene — when forced via tool_config the model
    // may pass `""` because it has no context. We'll fall back to a
    // sensible default below.
    scene: z.string().max(500).optional(),
    aspect: z.enum(['3:4', '1:1', '9:16']).default('3:4'),
  })

  return {
    name: 'generate_selfie',
    description:
      'Сгенерировать селфи Betsy в указанной сцене. Используй когда юзер явно просит прислать фотку или когда уместно показать себя в конкретной обстановке.',
    parameters: params,
    async execute(input) {
      const raw = params.parse(input)
      // Default scene when forced calling passes nothing or a stub
      const scene =
        raw.scene && raw.scene.trim().length >= 3
          ? raw.scene.trim()
          : 'улыбается в камеру, естественный портрет, натуральный свет'
      const parsed = { scene, aspect: raw.aspect }

      const persona = await personaRepo.findByWorkspace(workspaceId)
      if (!persona) return { success: false, error: 'persona not found' }

      const refKeys = [
        persona.referenceFrontS3Key,
        persona.referenceThreeQS3Key,
        persona.referenceProfileS3Key,
      ].filter((k): k is string => typeof k === 'string' && k.length > 0)

      if (refKeys.length === 0) {
        return {
          success: false,
          error: 'no reference images — persona avatar not set up',
        }
      }

      // Reference images: still loaded from S3 (these are persistent persona
      // assets, not generated content). Only the GENERATED selfie skips S3.
      const references = await Promise.all(
        refKeys.map(async (key) => {
          const buf = await s3.download(key)
          return { base64: buf.toString('base64'), mimeType: 'image/png' }
        }),
      )

      // Switch the chat action indicator from "typing" to "upload_photo" while
      // the image is being generated. The typing loop in router.ts reads this
      // on its next tick. Always clear in finally.
      setChatAction(workspaceId, 'upload_photo')
      let result: SelfieOutput
      try {
        result = await generateFn(
          gemini,
          {
            references,
            personaName: persona.name,
            scene: parsed.scene,
            aspectRatio: parsed.aspect,
          },
          fallbackGemini,
        )
      } finally {
        clearChatAction(workspaceId)
      }

      // Stash binary in the per-workspace pending-media buffer. The router
      // drains it after the LLM turn ends and ships it to Telegram via
      // InputFile — no S3, no persistence.
      pushPendingMedia(workspaceId, {
        kind: 'photo',
        buffer: Buffer.from(result.imageBase64, 'base64'),
        mimeType: result.mimeType,
        caption: parsed.scene,
      })
      log().info('selfie: queued for delivery', { workspaceId, scene: parsed.scene })

      // Persist as atomic fact so semantic memory can recall it later
      // ("помнишь то фото в кафе?" → embedding hit on this fact).
      if (factsRepo) {
        try {
          const today = new Date().toISOString().slice(0, 10)
          await factsRepo.remember(workspaceId, {
            kind: 'event' as FactKind,
            content: `Прислала селфи пользователю: ${parsed.scene} (${today})`,
          })
        } catch (e) {
          log().warn('selfie: failed to persist fact', {
            workspaceId,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }

      // Return ONLY text-shaped data to the LLM. The bytes never enter the
      // conversation context. Future turns see this scene description in
      // tool history and understand "Бетси прислала селфи в кафе" without
      // costing image tokens.
      return {
        success: true,
        scene: parsed.scene,
        aspect: parsed.aspect,
        delivered: 'photo will be sent right after this message',
      }
    },
  }
}
