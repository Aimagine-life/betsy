import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { EvalRunner } from '../../../src/multi/evals/runner.js'
import type { EvalCase } from '../../../src/multi/evals/types.js'

async function tmp(content: string, ext = '.yaml'): Promise<string> {
  const p = path.join(os.tmpdir(), `eval-${Date.now()}-${Math.random()}${ext}`)
  await fs.writeFile(p, content)
  return p
}

const baseCase: EvalCase = {
  id: 'c1',
  description: 'simple',
  category: 'delegation',
  input: { userMessage: 'hi' },
  expected: { firstTool: 'delegate_to_research' },
  mockResponses: [
    { functionCall: { name: 'delegate_to_research', args: {} } },
    { text: 'done' },
  ],
}

describe('EvalRunner.loadCases', () => {
  it('parses a valid YAML file', async () => {
    const yaml = `cases:
  - id: c1
    description: x
    category: delegation
    input:
      userMessage: hi
    expected:
      firstTool: delegate_to_research
`
    const p = await tmp(yaml)
    const runner = new EvalRunner()
    const cases = await runner.loadCases(p)
    expect(cases).toHaveLength(1)
    expect(cases[0].id).toBe('c1')
  })

  it('throws on missing cases array', async () => {
    const p = await tmp('foo: bar\n')
    const runner = new EvalRunner()
    await expect(runner.loadCases(p)).rejects.toThrow(/cases/)
  })

  it('throws on case missing required fields', async () => {
    const p = await tmp('cases:\n  - id: c1\n')
    const runner = new EvalRunner()
    await expect(runner.loadCases(p)).rejects.toThrow(/missing required/)
  })
})

describe('EvalRunner.runOne', () => {
  it('passes when firstTool matches scripted call', async () => {
    const runner = new EvalRunner()
    const r = await runner.runOne(baseCase)
    expect(r.passed).toBe(true)
    expect(r.failures).toEqual([])
    expect(r.metrics.firstTool).toBe('delegate_to_research')
  })

  it('fails with a clear message when firstTool mismatches', async () => {
    const runner = new EvalRunner()
    const c: EvalCase = {
      ...baseCase,
      expected: { firstTool: 'delegate_to_memory' },
    }
    const r = await runner.runOne(c)
    expect(r.passed).toBe(false)
    expect(r.failures[0]).toMatch(/firstTool mismatch/)
  })

  it('honours textContains as string and as array', async () => {
    const runner = new EvalRunner()
    const single = await runner.runOne({
      ...baseCase,
      expected: { textContains: 'done' },
    })
    expect(single.passed).toBe(true)

    const arr = await runner.runOne({
      ...baseCase,
      expected: { textContains: ['done', 'missing-token'] },
    })
    expect(arr.passed).toBe(false)
    expect(arr.failures.some((f) => f.includes('missing-token'))).toBe(true)
  })

  it('honours textMustNotContain', async () => {
    const runner = new EvalRunner()
    const r = await runner.runOne({
      ...baseCase,
      expected: { textMustNotContain: ['done'] },
    })
    expect(r.passed).toBe(false)
    expect(r.failures[0]).toMatch(/forbidden/)
  })

  it('skips when case has skip: true', async () => {
    const runner = new EvalRunner()
    const r = await runner.runOne({ ...baseCase, skip: true })
    expect(r.skipped).toBe(true)
    expect(r.passed).toBe(true)
  })

  it('computes minRecall correctly', async () => {
    const runner = new EvalRunner()
    const ok = await runner.runOne({
      id: 'r1',
      description: 'recall',
      category: 'recall',
      input: { userMessage: 'q' },
      expected: { minRecall: { k: 3, relevantIds: ['a', 'b'] } },
      mockRecallIds: ['a', 'b', 'x'],
    })
    expect(ok.passed).toBe(true)
    expect(ok.metrics.recall).toBe(1)

    const bad = await runner.runOne({
      id: 'r2',
      description: 'recall',
      category: 'recall',
      input: { userMessage: 'q' },
      expected: { minRecall: { k: 3, relevantIds: ['a', 'b'] } },
      mockRecallIds: ['a', 'x', 'y'],
    })
    expect(bad.passed).toBe(false)
    expect(bad.metrics.recall).toBeCloseTo(0.5)
  })
})

describe('EvalRunner.runAll', () => {
  it('aggregates and computes p50/p95 latency', async () => {
    let t = 0
    const runner = new EvalRunner({ now: () => (t += 10) })
    const cases: EvalCase[] = Array.from({ length: 10 }, (_, i) => ({
      ...baseCase,
      id: `c${i}`,
    }))
    const summary = await runner.runAll(cases)
    expect(summary.total).toBe(10)
    expect(summary.passed).toBe(10)
    expect(summary.failed).toBe(0)
    expect(summary.byCategory.delegation.passed).toBe(10)
    // p50/p95 are positive
    expect(summary.latencyP50).toBeGreaterThanOrEqual(0)
    expect(summary.latencyP95).toBeGreaterThanOrEqual(summary.latencyP50)
  })
})

describe('EvalRunner.compareWithBaseline', () => {
  it('detects regressions (was passed, now failed)', async () => {
    const runner = new EvalRunner()
    const baseline = {
      results: [
        { caseId: 'c1', passed: true, category: 'delegation' },
        { caseId: 'c2', passed: true, category: 'delegation' },
      ],
    }
    const baselinePath = await tmp(JSON.stringify(baseline), '.json')

    const summary = await runner.runAll([
      baseCase,
      { ...baseCase, id: 'c2', expected: { firstTool: 'wrong' } },
    ])
    const cmp = await runner.compareWithBaseline(summary, baselinePath)
    expect(cmp.regressions).toContain('c2')
    expect(cmp.regressions).not.toContain('c1')
  })

  it('detects improvements (was failed, now passed)', async () => {
    const runner = new EvalRunner()
    const baseline = {
      results: [{ caseId: 'c1', passed: false, category: 'delegation' }],
    }
    const baselinePath = await tmp(JSON.stringify(baseline), '.json')
    const summary = await runner.runAll([baseCase])
    const cmp = await runner.compareWithBaseline(summary, baselinePath)
    expect(cmp.improvements).toContain('c1')
  })

  it('returns empty diff when baseline is missing', async () => {
    const runner = new EvalRunner()
    const summary = await runner.runAll([baseCase])
    const cmp = await runner.compareWithBaseline(summary, '/no/such/file.json')
    expect(cmp.regressions).toEqual([])
    expect(cmp.improvements).toEqual([])
  })
})

describe('builtin.yaml', () => {
  it('loads and runs cleanly', async () => {
    const runner = new EvalRunner()
    const cases = await runner.loadCases('src/multi/evals/cases/builtin.yaml')
    const summary = await runner.runAll(cases)
    // No regressions vs an empty baseline.
    expect(summary.failed).toBe(0)
  })
})
