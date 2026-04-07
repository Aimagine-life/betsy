import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { runCli, parseArgs } from '../../../src/multi/evals/cli.js'

describe('parseArgs', () => {
  it('errors on no args', () => {
    const r = parseArgs([])
    expect('error' in r).toBe(true)
  })
  it('parses optional flags', () => {
    const r = parseArgs(['cases.yaml', '--baseline', 'b.json', '--out', 'o.json', '--threshold', '0.8'])
    if ('error' in r) throw new Error('unexpected')
    expect(r.casesPath).toBe('cases.yaml')
    expect(r.baselinePath).toBe('b.json')
    expect(r.outPath).toBe('o.json')
    expect(r.threshold).toBe(0.8)
  })
})

async function tmpYaml(): Promise<string> {
  const p = path.join(os.tmpdir(), `cli-${Date.now()}-${Math.random()}.yaml`)
  await fs.writeFile(
    p,
    `cases:
  - id: ok
    description: x
    category: delegation
    input:
      userMessage: hi
    expected:
      firstTool: tA
    mockResponses:
      - functionCall:
          name: tA
          args: {}
      - text: done
`,
  )
  return p
}

describe('runCli', () => {
  it('exits 0 when all cases pass and no baseline', async () => {
    const p = await tmpYaml()
    const code = await runCli([p, '--threshold', '1'])
    expect(code).toBe(0)
  })

  it('exits 1 when threshold is violated', async () => {
    const p = path.join(os.tmpdir(), `cli-${Date.now()}-bad.yaml`)
    await fs.writeFile(
      p,
      `cases:
  - id: bad
    description: x
    category: delegation
    input:
      userMessage: hi
    expected:
      firstTool: tA
    mockResponses:
      - functionCall:
          name: tWRONG
          args: {}
      - text: done
`,
    )
    const code = await runCli([p, '--threshold', '1'])
    expect(code).toBe(1)
  })

  it('exits 1 on regression vs baseline', async () => {
    const p = path.join(os.tmpdir(), `cli-${Date.now()}-reg.yaml`)
    await fs.writeFile(
      p,
      `cases:
  - id: c1
    description: x
    category: delegation
    input:
      userMessage: hi
    expected:
      firstTool: tA
    mockResponses:
      - functionCall:
          name: tWRONG
          args: {}
      - text: done
`,
    )
    const baseline = path.join(os.tmpdir(), `baseline-${Date.now()}.json`)
    await fs.writeFile(
      baseline,
      JSON.stringify({ results: [{ caseId: 'c1', passed: true, category: 'delegation' }] }),
    )
    const code = await runCli([p, '--baseline', baseline, '--threshold', '0'])
    expect(code).toBe(1)
  })
})
