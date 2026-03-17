/** Per-million-token prices (USD) for common models */
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-4": { input: 30, output: 60 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-3-5-haiku-20241022": { input: 1, output: 5 },
};

interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: number;
}

export interface CostSummary {
  total: number;
  byModel: Record<string, number>;
}

function estimatePrice(model: string): { input: number; output: number } {
  // Exact match
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];

  // Partial match by substring
  const lower = model.toLowerCase();
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return price;
    }
  }

  // Fallback: rough mid-range estimate
  return { input: 3, output: 15 };
}

/** In-memory cost tracker (can be backed by SQLite later). */
export class CostTracker {
  private records: UsageRecord[] = [];

  trackUsage(model: string, inputTokens: number, outputTokens: number): void {
    const price = estimatePrice(model);
    const costUsd =
      (inputTokens / 1_000_000) * price.input +
      (outputTokens / 1_000_000) * price.output;

    this.records.push({
      model,
      inputTokens,
      outputTokens,
      costUsd,
      timestamp: Date.now(),
    });
  }

  getCosts(period?: "today" | "month" | "all"): CostSummary {
    let cutoff = 0;

    if (period === "today") {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      cutoff = d.getTime();
    } else if (period === "month") {
      const d = new Date();
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      cutoff = d.getTime();
    }

    const filtered = this.records.filter((r) => r.timestamp >= cutoff);

    let total = 0;
    const byModel: Record<string, number> = {};

    for (const r of filtered) {
      total += r.costUsd;
      byModel[r.model] = (byModel[r.model] ?? 0) + r.costUsd;
    }

    return { total, byModel };
  }
}
