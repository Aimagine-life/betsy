import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/core/prompt.js";

describe("buildSystemPrompt", () => {
  it("includes the agent name", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" });
    expect(prompt).toContain("Бетси");
  });

  it("includes personality tone", () => {
    const prompt = buildSystemPrompt({
      name: "Бетси",
      personality: { tone: "friendly" },
    });
    expect(prompt).toContain("Тон: friendly");
  });

  it("includes personality response style", () => {
    const prompt = buildSystemPrompt({
      name: "Бетси",
      personality: { responseStyle: "concise" },
    });
    expect(prompt).toContain("Стиль ответов: concise");
  });

  it("includes custom instructions", () => {
    const prompt = buildSystemPrompt({
      name: "Бетси",
      personality: { customInstructions: "Ты милая и игривая." },
    });
    expect(prompt).toContain("Ты милая и игривая.");
  });

  it("includes settings menu capability", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" });
    expect(prompt).toContain("/settings");
    expect(prompt).toContain("Стиль ответов");
    expect(prompt).toContain("Напоминания");
  });

  it("includes tools list", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" });
    expect(prompt).toContain("shell");
    expect(prompt).toContain("browser");
    expect(prompt).toContain("self_config");
  });

  it("includes owner info when provided", () => {
    const prompt = buildSystemPrompt({
      name: "Бетси",
      owner: {
        name: "Константин",
        facts: ["день рождения 4 мая", "жена Аня", "дочь Лиза"],
      },
    });
    expect(prompt).toContain("Константин");
    expect(prompt).toContain("день рождения 4 мая");
    expect(prompt).toContain("жена Аня");
  });

  it("includes user message when provided", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" }, "Привет");
    expect(prompt).toContain("Привет");
  });

  it("responds in Russian by default", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" });
    expect(prompt).toContain("русском языке");
  });
});
