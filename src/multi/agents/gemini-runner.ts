/**
 * Gemini-native function-calling runner.
 *
 * Workaround for ADK v0.6.x: instead of going through ADK's Runner/SessionService
 * (which has a complex API and barrel-export quirks), we drive the tool-call loop
 * ourselves using @google/genai's native function calling. The agent object built
 * by createBetsyAgent only carries `instruction`, `model`, and `tools` — all of
 * which we can pass directly to gemini.models.generateContent.
 */
import type { GoogleGenAI } from '@google/genai'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { MemoryTool } from './tools/memory-tools.js'

export interface GeminiRunResult {
  text: string
  toolCalls: Array<{ name: string; args: unknown; result?: unknown; error?: string }>
  tokensUsed: number
}

const MAX_TURNS = 8

function stripJsonSchemaForGemini(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(stripJsonSchemaForGemini)
  const out: any = {}
  for (const [k, v] of Object.entries(schema)) {
    // Gemini's Schema doesn't accept $schema/additionalProperties/$ref keywords
    if (k === '$schema' || k === 'additionalProperties' || k === '$ref' || k === 'definitions') continue
    out[k] = stripJsonSchemaForGemini(v)
  }
  return out
}

function toFunctionDeclaration(tool: MemoryTool): any {
  const raw = zodToJsonSchema(tool.parameters as any, { target: 'openApi3' }) as any
  const params = stripJsonSchemaForGemini(raw)
  return {
    name: tool.name,
    description: tool.description,
    parameters: params && params.type ? params : { type: 'object', properties: {} },
  }
}

export async function runWithGeminiTools(
  gemini: GoogleGenAI,
  agent: any,
  userMessage: string,
): Promise<GeminiRunResult> {
  const instruction: string = (agent as any).instruction ?? ''
  const rawModel = (agent as any).model
  const modelName =
    typeof rawModel === 'string'
      ? rawModel
      : rawModel?.model ?? rawModel?.name ?? rawModel?.modelName ?? 'gemini-2.5-flash'

  const tools: MemoryTool[] = ((agent as any).tools ?? []) as MemoryTool[]
  const toolsByName = new Map<string, MemoryTool>()
  for (const t of tools) toolsByName.set(t.name, t)

  const functionDeclarations = tools.map(toFunctionDeclaration)
  const geminiTools = functionDeclarations.length ? [{ functionDeclarations }] : undefined

  const contents: any[] = [{ role: 'user', parts: [{ text: userMessage }] }]
  const toolCalls: GeminiRunResult['toolCalls'] = []
  let totalTokens = 0
  let finalText = ''

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp: any = await gemini.models.generateContent({
      model: modelName,
      contents,
      config: {
        systemInstruction: instruction,
        ...(geminiTools ? { tools: geminiTools } : {}),
      } as any,
    })

    const usage = resp.usageMetadata ?? {}
    totalTokens += (usage.totalTokenCount as number) ?? 0

    const candidate = resp.candidates?.[0]
    const parts: any[] = candidate?.content?.parts ?? []
    const functionCalls: any[] = []
    let textChunk = ''
    for (const p of parts) {
      if (p.functionCall) functionCalls.push(p.functionCall)
      else if (typeof p.text === 'string') textChunk += p.text
    }
    if (!textChunk && typeof resp.text === 'string') textChunk = resp.text

    if (functionCalls.length === 0) {
      finalText = textChunk
      break
    }

    // Append model turn (with functionCall parts) to history
    contents.push({ role: 'model', parts })

    // Execute each call and append a single user turn with functionResponse parts
    const responseParts: any[] = []
    for (const fc of functionCalls) {
      const tool = toolsByName.get(fc.name)
      if (!tool) {
        const err = `unknown tool: ${fc.name}`
        toolCalls.push({ name: fc.name, args: fc.args, error: err })
        responseParts.push({
          functionResponse: { name: fc.name, response: { error: err } },
        })
        continue
      }
      try {
        const result = await tool.execute(fc.args ?? {})
        toolCalls.push({ name: fc.name, args: fc.args, result })
        responseParts.push({
          functionResponse: {
            name: fc.name,
            response: (result && typeof result === 'object' ? result : { value: result }) as any,
          },
        })
      } catch (e) {
        const err = (e as Error).message
        toolCalls.push({ name: fc.name, args: fc.args, error: err })
        responseParts.push({
          functionResponse: { name: fc.name, response: { error: err } },
        })
      }
    }
    contents.push({ role: 'user', parts: responseParts })
  }

  return { text: finalText, toolCalls, tokensUsed: totalTokens }
}
