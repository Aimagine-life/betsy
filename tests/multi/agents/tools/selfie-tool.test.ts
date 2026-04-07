import { describe, it, expect, vi } from 'vitest'
import { createSelfieTool } from '../../../../src/multi/agents/tools/selfie-tool.js'

function mockDeps() {
  const personaRepo = {
    findByWorkspace: vi.fn().mockResolvedValue({
      id: 'p1',
      name: 'Betsy',
      referenceFrontS3Key: 'ws/x/ref_front.png',
      referenceThreeQS3Key: 'ws/x/ref_threeq.png',
      referenceProfileS3Key: 'ws/x/ref_profile.png',
    }),
  }
  const s3 = {
    download: vi.fn().mockResolvedValue(Buffer.from('fake-ref')),
    upload: vi.fn().mockResolvedValue('workspaces/ws1/selfies/abc.png'),
    signedUrl: vi.fn().mockResolvedValue('https://signed/url'),
  }
  const gemini = {} as any
  const generateSelfieFn = vi.fn().mockResolvedValue({
    imageBase64: Buffer.from('fake-png').toString('base64'),
    mimeType: 'image/png',
  })
  return { personaRepo, s3, gemini, generateSelfieFn }
}

describe('createSelfieTool', () => {
  it('generates selfie and returns presigned URL', async () => {
    const deps = mockDeps()
    const tool = createSelfieTool({
      personaRepo: deps.personaRepo as any,
      s3: deps.s3 as any,
      gemini: deps.gemini,
      workspaceId: 'ws1',
      generateFn: deps.generateSelfieFn,
    })
    const result = await tool.execute({ scene: 'в кафе', aspect: '3:4' })
    expect((result as any).success).toBe(true)
    expect((result as any).image_url).toBe('https://signed/url')
    expect(deps.s3.download).toHaveBeenCalledTimes(3)
    expect(deps.generateSelfieFn).toHaveBeenCalled()
    expect(deps.s3.upload).toHaveBeenCalled()
  })

  it('returns error when persona has no reference images', async () => {
    const deps = mockDeps()
    deps.personaRepo.findByWorkspace.mockResolvedValue({
      id: 'p1',
      name: 'Betsy',
      referenceFrontS3Key: null,
      referenceThreeQS3Key: null,
      referenceProfileS3Key: null,
    })
    const tool = createSelfieTool({
      personaRepo: deps.personaRepo as any,
      s3: deps.s3 as any,
      gemini: deps.gemini,
      workspaceId: 'ws1',
      generateFn: deps.generateSelfieFn,
    })
    const result = await tool.execute({ scene: 'в кафе', aspect: '3:4' })
    expect((result as any).success).toBe(false)
    expect(deps.generateSelfieFn).not.toHaveBeenCalled()
  })
})
