import type { ApiProtocol, LogProtocol } from './types'

export const PROTOCOL_LABELS: Record<LogProtocol, string> = {
  anthropic: 'Anthropic Messages',
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  gemini: 'Gemini generateContent',
  // 1.0.1 遗留日志值
  openai: 'OpenAI Chat Completions'
}

export const PROTOCOL_SHORT_LABELS: Record<LogProtocol, string> = {
  anthropic: 'Anthropic',
  'openai-chat': 'Chat',
  'openai-responses': 'Responses',
  gemini: 'Gemini',
  openai: 'Chat'
}

export const PROTOCOL_OPTIONS: { value: ApiProtocol; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses API' },
  { value: 'gemini', label: 'Gemini Native generateContent' }
]

export function protocolLabel(value: string | null | undefined): string {
  if (!value) return '未记录'
  return PROTOCOL_LABELS[value as LogProtocol] || value
}

/** 从下游路径识别生成接口；只有这四种生成端点参与跨协议转换。 */
export function detectGenerationProtocol(pathname: string): ApiProtocol | null {
  if (pathname === '/v1/messages') return 'anthropic'
  if (pathname === '/v1/chat/completions') return 'openai-chat'
  if (pathname === '/v1/responses') return 'openai-responses'
  if (geminiModelAction(pathname)) return 'gemini'
  return null
}

/** Gemini 原生路径中的模型与动作，例如 /v1beta/models/gemini-2.0:generateContent */
export function geminiModelAction(pathname: string): { version: 'v1' | 'v1beta'; model: string; action: string; stream: boolean } | null {
  const match = /^\/(v1|v1beta)\/models\/([^/:]+):([A-Za-z]+)$/.exec(pathname)
  if (!match) return null
  let model = ''
  try { model = decodeURIComponent(match[2]) } catch { return null }
  if (!model) return null
  return { version: match[1] as 'v1' | 'v1beta', model, action: match[3], stream: match[3] === 'streamGenerateContent' }
}

/** 生成目标路径：跨协议转换时使用上游协议的标准端点。 */
export function targetGenerationPath(protocol: ApiProtocol, model: string, stream: boolean): string {
  switch (protocol) {
    case 'anthropic': return '/v1/messages'
    case 'openai-chat': return '/v1/chat/completions'
    case 'openai-responses': return '/v1/responses'
    case 'gemini': return `/v1beta/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
  }
}

/** 同协议转发时替换 Gemini 路径中的模型名；其他协议的模型在 JSON body 中。 */
export function retargetSameProtocolPath(pathname: string, protocol: ApiProtocol, model: string): string {
  if (protocol !== 'gemini') return pathname
  const info = geminiModelAction(pathname.split('?')[0])
  if (!info) return pathname
  const query = pathname.includes('?') ? pathname.slice(pathname.indexOf('?')) : ''
  return `/${info.version}/models/${encodeURIComponent(model)}:${info.action}${query}`
}

export function protocolAuthLabel(protocol: ApiProtocol): string {
  switch (protocol) {
    case 'anthropic': return 'x-api-key'
    case 'gemini': return 'x-goog-api-key'
    default: return 'Authorization: Bearer'
  }
}
