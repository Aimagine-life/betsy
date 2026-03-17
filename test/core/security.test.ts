import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  encrypt,
  decrypt,
} from "../../src/core/security.js";

describe("core/security", () => {
  describe("password hashing", () => {
    it("hash + verify roundtrip works", () => {
      const hash = hashPassword("my-secret");
      expect(verifyPassword("my-secret", hash)).toBe(true);
    });

    it("wrong password fails verification", () => {
      const hash = hashPassword("correct-password");
      expect(verifyPassword("wrong-password", hash)).toBe(false);
    });
  });

  describe("encryption", () => {
    it("encrypt + decrypt roundtrip works", () => {
      const plaintext = "sensitive-api-key-12345";
      const password = "encryption-password";

      const encrypted = encrypt(plaintext, password);
      expect(encrypted.startsWith("encrypted:")).toBe(true);

      const decrypted = decrypt(encrypted, password);
      expect(decrypted).toBe(plaintext);
    });

    it("decrypt with wrong password throws", () => {
      const encrypted = encrypt("secret-data", "correct-password");
      expect(() => decrypt(encrypted, "wrong-password")).toThrow();
    });
  });
});
