import { getDB } from "./db.js";
import type { LLMMessage, ContentPart, ToolUseRequest } from "../llm/types.js";

/**
 * Extracts plain text from a string or ContentPart array.
 */
export function extractText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map(part => part.text)
    .join("");
}

/**
 * Saves a message to the conversations table.
 * Returns the inserted row id.
 */
export function saveMessage(
  userId: string,
  channel: string,
  role: string,
  content: string | ContentPart[],
  toolCallId?: string,
  toolCalls?: ToolUseRequest[],
): number {
  const db = getDB();
  const contentStr = typeof content === "string" ? content : JSON.stringify(content);
  const toolCallsStr = toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null;
  const result = db
    .prepare(
      `INSERT INTO conversations (user_id, channel, role, content, tool_call_id, tool_calls, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      channel,
      role,
      contentStr,
      toolCallId ?? null,
      toolCallsStr,
      Math.floor(Date.now() / 1000),
    );
  return result.lastInsertRowid as number;
}

interface ConversationRow {
  id: number;
  user_id: string;
  channel: string;
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_calls: string | null;
  timestamp: number;
}

/**
 * Loads the last N messages for a user, with boundary trimming, and the summary if any.
 */
export function loadHistory(
  userId: string,
  limit = 40,
): { messages: LLMMessage[]; summary: string | null } {
  const db = getDB();

  const rows = db
    .prepare(
      `SELECT * FROM conversations
       WHERE user_id = ?
       ORDER BY timestamp ASC, id ASC
       LIMIT ?
       OFFSET (SELECT MAX(0, COUNT(*) - ?) FROM conversations WHERE user_id = ?)`,
    )
    .all(userId, limit, limit, userId) as ConversationRow[];

  const messages: LLMMessage[] = [];

  for (const row of rows) {
    let toolCalls: ToolUseRequest[] | undefined;

    if (row.tool_calls) {
      try {
        toolCalls = JSON.parse(row.tool_calls) as ToolUseRequest[];
      } catch {
        // Skip corrupt rows
        continue;
      }
    }

    const msg: LLMMessage = {
      role: row.role as LLMMessage["role"],
      content: row.content,
    };

    if (toolCalls && toolCalls.length > 0) {
      msg.toolCalls = toolCalls;
    }

    if (row.tool_call_id) {
      msg.toolCallId = row.tool_call_id;
    }

    messages.push(msg);
  }

  // Trim start: advance past any leading non-user messages
  let start = 0;
  while (start < messages.length && messages[start].role !== "user") {
    start++;
  }
  const trimmed = messages.slice(start);

  // Trim end: remove trailing assistant messages that have toolCalls but no following tool result
  let end = trimmed.length;
  while (end > 0) {
    const last = trimmed[end - 1];
    if (last.role === "assistant" && last.toolCalls && last.toolCalls.length > 0) {
      end--;
    } else {
      break;
    }
  }
  const result = trimmed.slice(0, end);

  const summaryRecord = loadSummary(userId);

  return {
    messages: result,
    summary: summaryRecord?.summary ?? null,
  };
}

interface SummaryRow {
  user_id: string;
  summary: string;
  token_estimate: number;
  updated_at: number;
}

/**
 * Upserts a conversation summary for a user.
 */
export function saveSummary(userId: string, summary: string, tokenEstimate: number): void {
  const db = getDB();
  db.prepare(
    `INSERT INTO conversation_summaries (user_id, summary, token_estimate, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       summary = excluded.summary,
       token_estimate = excluded.token_estimate,
       updated_at = excluded.updated_at`,
  ).run(userId, summary, tokenEstimate, Math.floor(Date.now() / 1000));
}

/**
 * Loads the conversation summary for a user, or null if none exists.
 */
export function loadSummary(
  userId: string,
): { summary: string; tokenEstimate: number } | null {
  const db = getDB();
  const row = db
    .prepare("SELECT * FROM conversation_summaries WHERE user_id = ?")
    .get(userId) as SummaryRow | undefined;

  if (!row) return null;

  return {
    summary: row.summary,
    tokenEstimate: row.token_estimate,
  };
}
