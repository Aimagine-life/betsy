import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "../../../src/services/crypto.js";

describe("token encryption", () => {
  const key = "b55c8792d1ce458e279308835f8a97b580263503e76e1998e279703e35ad0c2e";

  it("encrypts and decrypts a string", () => {
    const plaintext = "ya29.a0ARrdaM-test-token-value";
    const encrypted = encrypt(plaintext, key);
    expect(encrypted).not.toBe(plaintext);
    expect(decrypt(encrypted, key)).toBe(plaintext);
  });

  it("produces different ciphertext for same input (random IV)", () => {
    const plaintext = "same-token";
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a).not.toBe(b);
  });

  it("throws on wrong key", () => {
    const encrypted = encrypt("secret", key);
    const wrongKey = "0000000000000000000000000000000000000000000000000000000000000000";
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it("handles empty string", () => {
    const encrypted = encrypt("", key);
    expect(decrypt(encrypted, key)).toBe("");
  });
});
