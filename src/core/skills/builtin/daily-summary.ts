import type { Skill } from "../types.js";

export const dailySummarySkill: Skill = {
  name: "Дневной отчёт",
  description: "Формирует сводку активности за день",
  trigger: { scheduler: "0 20 * * *" },
  steps: [
    {
      tool: "memory",
      action: "search",
      params: { query: "today activity", limit: 50 },
    },
    {
      tool: "llm",
      action: "summarize",
      params: { prompt: "Составь краткую сводку активности за сегодня" },
    },
    {
      tool: "memory",
      action: "save",
      params: { topic: "daily_summary" },
    },
  ],
};
