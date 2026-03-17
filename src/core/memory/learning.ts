import { getAllKnowledge, addKnowledge } from "./knowledge.js";
import type { KnowledgeRow } from "./knowledge.js";

export interface LearningConfig {
  learningEnabled: boolean;
  studyIntervalMs: number;
  specialties: string[];
}

let lastStudyTimestamp = 0;

/**
 * Determine whether it is time to run a study session.
 * Returns true if learning is enabled and enough time has elapsed.
 */
export function shouldStudy(config: LearningConfig): boolean {
  if (!config.learningEnabled) return false;
  const now = Date.now();
  return now - lastStudyTimestamp >= config.studyIntervalMs;
}

/**
 * Mark a study session as completed (resets the timer).
 */
export function markStudyComplete(): void {
  lastStudyTimestamp = Date.now();
}

export interface StudyResult {
  topic: string;
  insight: string;
  entriesBefore: number;
  entriesAfter: number;
}

/**
 * Run a study session: review existing knowledge, derive a new insight,
 * and store it. Accepts config as a parameter to avoid coupling to
 * any specific config module.
 *
 * The `generateInsight` callback lets callers plug in their own LLM
 * or heuristic — keeping this module free of LLM dependencies.
 */
export async function runStudySession(
  config: LearningConfig,
  generateInsight: (context: {
    specialties: string[];
    existing: KnowledgeRow[];
  }) => Promise<{ topic: string; insight: string }>,
): Promise<StudyResult> {
  const existing = getAllKnowledge();
  const entriesBefore = existing.length;

  const { topic, insight } = await generateInsight({
    specialties: config.specialties,
    existing,
  });

  addKnowledge({ topic, insight, source: "study_session" }, 0.6);
  markStudyComplete();

  return {
    topic,
    insight,
    entriesBefore,
    entriesAfter: entriesBefore + 1,
  };
}
