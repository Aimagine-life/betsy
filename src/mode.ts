export type EntryMode = 'single' | 'multi'

export function pickEntry(env: NodeJS.ProcessEnv): EntryMode {
  return env.BETSY_MODE === 'multi' ? 'multi' : 'single'
}
