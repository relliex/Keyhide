import type { ApiProtocol } from '../../shared/types'

/** 跨协议无法等价表达时抛出，调用方返回字段级 400 或网关错误。 */
export class ProtocolConversionError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'ProtocolConversionError'
    this.field = field
  }
}

export type StopReason = 'stop' | 'length' | 'tool_calls' | 'stop_sequence' | 'content_filter' | 'error'

export interface IRTextPart { type: 'text'; text: string }
export interface IRImagePart { type: 'image'; mediaType: string; data: string }
export interface IRToolCallPart { type: 'tool_call'; id: string; name: string; arguments: string }
export interface IRToolResultPart { type: 'tool_result'; toolCallId: string; name?: string; content: IRContent[] }
export type IRContent = IRTextPart | IRImagePart
export type IRPart = IRContent | IRToolCallPart | IRToolResultPart

export type IRRole = 'user' | 'assistant'
export interface IRMessage { role: IRRole; parts: IRPart[] }

export interface IRTool { name: string; description: string; parameters: Record<string, unknown> }
export type IRToolChoice = 'auto' | 'none' | 'required' | { name: string }

export interface IRRequest {
  model: string
  system: string[]
  messages: IRMessage[]
  tools: IRTool[]
  toolChoice?: IRToolChoice
  maxTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  stop?: string[]
  stream: boolean
}

export interface IRUsage { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number }

export interface IRResponse {
  id: string
  model: string
  created: number
  content: IRPart[]
  stopReason: StopReason
  usage: IRUsage
}

export interface IRError { message: string; code?: string; type?: string }

export type IRStreamEvent =
  | { type: 'start'; id: string; model: string; usage?: Partial<IRUsage> }
  | { type: 'text_start'; index: number }
  | { type: 'text_delta'; index: number; text: string }
  | { type: 'text_end'; index: number }
  | { type: 'tool_start'; index: number; id: string; name: string }
  | { type: 'tool_args_delta'; index: number; delta: string }
  | { type: 'tool_end'; index: number }
  | { type: 'finish'; stopReason: StopReason; usage: IRUsage }
  | { type: 'error'; message: string; code?: string }

export const PROTOCOL_FIELDS = ['anthropic', 'openai-chat', 'openai-responses', 'gemini'] as const

export function protocolName(protocol: ApiProtocol): string {
  return protocol === 'openai-chat' ? 'OpenAI Chat' : protocol === 'openai-responses' ? 'OpenAI Responses' : protocol === 'anthropic' ? 'Anthropic' : 'Gemini'
}

export function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolConversionError(field, '必须是 JSON 对象')
  return value as Record<string, unknown>
}

export function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolConversionError(field, '必须是数组')
  return value
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ProtocolConversionError(field, '必须是字符串')
  return value
}

export function optionalNumber(value: unknown, field: string, positive = false): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) throw new ProtocolConversionError(field, '必须是有效数字')
  return value
}

export function textParts(text: string): IRTextPart[] {
  return [{ type: 'text', text }]
}

export function textOf(parts: IRPart[]): string {
  return parts.filter((part): part is IRTextPart => part.type === 'text').map((part) => part.text).join('')
}

export function hasImages(parts: IRPart[]): boolean {
  return parts.some((part) => part.type === 'image' || (part.type === 'tool_result' && part.content.some((item) => item.type === 'image')))
}

export function parseDataUrl(url: string, field: string): { mediaType: string; data: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (!match) throw new ProtocolConversionError(field, '只支持 base64 data URL 图片；不会自动下载外部图片')
  return { mediaType: match[1], data: match[2] }
}

export function parseJsonObject(value: string, field: string): Record<string, unknown> {
  if (!value || !value.trim()) return {}
  const parsed = parseJsonValue(value, field)
  return asRecord(parsed, field)
}

export function parseJsonValue(value: string, field: string): unknown {
  try { return JSON.parse(value) } catch { throw new ProtocolConversionError(field, '工具参数不是有效 JSON') }
}

export function usageTotal(usage: IRUsage | Partial<IRUsage> | undefined): number {
  if (!usage) return 0
  return (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0)
}

export function emptyUsage(): IRUsage { return { input: 0, output: 0 } }

export function normalizeStopReason(value: string | undefined | null): StopReason {
  switch (value) {
    case 'length':
    case 'max_tokens':
    case 'MAX_TOKENS':
    case 'max_output_tokens':
      return 'length'
    case 'tool_calls':
    case 'tool_use':
    case 'toolUse':
    case 'function_call':
      return 'tool_calls'
    case 'stop_sequence':
      return 'stop_sequence'
    case 'content_filter':
    case 'SAFETY':
    case 'RECITATION':
    case 'refusal':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
      return 'content_filter'
    case 'error':
    case 'FAILED':
      return 'error'
    default:
      return 'stop'
  }
}

export function stopReasonToAnthropic(reason: StopReason): string {
  return reason === 'length' ? 'max_tokens' : reason === 'tool_calls' ? 'tool_use' : reason === 'content_filter' ? 'refusal' : reason === 'stop_sequence' ? 'stop_sequence' : 'end_turn'
}

export function stopReasonToChat(reason: StopReason): string {
  return reason === 'length' ? 'length' : reason === 'tool_calls' ? 'tool_calls' : reason === 'content_filter' ? 'content_filter' : 'stop'
}

export function stopReasonToGemini(reason: StopReason): string {
  return reason === 'length' ? 'MAX_TOKENS' : reason === 'content_filter' ? 'SAFETY' : reason === 'tool_calls' ? 'STOP' : 'STOP'
}

export function stopReasonToResponsesStatus(reason: StopReason): 'completed' | 'incomplete' {
  return reason === 'length' || reason === 'content_filter' ? 'incomplete' : 'completed'
}
