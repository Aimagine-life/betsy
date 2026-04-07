/**
 * AES-256-GCM encryption for OAuth token storage.
 *
 * Uses only node:crypto — no external dependencies. Blob format is versioned
 * (`v1:iv:tag:ct`, all base64) so future algorithm migrations stay backward
 * compatible. Key is loaded lazily from BC_OAUTH_ENC_KEY so importing this
 * module never crashes; the error surfaces only on actual encrypt/decrypt.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12 // 96 bits — GCM recommendation
const TAG_LEN = 16
const KEY_ENV = 'BC_OAUTH_ENC_KEY'

export class OAuthCryptoError extends Error {
  constructor(
    msg: string,
    public readonly code: string,
  ) {
    super(msg)
    this.name = 'OAuthCryptoError'
  }
}

let cachedKey: Buffer | null = null

function loadKey(): Buffer {
  if (cachedKey) return cachedKey
  const rawEnv = process.env[KEY_ENV]
  if (!rawEnv) {
    throw new OAuthCryptoError(
      `${KEY_ENV} is not set. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      'KEY_MISSING',
    )
  }
  // Trim surrounding whitespace — copy/paste from shells often adds newlines.
  const raw = rawEnv.trim()
  if (raw.length === 0) {
    throw new OAuthCryptoError(`${KEY_ENV} is empty`, 'KEY_MISSING')
  }

  let key: Buffer
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex')
  } else {
    try {
      key = Buffer.from(raw, 'base64')
    } catch {
      throw new OAuthCryptoError('invalid key encoding (expected hex or base64)', 'KEY_FORMAT')
    }
  }

  if (key.length !== 32) {
    throw new OAuthCryptoError(`key must be 32 bytes, got ${key.length}`, 'KEY_LENGTH')
  }
  cachedKey = key
  return key
}

/** Reset the key cache. Exported ONLY for tests. */
export function resetKeyCache(): void {
  cachedKey = null
}

export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new OAuthCryptoError('plaintext must be string', 'INPUT')
  }
  const key = loadKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv) as CipherGCM
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
}

export function decryptSecret(blob: string): string {
  if (typeof blob !== 'string') {
    throw new OAuthCryptoError('blob must be string', 'INPUT')
  }
  const parts = blob.split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new OAuthCryptoError('invalid blob format', 'FORMAT')
  }
  const iv = Buffer.from(parts[1], 'base64')
  const tag = Buffer.from(parts[2], 'base64')
  const ct = Buffer.from(parts[3], 'base64')
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new OAuthCryptoError('invalid iv/tag length', 'FORMAT')
  }
  const key = loadKey()
  const decipher = createDecipheriv(ALGO, key, iv) as DecipherGCM
  decipher.setAuthTag(tag)
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return pt.toString('utf8')
  } catch {
    throw new OAuthCryptoError('decryption failed (wrong key or tampered ciphertext)', 'AUTH')
  }
}
