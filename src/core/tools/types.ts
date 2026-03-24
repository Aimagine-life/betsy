export interface ToolParam {
  name: string
  type: string // 'string' | 'number' | 'boolean'
  description: string
  required?: boolean
}

export interface ToolResult {
  success: boolean
  output: string
  error?: string
  mediaUrl?: string
  /** Path to a local file to send to the user (video, audio, document). */
  mediaPath?: string
}

export interface Tool {
  name: string
  description: string
  parameters: ToolParam[]
  requiresConfirmation?: boolean
  execute(params: Record<string, unknown>): Promise<ToolResult>
}
