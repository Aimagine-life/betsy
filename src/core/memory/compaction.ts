import { getDB } from "./db.js";
import { loadSummary, saveSummary } from "./conversations.js";
import type { LLMClient } from "../llm/types.js";

interface CompactionRow {
  id: number;
  role: string;
  content: string;
  tool_calls: string | null;
}

export async function compactHistory(userId: string, llm: LLMClient): Promise<void> {
  const db = getDB();
  const existing = loadSummary(userId);

  const allRows = db.prepare(
    "SELECT id, role, content, tool_calls FROM conversations WHERE user_id = ? ORDER BY timestamp ASC, id ASC",
  ).all(userId) as CompactionRow[];

  if (allRows.length < 4) return;

  const mid = Math.floor(allRows.length / 2);
  let splitIdx = -1;

  for (let i = mid; i < allRows.length; i++) {
    if (allRows[i].role === "user") { splitIdx = i; break; }
  }
  if (splitIdx === -1) {
    for (let i = mid - 1; i >= 0; i--) {
      if (allRows[i].role === "user") { splitIdx = i; break; }
    }
  }
  if (splitIdx === -1) return;

  const oldPart = allRows.slice(0, splitIdx);
  if (oldPart.length === 0) return;

  const oldText = oldPart.map(m => `${m.role}: ${m.content}`).join("\n");

  const promptText = `Ты — помощник, который суммаризирует разговоры.

Предыдущее саммари (если есть):
${existing?.summary ?? "Нет"}

Новые сообщения для включения в саммари:
${oldText}

Обнови саммари, сохранив все важные факты, решения, контекст и предпочтения пользователя.
Пиши кратко, но не теряй важную информацию. Пиши на русском.`;

  const response = await llm.chat([{ role: "user", content: promptText }]);
  const newSummary = response.text.trim();

  if (!newSummary) {
    throw new Error("Compaction aborted: LLM returned empty summary");
  }

  const estimatedTokens = response.usage?.completionTokens ?? Math.ceil(newSummary.length / 4);
  const maxOldId = oldPart[oldPart.length - 1].id;

  db.transaction(() => {
    saveSummary(userId, newSummary, estimatedTokens);
    db.prepare("DELETE FROM conversations WHERE user_id = ? AND id <= ?").run(userId, maxOldId);
  })();
}
