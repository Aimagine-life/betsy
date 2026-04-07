import { z } from 'zod'
import type { GoogleGenAI } from '@google/genai'
import type { PersonaRepo } from '../../personas/repo.js'
import type { S3Storage } from '../../storage/s3.js'
import type { MemoryTool } from './memory-tools.js'
import {
  generateSelfie as realGenerateSelfie,
  type SelfieInput,
  type SelfieOutput,
} from '../../gemini/selfie.js'

export interface SelfieToolDeps {
  personaRepo: PersonaRepo
  s3: S3Storage
  gemini: GoogleGenAI
  workspaceId: string
  /** Inject for testability. Defaults to real Nano Banana 2 call. */
  generateFn?: (gemini: GoogleGenAI, input: SelfieInput) => Promise<SelfieOutput>
}

export function createSelfieTool(deps: SelfieToolDeps): MemoryTool {
  const { personaRepo, s3, gemini, workspaceId } = deps
  const generateFn = deps.generateFn ?? realGenerateSelfie

  const params = z.object({
    scene: z.string().min(3).max(500),
    aspect: z.enum(['3:4', '1:1', '9:16']).default('3:4'),
  })

  return {
    name: 'generate_selfie',
    description:
      'Сгенерировать селфи Betsy в указанной сцене. Используй когда юзер явно просит прислать фотку или когда уместно показать себя в конкретной обстановке.',
    parameters: params,
    async execute(input) {
      const parsed = params.parse(input)

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

      const references = await Promise.all(
        refKeys.map(async (key) => {
          const buf = await s3.download(key)
          return { base64: buf.toString('base64'), mimeType: 'image/png' }
        }),
      )

      const result = await generateFn(gemini, {
        references,
        personaName: persona.name,
        scene: parsed.scene,
        aspectRatio: parsed.aspect,
      })

      const ts = Date.now()
      const key = `workspaces/${workspaceId}/selfies/${ts}.png`
      await s3.upload(key, Buffer.from(result.imageBase64, 'base64'), result.mimeType)
      const url = await s3.signedUrl(key, 3600)

      return { success: true, image_url: url, s3_key: key }
    },
  }
}
