import {
  randomBytes,
  pbkdf2Sync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = "sha512";
const AES_ALGORITHM = "aes-256-gcm";
const AES_KEY_LEN = 32;
const AES_IV_LEN = 12;
const AES_TAG_LEN = 16;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEYLEN,
    PBKDF2_DIGEST,
  );
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEYLEN,
    PBKDF2_DIGEST,
  );
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, AES_KEY_LEN, PBKDF2_DIGEST);
}

export function encrypt(plaintext: string, password: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(AES_IV_LEN);
  const key = deriveKey(password, salt);

  const cipher = createCipheriv(AES_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const payload = Buffer.concat([salt, iv, tag, encrypted]).toString("base64");
  return `encrypted:${payload}`;
}

export function decrypt(ciphertext: string, password: string): string {
  if (!ciphertext.startsWith("encrypted:")) {
    throw new Error("Invalid encrypted string: missing 'encrypted:' prefix");
  }

  const payload = Buffer.from(ciphertext.slice("encrypted:".length), "base64");

  const salt = payload.subarray(0, 16);
  const iv = payload.subarray(16, 16 + AES_IV_LEN);
  const tag = payload.subarray(16 + AES_IV_LEN, 16 + AES_IV_LEN + AES_TAG_LEN);
  const data = payload.subarray(16 + AES_IV_LEN + AES_TAG_LEN);

  const key = deriveKey(password, salt);
  const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
