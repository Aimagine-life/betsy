/**
 * Wave 4 — eval harness runner.
 *
 * Loads a YAML file of {@link EvalCase}s and executes each one in
 * "mock mode": a scripted Gemini reply sequence drives the agent path,
 * the runner watches which tool was called first and what final text
 * was produced, then checks the case's expectations.
 *
 * V1 scope (intentional):
 *   - Mock execution only. We do NOT spin up `runBetsy` (that requires a
 *     full workspace + repos + DB). Instead we replay the scripted Gemini
 *     responses through a tiny in-process loop. This keeps the harness
 *     deterministic and runnable in CI without Postgres.
 *   - Cases that need a real LLM or full workspace are marked `skip: true`
 *     and are reported as skipped (not failed).
 *
 * Future work (not in V1):
 *   - Optional `runBetsy` integration mode behind a flag, with mocked repos.
 *   - Live-Gemini mode for nightly runs.
 */
import { promises as fs } from 'node:fs'
import * as YAML from 'js-yaml'
import type {
  BaselineComparison,
  BaselineFile,
  CategorySummary,
  EvalCase,
  EvalResult,
  EvalRunSummary,
  MockReply,
} from './types.js'
import { judge as defaultJudge, type JudgeFn } from './judge.js'

export interface EvalRunnerOptions {
  /** When provided, used as the LLM-judge. Otherwise judge checks are skipped. */
  judge?: JudgeFn
  /** Override the clock for deterministic latency testing. */
  now?: () => number
}

export class EvalRunner {
  private opts: EvalRunnerOptions

  constructor(opts: EvalRunnerOptions = {}) {
    this.opts = opts
  }

  /** Parse a YAML file containing `cases:` array. */
  async loadCases(path: string): Promise<EvalCase[]> {
    const raw = await fs.readFile(path, 'utf8')
    const parsed = YAML.load(raw) as { cases?: EvalCase[] } | null
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`evals: invalid YAML at ${path}: not an object`)
    }
    if (!Array.isArray(parsed.cases)) {
      throw new Error(`evals: invalid YAML at ${path}: missing "cases" array`)
    }
    for (const c of parsed.cases) {
      if (!c.id || !c.category || !c.input || !c.expected) {
        throw new Error(
          `evals: invalid case (id="${c?.id ?? '?'}"): missing required fields`,
        )
      }
    }
    return parsed.cases
  }

  /** Execute one case and return the result with metrics & failures. */
  async runOne(caseObj: EvalCase): Promise<EvalResult> {
    const now = this.opts.now ?? (() => Date.now())
    const started = now()

    if (caseObj.skip) {
      return {
        caseId: caseObj.id,
        category: caseObj.category,
        skipped: true,
        passed: true,
        failures: [],
        durationMs: 0,
        metrics: {},
      }
    }

    const failures: string[] = []
    const metrics: EvalResult['metrics'] = {}

    // ---- Replay scripted responses ----
    const replies: MockReply[] = caseObj.mockResponses ?? []
    if (replies.length === 0 && (caseObj.expected.firstTool || caseObj.expected.textContains)) {
      failures.push('case requires mockResponses to be evaluated')
    }

    let firstTool: string | undefined
    let finalText = ''
    for (const r of replies) {
      if (r.functionCall && firstTool === undefined) {
        firstTool = r.functionCall.name
      }
      if (r.text) finalText = r.text
    }
    metrics.firstTool = firstTool

    // ---- firstTool check ----
    if (caseObj.expected.firstTool) {
      if (firstTool !== caseObj.expected.firstTool) {
        failures.push(
          `firstTool mismatch: expected "${caseObj.expected.firstTool}", got "${firstTool ?? '<none>'}"`,
        )
      }
    }

    // ---- textContains check ----
    if (caseObj.expected.textContains) {
      const needles = Array.isArray(caseObj.expected.textContains)
        ? caseObj.expected.textContains
        : [caseObj.expected.textContains]
      for (const needle of needles) {
        if (!finalText.includes(needle)) {
          failures.push(`textContains: "${needle}" not found in final text`)
        }
      }
    }

    // ---- textMustNotContain check ----
    if (caseObj.expected.textMustNotContain) {
      const banned = Array.isArray(caseObj.expected.textMustNotContain)
        ? caseObj.expected.textMustNotContain
        : [caseObj.expected.textMustNotContain]
      for (const word of banned) {
        if (finalText.includes(word)) {
          failures.push(`textMustNotContain: forbidden "${word}" appeared in final text`)
        }
      }
    }

    // ---- minRecall check ----
    if (caseObj.expected.minRecall) {
      const { k, relevantIds } = caseObj.expected.minRecall
      const actual = caseObj.mockRecallIds ?? []
      const topK = actual.slice(0, k)
      const hits = topK.filter((id) => relevantIds.includes(id)).length
      const recall = relevantIds.length === 0 ? 1 : hits / relevantIds.length
      metrics.recall = recall
      if (recall < 1) {
        // Threshold for "min" recall. Treat <100% as a failure for V1.
        failures.push(
          `minRecall: expected all ${relevantIds.length} ids in top-${k}, got recall=${recall.toFixed(2)}`,
        )
      }
    }

    // ---- LLM judge ----
    if (caseObj.expected.judgeProperties && this.opts.judge) {
      try {
        const result = await this.opts.judge(finalText, caseObj.expected.judgeProperties)
        metrics.judgeScore = result.score
        if (result.score < 1) {
          const violated = Object.entries(result.perProperty)
            .filter(([, ok]) => !ok)
            .map(([p]) => p)
          failures.push(`judge: violated properties: ${violated.join('; ')}`)
        }
      } catch (e) {
        failures.push(`judge: error ${(e as Error).message}`)
      }
    } else if (caseObj.expected.judgeProperties && !this.opts.judge) {
      // No judge configured — record as a soft skip (not a failure).
      metrics.judgeScore = undefined
    }

    const finished = now()
    return {
      caseId: caseObj.id,
      category: caseObj.category,
      skipped: false,
      passed: failures.length === 0,
      failures,
      durationMs: finished - started,
      metrics,
    }
  }

  /** Run a list of cases and aggregate. */
  async runAll(cases: EvalCase[]): Promise<EvalRunSummary> {
    const startedAt = new Date().toISOString()
    const results: EvalResult[] = []
    for (const c of cases) {
      results.push(await this.runOne(c))
    }
    const finishedAt = new Date().toISOString()

    const byCategory: Record<string, CategorySummary> = {}
    let passed = 0
    let failed = 0
    let skipped = 0
    for (const r of results) {
      if (!byCategory[r.category]) {
        byCategory[r.category] = { passed: 0, failed: 0, skipped: 0 }
      }
      const slot = byCategory[r.category]
      if (r.skipped) {
        slot.skipped += 1
        skipped += 1
      } else if (r.passed) {
        slot.passed += 1
        passed += 1
      } else {
        slot.failed += 1
        failed += 1
      }
    }

    const latencies = results
      .filter((r) => !r.skipped)
      .map((r) => r.durationMs)
      .sort((a, b) => a - b)
    const p = (q: number): number => {
      if (latencies.length === 0) return 0
      const idx = Math.min(latencies.length - 1, Math.floor(q * latencies.length))
      return latencies[idx]
    }

    return {
      total: results.length,
      passed,
      failed,
      skipped,
      byCategory,
      results,
      latencyP50: p(0.5),
      latencyP95: p(0.95),
      startedAt,
      finishedAt,
    }
  }

  /** Compare a run against a baseline file (or empty if missing). */
  async compareWithBaseline(
    summary: EvalRunSummary,
    baselinePath: string,
  ): Promise<BaselineComparison> {
    let baseline: BaselineFile | null = null
    try {
      const raw = await fs.readFile(baselinePath, 'utf8')
      baseline = JSON.parse(raw) as BaselineFile
    } catch {
      baseline = null
    }
    if (!baseline) return { regressions: [], improvements: [] }

    const baselineMap = new Map<string, boolean>()
    for (const r of baseline.results) {
      baselineMap.set(r.caseId, r.passed)
    }

    const regressions: string[] = []
    const improvements: string[] = []
    for (const r of summary.results) {
      if (r.skipped) continue
      const prior = baselineMap.get(r.caseId)
      if (prior === undefined) continue
      if (prior && !r.passed) regressions.push(r.caseId)
      if (!prior && r.passed) improvements.push(r.caseId)
    }
    return { regressions, improvements }
  }

  /** Serialize a summary as a baseline file (for `--out`). */
  static toBaselineJson(summary: EvalRunSummary): BaselineFile {
    return {
      startedAt: summary.startedAt,
      results: summary.results
        .filter((r) => !r.skipped)
        .map((r) => ({
          caseId: r.caseId,
          passed: r.passed,
          category: r.category,
        })),
    }
  }
}
