import type { ApiProtocol } from '../../shared/types'
import {
  ProtocolConversionError, asArray, asRecord, emptyUsage, normalizeStopReason, stopReasonToAnthropic, stopReasonToChat,
  stopReasonToGemini, stopReasonToResponsesStatus, usageTotal,
  type IRError, type IRResponse, type IRPart, type IRUsage, type StopReason
} from './ir'

/* ------------------------------------------------------------------ */
/* 上游响应 → 中间表示                                                 */
/* ------------------------------------------------------------------ */

export function decodeResponse(protocol: ApiProtocol, value: unknown, modelHint: string): IRResponse {
  if (protocol === 'anthropic') return decodeAnthropicResponse(value, modelHint)
  if (protocol === 'openai-chat') return decodeChatResponse(value, modelHint)
  if (protocol === 'openai-responses') return decodeResponsesResponse(value, modelHint)
  return decodeGeminiResponse(value, modelHint)
}

function decodeAnthropicResponse(value: unknown, modelHint: string): IRResponse {
  const body = asRecord(value, 'response')
  const content: IRPart[] = []
  for (const raw of asArray(body.content, 'response.content')) {
    const block = asRecord(raw, 'response.content')
    if (block.type === 'text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text })
    else if (block.type === 'tool_use') {
      content.push({ type: 'tool_call', id: typeof block.id === 'string' ? block.id : `call_${content.length}`, name: typeof block.name === 'string' ? block.name : '', arguments: JSON.stringify(block.input ?? {}) })
    } else {
      // 思考块、服务端工具等不属于可转换的可见回答，忽略而不中断整个响应。
    }
  }
  const usage = asRecord(body.usage ?? {}, 'response.usage')
  const cacheRead = numberOrUndefined(usage.cache_read_input_tokens)
  const cacheWrite = numberOrUndefined(usage.cache_creation_input_tokens)
  return {
    id: typeof body.id === 'string' ? body.id : '', model: typeof body.model === 'string' ? body.model : modelHint,
    created: Date.now(), content, stopReason: normalizeStopReason(typeof body.stop_reason === 'string' ? body.stop_reason : undefined),
    usage: { input: numberOrZero(usage.input_tokens), output: numberOrZero(usage.output_tokens), cacheRead, cacheWrite }
  }
}

function decodeChatResponse(value: unknown, modelHint: string): IRResponse {
  const body = asRecord(value, 'response')
  const choices = asArray(body.choices, 'response.choices')
  if (choices.length > 1) throw new ProtocolConversionError('response.choices', '跨协议只支持单个候选结果')
  const choice = asRecord(choices[0] ?? {}, 'response.choices')
  const message = asRecord(choice.message ?? {}, 'response.choices.message')
  const content: IRPart[] = []
  const text = chatMessageText(message.content)
  if (text) content.push({ type: 'text', text })
  if (typeof message.refusal === 'string' && message.refusal) content.push({ type: 'text', text: message.refusal })
  for (const raw of asArray(message.tool_calls ?? [], 'response.choices.message.tool_calls')) {
    const call = asRecord(raw, 'tool_calls')
    const fn = asRecord(call.function ?? {}, 'tool_calls.function')
    content.push({ type: 'tool_call', id: typeof call.id === 'string' ? call.id : `call_${content.length}`, name: typeof fn.name === 'string' ? fn.name : '', arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}) })
  }
  const usage = asRecord(body.usage ?? {}, 'response.usage')
  const prompt = numberOrZero(usage.prompt_tokens)
  const cached = numberOrZero(asRecord(usage.prompt_tokens_details ?? {}, 'prompt_tokens_details').cached_tokens)
  return {
    id: typeof body.id === 'string' ? body.id : '', model: typeof body.model === 'string' ? body.model : modelHint,
    created: typeof body.created === 'number' ? body.created : Date.now(), content,
    stopReason: normalizeStopReason(typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined),
    usage: { input: Math.max(0, prompt - cached), output: numberOrZero(usage.completion_tokens), cacheRead: cached || undefined }
  }
}

function chatMessageText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((item) => typeof item === 'string' ? item : typeof (item as Record<string, unknown>)?.text === 'string' ? String((item as Record<string, unknown>).text) : '').join('')
}

function decodeResponsesResponse(value: unknown, modelHint: string): IRResponse {
  const body = asRecord(value, 'response')
  if (body.error) throw new ProtocolConversionError('response.error', errorMessage(body.error))
  const content: IRPart[] = []
  let stopReason = body.status === 'incomplete' ? 'length' as StopReason : 'stop' as StopReason
  for (const raw of asArray(body.output ?? [], 'response.output')) {
    const item = asRecord(raw, 'response.output')
    if (item.type === 'message') {
      for (const rawPart of asArray(item.content ?? [], 'response.output.content')) {
        const part = asRecord(rawPart, 'output.content')
        if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') content.push({ type: 'text', text: part.text })
        else if (part.type === 'refusal' && typeof part.refusal === 'string') content.push({ type: 'text', text: part.refusal })
        else throw new ProtocolConversionError('output.content', `无法转换的内容类型 ${String(part.type)}`)
      }
    } else if (item.type === 'function_call') {
      content.push({ type: 'tool_call', id: typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : `call_${content.length}`, name: typeof item.name === 'string' ? item.name : '', arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) })
      stopReason = 'tool_calls'
    } else {
      // reasoning、web_search_call 等供应商内置输出不参与可见文本转换。
    }
  }
  const incomplete = body.incomplete_details === undefined ? null : asRecord(body.incomplete_details, 'incomplete_details')
  if (incomplete && typeof incomplete.reason === 'string') {
    stopReason = incomplete.reason === 'content_filter' ? 'content_filter' : 'length'
  }
  const usage = asRecord(body.usage ?? {}, 'response.usage')
  const input = numberOrZero(usage.input_tokens)
  const cached = numberOrZero(asRecord(usage.input_tokens_details ?? {}, 'input_tokens_details').cached_tokens)
  return {
    id: typeof body.id === 'string' ? body.id : '', model: typeof body.model === 'string' ? body.model : modelHint,
    created: typeof body.created_at === 'number' ? body.created_at : Date.now(), content, stopReason,
    usage: { input: Math.max(0, input - cached), output: numberOrZero(usage.output_tokens), cacheRead: cached || undefined, reasoning: numberOrZero(asRecord(usage.output_tokens_details ?? {}, 'output_tokens_details').reasoning_tokens) || undefined }
  }
}

function decodeGeminiResponse(value: unknown, modelHint: string): IRResponse {
  const body = asRecord(value, 'response')
  const candidates = asArray(body.candidates ?? [], 'candidates')
  const parts: IRPart[] = []
  let stopReason: StopReason = 'stop'
  if (candidates.length) {
    const candidate = asRecord(candidates[0], 'candidates')
    const content = asRecord(candidate.content ?? {}, 'candidate.content')
    for (const raw of asArray(content.parts ?? [], 'candidate.content.parts')) {
      const part = asRecord(raw, 'parts')
      if (part.text !== undefined && typeof part.text === 'string') {
        if (part.thought !== true) parts.push({ type: 'text', text: part.text })
      } else if (part.functionCall !== undefined) {
        const call = asRecord(part.functionCall, 'functionCall')
        parts.push({ type: 'tool_call', id: `keyhide_call_${parts.length}`, name: typeof call.name === 'string' ? call.name : '', arguments: JSON.stringify(call.args ?? {}) })
        stopReason = 'tool_calls'
      } else if (part.thought === true || part.thoughtSignature !== undefined) {
        // 思考内容不属于最终回答；签名无法跨协议表达。
      } else {
        // inlineData 图片、代码执行等无法在目标协议中作为助手消息内容表达，忽略。
      }
    }
    if (typeof candidate.finishReason === 'string') {
      const normalized = normalizeStopReason(candidate.finishReason)
      stopReason = normalized === 'stop' && parts.some((part) => part.type === 'tool_call') ? 'tool_calls' : normalized
    }
  } else if (body.promptFeedback !== undefined) {
    const feedback = asRecord(body.promptFeedback, 'promptFeedback')
    if (feedback.blockReason !== undefined) stopReason = 'content_filter'
  }
  const usage = asRecord(body.usageMetadata ?? {}, 'usageMetadata')
  const prompt = numberOrZero(usage.promptTokenCount)
  const cached = numberOrZero(usage.cachedContentTokenCount)
  return {
    id: typeof body.responseId === 'string' ? body.responseId : '', model: typeof body.modelVersion === 'string' ? body.modelVersion : modelHint,
    created: Date.now(), content: parts, stopReason,
    usage: { input: Math.max(0, prompt - cached), output: numberOrZero(usage.candidatesTokenCount), cacheRead: cached || undefined, reasoning: numberOrZero(usage.thoughtsTokenCount) || undefined }
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function numberOrUndefined(value: unknown): number | undefined {
  const result = numberOrZero(value)
  return result || undefined
}

/* ------------------------------------------------------------------ */
/* 中间表示 → 下游响应                                                 */
/* ------------------------------------------------------------------ */

export function encodeResponse(protocol: ApiProtocol, response: IRResponse): Record<string, unknown> {
  if (protocol === 'anthropic') return encodeAnthropicResponse(response)
  if (protocol === 'openai-chat') return encodeChatResponse(response)
  if (protocol === 'openai-responses') return encodeResponsesResponse(response)
  return encodeGeminiResponse(response)
}

function textOfParts(content: IRPart[]): string {
  return content.filter((part) => part.type === 'text').map((part) => part.text).join('')
}

function encodeAnthropicResponse(response: IRResponse): Record<string, unknown> {
  const content: Record<string, unknown>[] = []
  for (const part of response.content) {
    if (part.type === 'text') content.push({ type: 'text', text: part.text })
    else if (part.type === 'tool_call') content.push({ type: 'tool_use', id: part.id, name: part.name, input: parseToolInput(part.arguments) })
    else throw new ProtocolConversionError('response.content', '无法编码的响应内容类型')
  }
  return {
    id: response.id || `msg_${Date.now().toString(36)}`, type: 'message', role: 'assistant', model: response.model,
    content, stop_reason: stopReasonToAnthropic(response.stopReason), stop_sequence: null,
    usage: { input_tokens: response.usage.input, output_tokens: response.usage.output, ...(response.usage.cacheRead ? { cache_read_input_tokens: response.usage.cacheRead } : {}), ...(response.usage.cacheWrite ? { cache_creation_input_tokens: response.usage.cacheWrite } : {}) }
  }
}

function parseToolInput(argumentsText: string): unknown {
  try { return JSON.parse(argumentsText || '{}') } catch { throw new ProtocolConversionError('tool_call.arguments', '工具参数不是有效 JSON') }
}

function encodeChatResponse(response: IRResponse): Record<string, unknown> {
  const calls = response.content.filter((part) => part.type === 'tool_call')
  const text = textOfParts(response.content)
  const prompt = usageTotal({ input: response.usage.input, output: 0, cacheRead: response.usage.cacheRead, cacheWrite: response.usage.cacheWrite })
  return {
    id: response.id || `chatcmpl_${Date.now().toString(36)}`, object: 'chat.completion', created: Math.floor(response.created / 1000),
    model: response.model,
    choices: [{
      index: 0, finish_reason: stopReasonToChat(response.stopReason),
      message: { role: 'assistant', content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls.map((part) => ({ id: part.id, type: 'function', function: { name: part.name, arguments: part.arguments || '{}' } })) } : {}) }
    }],
    usage: { prompt_tokens: prompt, completion_tokens: response.usage.output, total_tokens: prompt + response.usage.output, ...(response.usage.cacheRead ? { prompt_tokens_details: { cached_tokens: response.usage.cacheRead } } : {}) }
  }
}

function encodeResponsesResponse(response: IRResponse): Record<string, unknown> {
  const output: Record<string, unknown>[] = []
  const text = textOfParts(response.content)
  if (text) output.push({ id: `msg_${response.id || 'out'}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] })
  for (const part of response.content) {
    if (part.type === 'tool_call') output.push({ id: `fc_${part.id}`, type: 'function_call', status: 'completed', call_id: part.id, name: part.name, arguments: part.arguments || '{}' })
  }
  const prompt = usageTotal({ input: response.usage.input, output: 0, cacheRead: response.usage.cacheRead, cacheWrite: response.usage.cacheWrite })
  const status = stopReasonToResponsesStatus(response.stopReason)
  return {
    id: response.id || `resp_${Date.now().toString(36)}`, object: 'response', created_at: Math.floor(response.created / 1000), status, model: response.model,
    output, ...(status === 'incomplete' ? { incomplete_details: { reason: response.stopReason === 'content_filter' ? 'content_filter' : 'max_output_tokens' } } : {}),
    usage: { input_tokens: prompt, output_tokens: response.usage.output, total_tokens: prompt + response.usage.output, ...(response.usage.cacheRead ? { input_tokens_details: { cached_tokens: response.usage.cacheRead } } : {}), ...(response.usage.reasoning ? { output_tokens_details: { reasoning_tokens: response.usage.reasoning } } : {}) }
  }
}

function encodeGeminiResponse(response: IRResponse): Record<string, unknown> {
  const parts: Record<string, unknown>[] = []
  const text = textOfParts(response.content)
  if (text) parts.push({ text })
  for (const part of response.content) {
    if (part.type === 'tool_call') {
      let args: unknown = {}
      try { args = JSON.parse(part.arguments || '{}') } catch { throw new ProtocolConversionError('tool_call.arguments', '工具参数不是有效 JSON') }
      parts.push({ functionCall: { name: part.name, args } })
    }
  }
  const prompt = usageTotal({ input: response.usage.input, output: 0, cacheRead: response.usage.cacheRead, cacheWrite: response.usage.cacheWrite })
  return {
    candidates: [{ content: { role: 'model', parts }, index: 0, finishReason: stopReasonToGemini(response.stopReason) }],
    ...(response.id ? { responseId: response.id } : {}),
    modelVersion: response.model,
    usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: response.usage.output, totalTokenCount: prompt + response.usage.output, ...(response.usage.cacheRead ? { cachedContentTokenCount: response.usage.cacheRead } : {}), ...(response.usage.reasoning ? { thoughtsTokenCount: response.usage.reasoning } : {}) }
  }
}

/* ------------------------------------------------------------------ */
/* 错误转换                                                            */
/* ------------------------------------------------------------------ */

function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.message === 'string') return record.message
    if (typeof record.error === 'string') return record.error
  }
  return '上游返回错误'
}

export function decodeError(protocol: ApiProtocol, status: number, raw: Buffer, contentType: string): IRError {
  const text = raw.toString('utf8')
  try {
    const body = JSON.parse(text) as unknown
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const record = body as Record<string, unknown>
      const nested = record.error
      const error = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : record
      const message = errorMessage(nested && typeof nested === 'object' ? nested : body)
      const code = typeof error.code === 'string' ? error.code : typeof error.code === 'number' ? String(error.code) : typeof error.status === 'string' ? error.status : undefined
      const type = typeof error.type === 'string' ? error.type : undefined
      return { message: message.slice(0, 4096), code, type }
    }
  } catch { /* 非 JSON 错误正文按文本返回 */ }
  const trimmed = text.trim()
  return { message: (trimmed || `上游返回 HTTP ${status}`).slice(0, 4096) }
}

export function encodeErrorBody(protocol: ApiProtocol, status: number, error: IRError): Record<string, unknown> {
  const message = error.message || `上游返回 HTTP ${status}`
  if (protocol === 'anthropic') return { type: 'error', error: { type: error.type || 'api_error', message } }
  if (protocol === 'gemini') return { error: { code: status, message, status: error.code || 'INTERNAL' } }
  return { error: { message, type: error.type || 'upstream_error', code: error.code || String(status), param: null } }
}

export function emptyIRUsage(): IRUsage { return emptyUsage() }
