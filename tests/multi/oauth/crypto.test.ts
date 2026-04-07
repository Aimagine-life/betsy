import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  encryptSecret,
  decryptSecret,
  resetKeyCache,
  OAuthCryptoError,
} from '../../../src/multi/oauth/crypto.js'

const TEST_KEY_HEX = randomBytes(32).toString('hex')

describe('oauth crypto (AES-256-GCM)', () => {
  beforeEach(() => {
    vi.stubEnv('BC_OAUTH_ENC_KEY', TEST_KEY_HEX)
    resetKeyCache()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    resetKeyCache()
  })

  it('round-trips a simple string', () => {
    const plaintext = 'hello world'
    const blob = encryptSecret(plaintext)
    expect(decryptSecret(blob)).toBe(plaintext)
  })

  it('different plaintexts produce different blobs', () => {
    const a = encryptSecret('alpha')
    const b = encryptSecret('beta')
    expect(a).not.toBe(b)
  })

  it('same plaintext produces different blobs each time (random IV)', () => {
    const a = encryptSecret('same')
    const b = encryptSecret('same')
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe('same')
    expect(decryptSecret(b)).toBe('same')
  })

  it('handles cyrillic and emoji correctly', () => {
    const plaintext = 'Привет, мир! 🚀🔐 Бетси'
    const blob = encryptSecret(plaintext)
    expect(decryptSecret(blob)).toBe(plaintext)
  })

  it('handles a very long string (10 KB)', () => {
    const plaintext = 'x'.repeat(10_000)
    const blob = encryptSecret(plaintext)
    expect(decryptSecret(blob)).toBe(plaintext)
  })

  it('handles empty string', () => {
    const blob = encryptSecret('')
    expect(decryptSecret(blob)).toBe('')
  })

  it('throws FORMAT on a blob without v1: prefix', () => {
    expect(() => decryptSecret('not-a-valid-blob')).toThrow(OAuthCryptoError)
    try {
      decryptSecret('foo:bar:baz:qux')
    } catch (e) {
      expect((e as OAuthCryptoError).code).toBe('FORMAT')
    }
  })

  it('throws FORMAT on a blob with only 3 parts', () => {
    try {
      decryptSecret('v1:aaaa:bbbb')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthCryptoError)
      expect((e as OAuthCryptoError).code).toBe('FORMAT')
    }
  })

  it('throws AUTH on tampered ciphertext', () => {
    const blob = encryptSecret('secret-value')
    const parts = blob.split(':')
    // Flip a byte in the ciphertext
    const ct = Buffer.from(parts[3], 'base64')
    ct[0] ^= 0xff
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${ct.toString('base64')}`
    try {
      decryptSecret(tampered)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthCryptoError)
      expect((e as OAuthCryptoError).code).toBe('AUTH')
    }
  })

  it('throws AUTH when decrypting with a different key', () => {
    const blob = encryptSecret('top-secret')
    // Swap the key
    vi.stubEnv('BC_OAUTH_ENC_KEY', randomBytes(32).toString('hex'))
    resetKeyCache()
    try {
      decryptSecret(blob)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthCryptoError)
      expect((e as OAuthCryptoError).code).toBe('AUTH')
    }
  })

  it('throws KEY_MISSING when BC_OAUTH_ENC_KEY is not set', () => {
    vi.stubEnv('BC_OAUTH_ENC_KEY', '')
    resetKeyCache()
    try {
      encryptSecret('anything')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthCryptoError)
      expect((e as OAuthCryptoError).code).toBe('KEY_MISSING')
    }
  })

  it('throws KEY_LENGTH when key is wrong length (16 byte hex)', () => {
    vi.stubEnv('BC_OAUTH_ENC_KEY', randomBytes(16).toString('hex'))
    resetKeyCache()
    try {
      encryptSecret('anything')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthCryptoError)
      expect((e as OAuthCryptoError).code).toBe('KEY_LENGTH')
    }
  })

  it('accepts base64-encoded 32-byte key', () => {
    vi.stubEnv('BC_OAUTH_ENC_KEY', randomBytes(32).toString('base64'))
    resetKeyCache()
    const blob = encryptSecret('base64-keyed')
    expect(decryptSecret(blob)).toBe('base64-keyed')
  })

  it('trims surrounding whitespace in the key env var', () => {
    vi.stubEnv('BC_OAUTH_ENC_KEY', `  ${TEST_KEY_HEX}\n`)
    resetKeyCache()
    const blob = encryptSecret('trimmed')
    expect(decryptSecret(blob)).toBe('trimmed')
  })
})
