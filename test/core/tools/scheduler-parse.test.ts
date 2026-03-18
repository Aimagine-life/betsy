import { describe, it, expect } from "vitest";
import { parseAtTime, parseEveryDuration } from "../../../src/core/tools/scheduler-parse.js";

describe("parseAtTime", () => {
  it("parses relative +5m", () => {
    const now = Date.now();
    const result = parseAtTime("+5m", now);
    expect(result).toBeGreaterThanOrEqual(now + 5 * 60_000 - 100);
    expect(result).toBeLessThanOrEqual(now + 5 * 60_000 + 100);
  });

  it("parses relative +2h30m", () => {
    const now = Date.now();
    const result = parseAtTime("+2h30m", now);
    const expected = now + 2 * 3600_000 + 30 * 60_000;
    expect(Math.abs(result - expected)).toBeLessThan(100);
  });

  it("parses relative +1d", () => {
    const now = Date.now();
    const result = parseAtTime("+1d", now);
    expect(Math.abs(result - (now + 86_400_000))).toBeLessThan(100);
  });

  it("parses ISO datetime string", () => {
    const result = parseAtTime("2026-03-18T15:30:00", Date.now());
    const expected = new Date("2026-03-18T15:30:00").getTime();
    expect(result).toBe(expected);
  });

  it("throws on invalid input", () => {
    expect(() => parseAtTime("garbage", Date.now())).toThrow();
  });
});

describe("parseEveryDuration", () => {
  it("parses 30s", () => {
    expect(parseEveryDuration("30s")).toBe(30_000);
  });

  it("parses 5m", () => {
    expect(parseEveryDuration("5m")).toBe(300_000);
  });

  it("parses 2h", () => {
    expect(parseEveryDuration("2h")).toBe(7_200_000);
  });

  it("parses 1d", () => {
    expect(parseEveryDuration("1d")).toBe(86_400_000);
  });

  it("throws on invalid input", () => {
    expect(() => parseEveryDuration("abc")).toThrow();
  });
});
