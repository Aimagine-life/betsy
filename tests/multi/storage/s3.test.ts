import { describe, it, expect } from 'vitest'
import { buildWorkspaceKey, buildPersonaKey } from '../../../src/multi/storage/s3.js'

describe('buildWorkspaceKey', () => {
  it('prefixes with workspaces/<id>/', () => {
    expect(buildWorkspaceKey('abc', 'selfies/photo.png')).toBe(
      'workspaces/abc/selfies/photo.png',
    )
  })

  it('strips leading slash from suffix', () => {
    expect(buildWorkspaceKey('abc', '/selfies/photo.png')).toBe(
      'workspaces/abc/selfies/photo.png',
    )
  })
})

describe('buildPersonaKey', () => {
  it('builds reference_front key', () => {
    expect(buildPersonaKey('abc', 'reference_front.png')).toBe(
      'workspaces/abc/persona/reference_front.png',
    )
  })
})
