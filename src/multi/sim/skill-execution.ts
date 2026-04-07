// Wave 1C — Sim scenario: in-memory skill execution smoke test.
// Not part of vitest; run via tsx for manual verification of the executor wired
// against a stub LLM with no DB / network.
import { executeSkill } from '../skills/executor.js'
import type { SkillLLM, SkillLogger } from '../skills/executor.js'
import type { WorkspaceSkill } from '../skills/types.js'

const logger: SkillLogger = {
  info: (msg, meta) => console.log('[INFO]', msg, meta ?? ''),
  warn: (msg, meta) => console.warn('[WARN]', msg, meta ?? ''),
  error: (msg, meta) => console.error('[ERROR]', msg, meta ?? ''),
}

const llm: SkillLLM = {
  async generateText(prompt: string) {
    // deterministic stub: echo prefix
    return `STUB: ${prompt.slice(0, 40)}`
  },
}

const echoSkill: WorkspaceSkill = {
  name: 'echo',
  description: 'in-memory echo skill',
  trigger: { type: 'manual' },
  steps: [
    {
      kind: 'prompt',
      prompt: 'Скажи привет {{vars.who}}',
      saveAs: 'greeting',
    },
  ],
}

export async function runEchoSim(): Promise<void> {
  const result = await executeSkill(echoSkill, {
    workspaceId: 'sim-ws',
    availableTools: [],
    llm,
    logger,
    vars: { who: 'мир' },
  })
  console.log('result:', JSON.stringify(result, null, 2))
  if (!result.success) {
    throw new Error('sim failed: ' + result.error)
  }
  const greeting = (result.output as any).greeting as string
  if (!greeting.startsWith('STUB:')) {
    throw new Error('unexpected greeting: ' + greeting)
  }
  console.log('OK')
}

// CLI entry: `tsx src/multi/sim/skill-execution.ts`
const argv1 = (process.argv[1] ?? '').replace(/\\/g, '/')
if (import.meta.url.endsWith('skill-execution.ts') && argv1.endsWith('skill-execution.ts')) {
  runEchoSim().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
