import type { Skill } from "../types.js";

export const monitorSkill: Skill = {
  name: "Проверка сайта",
  description: "Проверяет доступность и изменения на сайте",
  trigger: "проверь сайт",
  steps: [
    {
      tool: "browser",
      action: "get_text",
      params: { url: "https://example.com" },
    },
    {
      tool: "memory",
      action: "save",
      params: { topic: "site_check" },
    },
  ],
};
