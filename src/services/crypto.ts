import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

/** Derive a 32-byte key from the password hash string. */
function deriveKey(keyHex: string): Buffer {
  return createHash("sha256").update(keyHex).digest();
}

/** Encrypt plaintext. Returns base64 string: IV + ciphertext + authTag. */
export function encrypt(plaintext: string, keyHex: string): string {
  const key = deriveKey(keyHex);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

/** Decrypt base64 string back to plaintext. */
export function decrypt(encoded: string, keyHex: string): string {
  const key = deriveKey(keyHex);
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(buf.length - TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}
