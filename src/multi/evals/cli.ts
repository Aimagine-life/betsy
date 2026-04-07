/**
 * Wave 4 — eval harness CLI.
 *
 * Usage:
 *   npx tsx src/multi/evals/cli.ts <cases.yaml> \
 *     [--baseline <baseline.json>] [--out <result.json>] [--threshold 0.95]
 *
 * Exit codes:
 *   0 — success rate >= threshold AND no regressions vs baseline
 *   1 — regression OR threshold violation
 *   2 — invalid arguments / load failure
 */
import { promises as fs } from 'node:fs'
import { EvalRunner } from './runner.js'
import type { EvalRunSummary } from './types.js'

interface CliArgs {
  casesPath: string
  baselinePath?: string
  outPath?: string
  threshold: number
}

export function parseArgs(argv: string[]): CliArgs | { error: string } {
  if (argv.length === 0) {
    return { error: 'usage: cli.ts <cases.yaml> [--baseline X] [--out Y] [--threshold N]' }
  }
  const args: CliArgs = { casesPath: argv[0], threshold: 0.95 }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--baseline') args.baselinePath = argv[++i]
    else if (a === '--out') args.outPath = argv[++i]
    else if (a === '--threshold') args.threshold = Number(argv[++i])
    else return { error: `unknown arg: ${a}` }
  }
  if (Number.isNaN(args.threshold)) return { error: 'invalid threshold' }
  return args
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n)
  return s + ' '.repeat(n - s.length)
}

export function formatTable(summary: EvalRunSummary): string {
  const lines: string[] = []
  lines.push(
    `${pad('id', 32)} ${pad('category', 16)} ${pad('status', 8)} ${pad('ms', 6)} first_failure`,
  )
  lines.push('-'.repeat(100))
  for (const r of summary.results) {
    const status = r.skipped ? 'SKIP' : r.passed ? 'PASS' : 'FAIL'
    const fail = r.failures[0] ?? ''
    lines.push(
      `${pad(r.caseId, 32)} ${pad(r.category, 16)} ${pad(status, 8)} ${pad(String(r.durationMs), 6)} ${fail}`,
    )
  }
  lines.push('')
  lines.push(
    `total=${summary.total} passed=${summary.passed} failed=${summary.failed} skipped=${summary.skipped} p50=${summary.latencyP50}ms p95=${summary.latencyP95}ms`,
  )
  return lines.join('\n')
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    process.stderr.write(parsed.error + '\n')
    return 2
  }

  const runner = new EvalRunner()
  let cases
  try {
    cases = await runner.loadCases(parsed.casesPath)
  } catch (e) {
    process.stderr.write(`failed to load cases: ${(e as Error).message}\n`)
    return 2
  }

  const summary = await runner.runAll(cases)
  process.stdout.write(formatTable(summary) + '\n')

  const evaluable = summary.passed + summary.failed
  const successRate = evaluable === 0 ? 1 : summary.passed / evaluable
  process.stdout.write(`success rate: ${(successRate * 100).toFixed(1)}%\n`)

  let regressions: string[] = []
  if (parsed.baselinePath) {
    const cmp = await runner.compareWithBaseline(summary, parsed.baselinePath)
    regressions = cmp.regressions
    if (cmp.regressions.length > 0) {
      process.stdout.write(`REGRESSIONS: ${cmp.regressions.join(', ')}\n`)
    }
    if (cmp.improvements.length > 0) {
      process.stdout.write(`improvements: ${cmp.improvements.join(', ')}\n`)
    }
  }

  if (parsed.outPath) {
    await fs.writeFile(
      parsed.outPath,
      JSON.stringify(EvalRunner.toBaselineJson(summary), null, 2),
    )
    process.stdout.write(`wrote baseline: ${parsed.outPath}\n`)
  }

  if (regressions.length > 0) return 1
  if (successRate < parsed.threshold) {
    process.stdout.write(
      `FAIL: success rate ${(successRate * 100).toFixed(1)}% < threshold ${(parsed.threshold * 100).toFixed(1)}%\n`,
    )
    return 1
  }
  return 0
}

// Allow `tsx src/multi/evals/cli.ts ...`
const isMain = (() => {
  try {
    const url = new URL(import.meta.url).pathname
    return process.argv[1] && url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!)
  } catch {
    return false
  }
})()
if (isMain) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      // eslint-disable-next-line no-console
      console.error('cli crashed:', e)
      process.exit(2)
    },
  )
}
