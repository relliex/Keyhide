import { StringDecoder } from 'string_decoder'
import type { ApiProtocol } from '../../shared/types'
import {
  ProtocolConversionError, normalizeStopReason, stopReasonToAnthropic, stopReasonToChat, stopReasonToGemini,
  stopReasonToResponsesStatus, emptyUsage,
  type IRPart, type IRResponse, type IRStreamEvent, type IRUsage, type StopReason
} from './ir'

interface SSEFrame { event: string; data: string }

/** 通用 SSE 读取器：支持 CRLF、多行 data、注释与分片 UTF-8，并限制单帧内存。 */
export async function* readSSE(source: AsyncIterable<Buffer | string>): AsyncGenerator<SSEFrame> {
  const MAX_LINE = 4 * 1024 * 1024
  const MAX_EVENT = 8 * 1024 * 1024
  const decoder = new StringDecoder('utf8')
  let line = ''
  let event = ''
  let data: string[] = []
  let eventBytes = 0
  let buffer = ''
  let skipUntilNewline = false
  const flush = (): SSEFrame | null => {
    if (!data.length) { event = ''; eventBytes = 0; return null }
    const frame = { event, data: data.join('\n') }
    event = ''; data = []; eventBytes = 0
    return frame
  }
  const handleLine = function* (raw: string): Generator<SSEFrame> {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!text) {
      const frame = flush()
      if (frame) yield frame
      return
    }
    if (text.startsWith(':')) return
    const colon = text.indexOf(':')
    const field = colon < 0 ? text : text.slice(0, colon)
    const value = colon < 0 ? '' : text.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data' && eventBytes + value.length <= MAX_EVENT) {
      data.push(value)
      eventBytes += value.length
    }
  }
  for await (const chunk of source) {
    let text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    if (skipUntilNewline) {
      const next = text.indexOf('\n')
      if (next < 0) continue
      text = text.slice(next + 1)
      skipUntilNewline = false
    }
    buffer += text
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.length <= MAX_LINE) yield* handleLine(line)
      index = buffer.indexOf('\n')
    }
    if (buffer.length > MAX_LINE) {
      // A single oversized line is discarded rather than retained until the next newline.
      buffer = ''
      skipUntilNewline = true
    }
  }
  buffer += decoder.end()
  if (!skipUntilNewline && buffer) yield* handleLine(buffer)
  const frame = flush()
  if (frame) yield frame
}

function parseJson(text: string): unknown {
  if (!text || text === '[DONE]') return null
  try { return JSON.parse(text) } catch { return null }
}

function usageFromAnthropic(value: unknown, target: IRUsage): void {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const input = number(usage.input_tokens)
  const output = number(usage.output_tokens)
  if (input !== undefined) target.input = input
  if (output !== undefined) target.output = output
  const cacheRead = number(usage.cache_read_input_tokens)
  const cacheWrite = number(usage.cache_creation_input_tokens)
  if (cacheRead !== undefined) target.cacheRead = cacheRead
  if (cacheWrite !== undefined) target.cacheWrite = cacheWrite
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

/* ------------------------------------------------------------------ */
/* 上游 SSE → 中间事件                                                 */
/* ------------------------------------------------------------------ */

export async function* decodeStream(protocol: ApiProtocol, source: AsyncIterable<Buffer | string>): AsyncGenerator<IRStreamEvent> {
  if (protocol === 'anthropic') yield* decodeAnthropicStream(source)
  else if (protocol === 'openai-chat') yield* decodeChatStream(source)
  else if (protocol === 'openai-responses') yield* decodeResponsesStream(source)
  else yield* decodeGeminiStream(source)
}

async function* decodeAnthropicStream(source: AsyncIterable<Buffer | string>): AsyncGenerator<IRStreamEvent> {
  let started = false
  let finished = false
  let id = ''
  let model = ''
  const usage: IRUsage = emptyUsage()
  let stop: StopReason = 'stop'
  const blocks = new Map<number, 'text' | 'tool' | 'other'>()
  const ensureStart = function* (): Generator<IRStreamEvent> {
    if (started) return
    started = true
    yield { type: 'start', id, model, usage: { input: usage.input } }
  }
  for await (const frame of readSSE(source)) {
    const body = parseJson(frame.data) as Record<string, unknown> | null
    if (!body) continue
    const type = typeof body.type === 'string' ? body.type : frame.event
    if (type === 'message_start') {
      const message = body.message && typeof body.message === 'object' ? body.message as Record<string, unknown> : {}
      id = typeof message.id === 'string' ? message.id : id
      model = typeof message.model === 'string' ? message.model : model
      usageFromAnthropic(message.usage, usage)
      yield* ensureStart()
    } else if (type === 'content_block_start') {
      const index = number(body.index) ?? blocks.size
      const block = body.content_block && typeof body.content_block === 'object' ? body.content_block as Record<string, unknown> : {}
      if (block.type === 'tool_use') {
        blocks.set(index, 'tool')
        yield* ensureStart()
        yield { type: 'tool_start', index, id: typeof block.id === 'string' ? block.id : `call_${index}`, name: typeof block.name === 'string' ? block.name : '' }
      } else if (block.type === 'text') {
        blocks.set(index, 'text')
        yield* ensureStart()
        yield { type: 'text_start', index }
      } else {
        // thinking 等其他块不可跨协议表达，保持位置但不输出。
        blocks.set(index, 'other')
      }
    } else if (type === 'content_block_delta') {
      const index = number(body.index) ?? 0
      const delta = body.delta && typeof body.delta === 'object' ? body.delta as Record<string, unknown> : {}
      if (delta.type === 'text_delta' && typeof delta.text === 'string') yield { type: 'text_delta', index, text: delta.text }
      else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') yield { type: 'tool_args_delta', index, delta: delta.partial_json }
    } else if (type === 'content_block_stop') {
      const index = number(body.index) ?? 0
      const kind = blocks.get(index)
      if (kind === 'tool') yield { type: 'tool_end', index }
      else if (kind === 'text') yield { type: 'text_end', index }
      blocks.delete(index)
    } else if (type === 'message_delta') {
      const delta = body.delta && typeof body.delta === 'object' ? body.delta as Record<string, unknown> : {}
      if (typeof delta.stop_reason === 'string') stop = normalizeStopReason(delta.stop_reason)
      usageFromAnthropic(body.usage, usage)
    } else if (type === 'message_stop') {
      for (const [index, kind] of blocks) {
        if (kind === 'tool') yield { type: 'tool_end', index }
        else if (kind === 'text') yield { type: 'text_end', index }
      }
      blocks.clear()
      finished = true
      yield { type: 'finish', stopReason: stop, usage }
    } else if (type === 'error') {
      const error = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : {}
      finished = true
      yield { type: 'error', message: typeof error.message === 'string' ? error.message : '上游流返回错误', code: typeof error.type === 'string' ? error.type : undefined }
    }
  }
  if (!finished) {
    for (const [index, kind] of blocks) {
      if (kind === 'tool') yield { type: 'tool_end', index }
      else if (kind === 'text') yield { type: 'text_end', index }
    }
    yield { type: 'finish', stopReason: stop, usage }
  }
}

async function* decodeChatStream(source: AsyncIterable<Buffer | string>): AsyncGenerator<IRStreamEvent> {
  let started = false
  let finished = false
  let id = ''
  let model = ''
  let textOpen = false
  const textIndex = 0
  const usage: IRUsage = emptyUsage()
  let stop: StopReason = 'stop'
  const tools = new Map<number, { index: number; id: string; name: string; open: boolean; args: string }>()
  let nextIndex = 1
  const ensureStart = function* (): Generator<IRStreamEvent> {
    if (started) return
    started = true
    yield { type: 'start', id, model, usage: { input: usage.input } }
  }
  const ensureText = function* (): Generator<IRStreamEvent> {
    yield* ensureStart()
    if (!textOpen) { textOpen = true; yield { type: 'text_start', index: textIndex } }
  }
  const closeText = function* (): Generator<IRStreamEvent> {
    if (!textOpen) return
    textOpen = false
    yield { type: 'text_end', index: textIndex }
  }
  for await (const frame of readSSE(source)) {
    if (frame.data === '[DONE]') break
    const body = parseJson(frame.data) as Record<string, unknown> | null
    if (!body) continue
    if (body.error) {
      const error = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : {}
      finished = true
      yield { type: 'error', message: typeof error.message === 'string' ? error.message : '上游流返回错误' }
      continue
    }
    if (typeof body.id === 'string') id = body.id
    if (typeof body.model === 'string') model = body.model
    if (body.usage && typeof body.usage === 'object') {
      const value = body.usage as Record<string, unknown>
      usage.input = number(value.prompt_tokens) ?? usage.input
      usage.output = number(value.completion_tokens) ?? usage.output
    }
    const choices = Array.isArray(body.choices) ? body.choices : []
    const choice = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : null
    if (!choice) continue
    const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta as Record<string, unknown> : {}
    if (typeof delta.content === 'string' && delta.content) {
      yield* ensureText()
      yield { type: 'text_delta', index: textIndex, text: delta.content }
    } else if (Array.isArray(delta.content)) {
      const text = delta.content.map((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string' ? String((item as Record<string, unknown>).text) : '').join('')
      if (text) { yield* ensureText(); yield { type: 'text_delta', index: textIndex, text } }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const rawCall of delta.tool_calls) {
        const call = rawCall && typeof rawCall === 'object' ? rawCall as Record<string, unknown> : null
        if (!call) continue
        const toolIndex = typeof call.index === 'number' ? call.index : 0
        let state = tools.get(toolIndex)
        if (!state) {
          state = { index: nextIndex++, id: '', name: '', open: false, args: '' }
          tools.set(toolIndex, state)
        }
        if (typeof call.id === 'string' && call.id) state.id = call.id
        const fn = call.function && typeof call.function === 'object' ? call.function as Record<string, unknown> : {}
        if (typeof fn.name === 'string' && fn.name) state.name += fn.name
        if (state.name && !state.open) {
          yield* ensureStart()
          state.open = true
          yield { type: 'tool_start', index: state.index, id: state.id || `call_${state.index}`, name: state.name }
          if (state.args) { yield { type: 'tool_args_delta', index: state.index, delta: state.args }; state.args = '' }
        }
        if (typeof fn.arguments === 'string' && fn.arguments) {
          if (state.open) yield { type: 'tool_args_delta', index: state.index, delta: fn.arguments }
          else state.args += fn.arguments
        }
      }
    }
    if (typeof choice.finish_reason === 'string') {
      stop = normalizeStopReason(choice.finish_reason)
      if (stop === 'stop' && tools.size) stop = 'tool_calls'
    }
  }
  if (!finished) {
    yield* closeText()
    for (const state of tools.values()) if (state.open) yield { type: 'tool_end', index: state.index }
    yield { type: 'finish', stopReason: stop, usage }
  }
}

async function* decodeResponsesStream(source: AsyncIterable<Buffer | string>): AsyncGenerator<IRStreamEvent> {
  let started = false
  let finished = false
  let id = ''
  let model = ''
  const usage: IRUsage = emptyUsage()
  let stop: StopReason = 'stop'
  const blocks = new Map<number, { kind: 'text' | 'tool'; id: string; name: string; text: string }>()
  const ensureStart = function* (): Generator<IRStreamEvent> {
    if (started) return
    started = true
    yield { type: 'start', id, model, usage: { input: usage.input } }
  }
  const ensureBlock = function* (index: number, kind: 'text' | 'tool', block: { id: string; name: string }): Generator<IRStreamEvent> {
    yield* ensureStart()
    if (blocks.has(index)) return
    blocks.set(index, { kind, id: block.id, name: block.name, text: '' })
    if (kind === 'text') yield { type: 'text_start', index }
    else yield { type: 'tool_start', index, id: block.id || `call_${index}`, name: block.name }
  }
  for await (const frame of readSSE(source)) {
    const body = parseJson(frame.data) as Record<string, unknown> | null
    if (!body) continue
    const type = typeof body.type === 'string' ? body.type : frame.event
    if (type === 'response.created' || type === 'response.in_progress') {
      const response = body.response && typeof body.response === 'object' ? body.response as Record<string, unknown> : {}
      if (typeof response.id === 'string') id = response.id
      if (typeof response.model === 'string') model = response.model
      if (response.usage && typeof response.usage === 'object') {
        const value = response.usage as Record<string, unknown>
        usage.input = number(value.input_tokens) ?? usage.input
        usage.output = number(value.output_tokens) ?? usage.output
      }
      yield* ensureStart()
    } else if (type === 'response.output_item.added') {
      const index = number(body.output_index) ?? blocks.size
      const item = body.item && typeof body.item === 'object' ? body.item as Record<string, unknown> : {}
      if (item.type === 'function_call') {
        yield* ensureBlock(index, 'tool', { id: typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : `call_${index}`, name: typeof item.name === 'string' ? item.name : '' })
      } else if (item.type === 'message' || item.type === undefined) {
        yield* ensureBlock(index, 'text', { id: typeof item.id === 'string' ? item.id : `msg_${index}`, name: '' })
      }
      // reasoning、web_search_call 等其他输出项不属于可见回答。
    } else if (type === 'response.output_text.delta') {
      const index = number(body.output_index) ?? 0
      const delta = typeof body.delta === 'string' ? body.delta : ''
      if (!delta) continue
      yield* ensureBlock(index, 'text', { id: typeof body.item_id === 'string' ? body.item_id : `msg_${index}`, name: '' })
      const block = blocks.get(index)
      if (block) block.text += delta
      yield { type: 'text_delta', index, text: delta }
    } else if (type === 'response.output_text.done') {
      // 文本结束由 output_item.done 统一处理。
    } else if (type === 'response.function_call_arguments.delta') {
      const index = number(body.output_index) ?? 0
      const delta = typeof body.delta === 'string' ? body.delta : ''
      if (!delta) continue
      yield* ensureBlock(index, 'tool', { id: typeof body.item_id === 'string' ? body.item_id : `call_${index}`, name: typeof body.name === 'string' ? body.name : '' })
      yield { type: 'tool_args_delta', index, delta }
    } else if (type === 'response.output_item.done') {
      const index = number(body.output_index) ?? 0
      const block = blocks.get(index)
      if (block) {
        blocks.delete(index)
        yield block.kind === 'text' ? { type: 'text_end', index } : { type: 'tool_end', index }
      }
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const response = body.response && typeof body.response === 'object' ? body.response as Record<string, unknown> : {}
      if (response.usage && typeof response.usage === 'object') {
        const value = response.usage as Record<string, unknown>
        const input = number(value.input_tokens)
        const cached = value.input_tokens_details && typeof value.input_tokens_details === 'object' ? number((value.input_tokens_details as Record<string, unknown>).cached_tokens) : undefined
        usage.input = input !== undefined ? Math.max(0, input - (cached || 0)) : usage.input
        usage.output = number(value.output_tokens) ?? usage.output
        if (cached) usage.cacheRead = cached
      }
      if (Array.isArray(response.output)) {
        for (const item of response.output) {
          if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'function_call') stop = 'tool_calls'
        }
      }
      if (type === 'response.incomplete') stop = 'length'
      for (const [index, block] of blocks) yield block.kind === 'text' ? { type: 'text_end', index } : { type: 'tool_end', index }
      blocks.clear()
      finished = true
      yield { type: 'finish', stopReason: stop, usage }
    } else if (type === 'response.failed' || type === 'error') {
      const response = body.response && typeof body.response === 'object' ? body.response as Record<string, unknown> : {}
      const error = response.error && typeof response.error === 'object' ? response.error as Record<string, unknown> : body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : {}
      finished = true
      yield { type: 'error', message: typeof error.message === 'string' ? error.message : '上游流返回错误' }
    }
  }
  if (!finished) {
    for (const [index, block] of blocks) yield block.kind === 'text' ? { type: 'text_end', index } : { type: 'tool_end', index }
    yield { type: 'finish', stopReason: stop, usage }
  }
}

async function* decodeGeminiStream(source: AsyncIterable<Buffer | string>): AsyncGenerator<IRStreamEvent> {
  let started = false
  let finished = false
  let model = ''
  let responseId = ''
  const usage: IRUsage = emptyUsage()
  let stop: StopReason = 'stop'
  let textOpen = false
  let textIndex = 0
  let toolCounter = 0
  const ensureStart = function* (): Generator<IRStreamEvent> {
    if (started) return
    started = true
    yield { type: 'start', id: responseId, model, usage: { input: usage.input } }
  }
  const closeText = function* (): Generator<IRStreamEvent> {
    if (!textOpen) return
    textOpen = false
    yield { type: 'text_end', index: textIndex }
  }
  const processChunk = function* (chunk: Record<string, unknown>): Generator<IRStreamEvent> {
    if (typeof chunk.responseId === 'string') responseId = chunk.responseId
    if (typeof chunk.modelVersion === 'string') model = chunk.modelVersion
    if (chunk.usageMetadata && typeof chunk.usageMetadata === 'object') {
      const value = chunk.usageMetadata as Record<string, unknown>
      const prompt = number(value.promptTokenCount)
      const cached = number(value.cachedContentTokenCount) || 0
      if (prompt !== undefined) usage.input = Math.max(0, prompt - cached)
      usage.output = number(value.candidatesTokenCount) ?? usage.output
      if (cached) usage.cacheRead = cached
      usage.reasoning = number(value.thoughtsTokenCount) ?? usage.reasoning
    }
    if (chunk.promptFeedback && typeof chunk.promptFeedback === 'object') {
      const feedback = chunk.promptFeedback as Record<string, unknown>
      if (feedback.blockReason !== undefined) { stop = 'content_filter'; finished = true; yield* closeText(); yield { type: 'finish', stopReason: stop, usage }; return }
    }
    const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : []
    const candidate = candidates[0] && typeof candidates[0] === 'object' ? candidates[0] as Record<string, unknown> : null
    if (!candidate) return
    const content = candidate.content && typeof candidate.content === 'object' ? candidate.content as Record<string, unknown> : {}
    const parts = Array.isArray(content.parts) ? content.parts : []
    for (const rawPart of parts) {
      const part = rawPart && typeof rawPart === 'object' ? rawPart as Record<string, unknown> : null
      if (!part) continue
      if (typeof part.text === 'string') {
        if (part.thought === true) continue
        yield* ensureStart()
        if (!textOpen) { textOpen = true; yield { type: 'text_start', index: textIndex } }
        yield { type: 'text_delta', index: textIndex, text: part.text }
      } else if (part.functionCall && typeof part.functionCall === 'object') {
        const call = part.functionCall as Record<string, unknown>
        const index = textIndex + 1 + toolCounter
        toolCounter++
        yield* ensureStart()
        yield { type: 'tool_start', index, id: `keyhide_call_${toolCounter}`, name: typeof call.name === 'string' ? call.name : '' }
        yield { type: 'tool_args_delta', index, delta: JSON.stringify(call.args ?? {}) }
        yield { type: 'tool_end', index }
        stop = 'tool_calls'
      }
    }
    if (typeof candidate.finishReason === 'string') {
      const normalized = normalizeStopReason(candidate.finishReason)
      stop = normalized === 'stop' && toolCounter ? 'tool_calls' : normalized
      yield* closeText()
      finished = true
      yield { type: 'finish', stopReason: stop, usage }
    }
  }
  for await (const frame of readSSE(source)) {
    const parsed = parseJson(frame.data)
    if (!parsed) continue
    const chunks = Array.isArray(parsed) ? parsed : [parsed]
    for (const raw of chunks) {
      if (!raw || typeof raw !== 'object') continue
      yield* processChunk(raw as Record<string, unknown>)
      if (finished) return
    }
  }
  if (!finished) {
    yield* closeText()
    yield { type: 'finish', stopReason: stop, usage }
  }
}

/* ------------------------------------------------------------------ */
/* 上游 SSE → 完整响应（下游要求非流式时使用）                         */
/* ------------------------------------------------------------------ */

export async function aggregateStream(protocol: ApiProtocol, source: AsyncIterable<Buffer | string>, modelFallback = ''): Promise<IRResponse> {
  let id = ''
  let model = modelFallback
  let stop: StopReason = 'stop'
  const usage = emptyUsage()
  const blocks = new Map<number, { kind: 'text' | 'tool'; text: string; id: string; name: string }>()
  for await (const event of decodeStream(protocol, source)) {
    if (event.type === 'start') {
      if (event.id) id = event.id
      if (event.model) model = event.model
      if (event.usage) {
        usage.input = event.usage.input || usage.input
        if (event.usage.cacheRead !== undefined) usage.cacheRead = event.usage.cacheRead
        if (event.usage.cacheWrite !== undefined) usage.cacheWrite = event.usage.cacheWrite
      }
    } else if (event.type === 'text_start') {
      blocks.set(event.index, { kind: 'text', text: '', id: '', name: '' })
    } else if (event.type === 'text_delta') {
      const block = blocks.get(event.index)
      if (block) block.text += event.text
    } else if (event.type === 'tool_start') {
      blocks.set(event.index, { kind: 'tool', text: '', id: event.id, name: event.name })
    } else if (event.type === 'tool_args_delta') {
      const block = blocks.get(event.index)
      if (block) block.text += event.delta
    } else if (event.type === 'finish') {
      stop = event.stopReason
      usage.input = event.usage.input || usage.input
      usage.output = event.usage.output
      if (event.usage.cacheRead !== undefined) usage.cacheRead = event.usage.cacheRead
      if (event.usage.cacheWrite !== undefined) usage.cacheWrite = event.usage.cacheWrite
    } else if (event.type === 'error') {
      throw new ProtocolConversionError('stream', event.message)
    }
  }
  const content: IRPart[] = []
  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0])
  for (const [, block] of ordered) {
    if (block.kind === 'text') {
      if (block.text) content.push({ type: 'text', text: block.text })
    } else content.push({ type: 'tool_call', id: block.id || 'call_unknown', name: block.name, arguments: block.text || '{}' })
  }
  return { id, model, created: Date.now(), content, stopReason: stop, usage }
}

/* ------------------------------------------------------------------ */
/* 中间事件 → 下游 SSE                                                 */
/* ------------------------------------------------------------------ */

interface StreamEncoder {
  push(event: IRStreamEvent): string[]
  end(): string[]
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function dataFrame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

export function createStreamEncoder(protocol: ApiProtocol, modelFallback: string): StreamEncoder {
  if (protocol === 'anthropic') return anthropicEncoder(modelFallback)
  if (protocol === 'openai-chat') return chatEncoder(modelFallback)
  if (protocol === 'openai-responses') return responsesEncoder(modelFallback)
  return geminiEncoder()
}

function anthropicEncoder(fallbackModel: string): StreamEncoder {
  let id = `msg_${Date.now().toString(36)}`
  let model = fallbackModel
  let finished = false
  let inputTokens = 0
  let cacheRead: number | undefined
  let cacheWrite: number | undefined
  const order = new Map<number, number>()
  let nextIndex = 0
  const blockIndex = (index: number): number => {
    if (!order.has(index)) order.set(index, nextIndex++)
    return order.get(index)!
  }
  return {
    push(event) {
      if (event.type === 'start') {
        if (event.id) id = event.id
        if (event.model) model = event.model
        inputTokens = event.usage?.input || 0
        cacheRead = event.usage?.cacheRead
        cacheWrite = event.usage?.cacheWrite
        return [frame('message_start', {
          type: 'message_start',
          message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0, ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}), ...(cacheWrite ? { cache_creation_input_tokens: cacheWrite } : {}) } }
        })]
      }
      if (event.type === 'text_start') return [frame('content_block_start', { type: 'content_block_start', index: blockIndex(event.index), content_block: { type: 'text', text: '' } })]
      if (event.type === 'text_delta') return [frame('content_block_delta', { type: 'content_block_delta', index: blockIndex(event.index), delta: { type: 'text_delta', text: event.text } })]
      if (event.type === 'text_end') return [frame('content_block_stop', { type: 'content_block_stop', index: blockIndex(event.index) })]
      if (event.type === 'tool_start') return [frame('content_block_start', { type: 'content_block_start', index: blockIndex(event.index), content_block: { type: 'tool_use', id: event.id, name: event.name, input: {} } })]
      if (event.type === 'tool_args_delta') return [frame('content_block_delta', { type: 'content_block_delta', index: blockIndex(event.index), delta: { type: 'input_json_delta', partial_json: event.delta } })]
      if (event.type === 'tool_end') return [frame('content_block_stop', { type: 'content_block_stop', index: blockIndex(event.index) })]
      if (event.type === 'finish') {
        finished = true
        return [
          frame('message_delta', { type: 'message_delta', delta: { stop_reason: stopReasonToAnthropic(event.stopReason), stop_sequence: null }, usage: { output_tokens: event.usage.output } }),
          frame('message_stop', { type: 'message_stop' })
        ]
      }
      if (event.type === 'error') { finished = true; return [frame('error', { type: 'error', error: { type: 'api_error', message: event.message } })] }
      return []
    },
    end() { return finished ? [] : [frame('message_stop', { type: 'message_stop' })] }
  }
}

function chatEncoder(fallbackModel: string): StreamEncoder {
  let id = `chatcmpl_${Date.now().toString(36)}`
  let model = fallbackModel
  let created = Math.floor(Date.now() / 1000)
  let finished = false
  const toolOrdinals = new Map<number, number>()
  let toolCounter = 0
  const chunk = (delta: unknown, finishReason: string | null, usage?: unknown): string => dataFrame({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {})
  })
  return {
    push(event) {
      if (event.type === 'start') {
        if (event.id) id = event.id
        if (event.model) model = event.model
        created = Math.floor(Date.now() / 1000)
        return [chunk({ role: 'assistant', content: '' }, null)]
      }
      if (event.type === 'text_delta') return [chunk({ content: event.text }, null)]
      if (event.type === 'tool_start') {
        if (!toolOrdinals.has(event.index)) toolOrdinals.set(event.index, toolCounter++)
        return [chunk({ tool_calls: [{ index: toolOrdinals.get(event.index), id: event.id, type: 'function', function: { name: event.name, arguments: '' } }] }, null)]
      }
      if (event.type === 'tool_args_delta') {
        if (!toolOrdinals.has(event.index)) toolOrdinals.set(event.index, toolCounter++)
        return [chunk({ tool_calls: [{ index: toolOrdinals.get(event.index), function: { arguments: event.delta } }] }, null)]
      }
      if (event.type === 'finish') {
        finished = true
        const prompt = (event.usage.input || 0) + (event.usage.cacheRead || 0) + (event.usage.cacheWrite || 0)
        return [chunk({}, stopReasonToChat(event.stopReason), { prompt_tokens: prompt, completion_tokens: event.usage.output, total_tokens: prompt + event.usage.output }), 'data: [DONE]\n\n']
      }
      if (event.type === 'error') { finished = true; return [dataFrame({ error: { message: event.message, type: 'upstream_error' } })] }
      return []
    },
    end() { return finished ? [] : ['data: [DONE]\n\n'] }
  }
}

function responsesEncoder(fallbackModel: string): StreamEncoder {
  let id = `resp_${Date.now().toString(36)}`
  let model = fallbackModel
  let created = Math.floor(Date.now() / 1000)
  let finished = false
  const blocks = new Map<number, { kind: 'text' | 'tool'; itemId: string; callId: string; name: string; text: string }>()
  const completedItems: Record<string, unknown>[] = []
  const order = new Map<number, number>()
  let nextIndex = 0
  const blockIndex = (index: number): number => {
    if (!order.has(index)) order.set(index, nextIndex++)
    return order.get(index)!
  }
  return {
    push(event) {
      if (event.type === 'start') {
        if (event.id) id = event.id
        if (event.model) model = event.model
        created = Math.floor(Date.now() / 1000)
        const response = { id, object: 'response', created_at: created, status: 'in_progress', model, output: [], usage: null }
        return [
          frame('response.created', { type: 'response.created', response }),
          frame('response.in_progress', { type: 'response.in_progress', response })
        ]
      }
      if (event.type === 'text_start') {
        const itemId = `msg_${blockIndex(event.index)}_${id}`
        blocks.set(event.index, { kind: 'text', itemId, callId: '', name: '', text: '' })
        return [
          frame('response.output_item.added', { type: 'response.output_item.added', output_index: blockIndex(event.index), item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } }),
          frame('response.content_part.added', { type: 'response.content_part.added', item_id: itemId, output_index: blockIndex(event.index), content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
        ]
      }
      if (event.type === 'text_delta') {
        const block = blocks.get(event.index)
        if (block) block.text += event.text
        return [frame('response.output_text.delta', { type: 'response.output_text.delta', item_id: block?.itemId || `msg_${blockIndex(event.index)}_${id}`, output_index: blockIndex(event.index), content_index: 0, delta: event.text })]
      }
      if (event.type === 'text_end') {
        const block = blocks.get(event.index)
        if (!block) return []
        blocks.delete(event.index)
        const item = { id: block.itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: block.text, annotations: [] }] }
        completedItems.push(item)
        return [
          frame('response.output_text.done', { type: 'response.output_text.done', item_id: block.itemId, output_index: blockIndex(event.index), content_index: 0, text: block.text }),
          frame('response.content_part.done', { type: 'response.content_part.done', item_id: block.itemId, output_index: blockIndex(event.index), content_index: 0, part: { type: 'output_text', text: block.text, annotations: [] } }),
          frame('response.output_item.done', { type: 'response.output_item.done', output_index: blockIndex(event.index), item })
        ]
      }
      if (event.type === 'tool_start') {
        const itemId = `fc_${event.id}_${blockIndex(event.index)}`
        blocks.set(event.index, { kind: 'tool', itemId, callId: event.id, name: event.name, text: '' })
        return [frame('response.output_item.added', { type: 'response.output_item.added', output_index: blockIndex(event.index), item: { id: itemId, type: 'function_call', status: 'in_progress', call_id: event.id, name: event.name, arguments: '' } })]
      }
      if (event.type === 'tool_args_delta') {
        const block = blocks.get(event.index)
        if (block) block.text += event.delta
        return [frame('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: block?.itemId || `fc_${blockIndex(event.index)}`, output_index: blockIndex(event.index), delta: event.delta })]
      }
      if (event.type === 'tool_end') {
        const block = blocks.get(event.index)
        if (!block) return []
        blocks.delete(event.index)
        const item = { id: block.itemId, type: 'function_call', status: 'completed', call_id: block.callId, name: block.name, arguments: block.text || '{}' }
        completedItems.push(item)
        return [
          frame('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: block.itemId, output_index: blockIndex(event.index), arguments: block.text || '{}' }),
          frame('response.output_item.done', { type: 'response.output_item.done', output_index: blockIndex(event.index), item })
        ]
      }
      if (event.type === 'finish') {
        finished = true
        const prompt = (event.usage.input || 0) + (event.usage.cacheRead || 0) + (event.usage.cacheWrite || 0)
        const status = stopReasonToResponsesStatus(event.stopReason)
        const response = {
          id, object: 'response', created_at: created, status, model, output: completedItems,
          ...(status === 'incomplete' ? { incomplete_details: { reason: event.stopReason === 'content_filter' ? 'content_filter' : 'max_output_tokens' } } : {}),
          usage: { input_tokens: prompt, output_tokens: event.usage.output, total_tokens: prompt + event.usage.output }
        }
        return [frame(status === 'incomplete' ? 'response.incomplete' : 'response.completed', { type: status === 'incomplete' ? 'response.incomplete' : 'response.completed', response })]
      }
      if (event.type === 'error') { finished = true; return [frame('error', { type: 'error', code: 'upstream_error', message: event.message, param: null })] }
      return []
    },
    end() { return finished ? [] : [] }
  }
}

function geminiEncoder(): StreamEncoder {
  let finished = false
  let pendingTool: { name: string; args: string } | null = null
  const usage = emptyUsage()
  const content = (parts: Record<string, unknown>[], finishReason?: string): Record<string, unknown> => ({
    candidates: [{ content: { role: 'model', parts }, index: 0, ...(finishReason ? { finishReason } : {}) }],
    ...(finishReason ? { usageMetadata: { promptTokenCount: (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0), candidatesTokenCount: usage.output, totalTokenCount: (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0) + usage.output } } : {})
  })
  return {
    push(event) {
      if (event.type === 'text_delta') { return [dataFrame(content([{ text: event.text }]))] }
      if (event.type === 'tool_start') { pendingTool = { name: event.name, args: '' }; return [] }
      if (event.type === 'tool_args_delta') { if (pendingTool) pendingTool.args += event.delta; return [] }
      if (event.type === 'tool_end') {
        if (!pendingTool) return []
        let args: unknown = {}
        try { args = pendingTool.args ? JSON.parse(pendingTool.args) : {} } catch { args = {} }
        const frameValue = content([{ functionCall: { name: pendingTool.name, args } }])
        pendingTool = null
        return [dataFrame(frameValue)]
      }
      if (event.type === 'finish') {
        usage.input = event.usage.input; usage.output = event.usage.output
        usage.cacheRead = event.usage.cacheRead; usage.cacheWrite = event.usage.cacheWrite
        finished = true
        return [dataFrame(content([], stopReasonToGemini(event.stopReason)))]
      }
      if (event.type === 'error') { finished = true; return [dataFrame({ error: { code: 502, message: event.message, status: 'INTERNAL' } })] }
      return []
    },
    end() { return finished ? [] : [dataFrame(content([], 'STOP'))] }
  }
}

/* ------------------------------------------------------------------ */
/* 驱动：解码 + 编码，写入下游                                         */
/* ------------------------------------------------------------------ */

export interface ConvertStreamResult { usage: IRUsage; error: string | null; events: number }

export async function pipeConvertedStream(options: {
  source: AsyncIterable<Buffer | string>
  upstreamProtocol: ApiProtocol
  downstreamProtocol: ApiProtocol
  model: string
  write: (frame: string) => Promise<void>
}): Promise<ConvertStreamResult> {
  const encoder = createStreamEncoder(options.downstreamProtocol, options.model)
  const usage = emptyUsage()
  let error: string | null = null
  let events = 0
  try {
    for await (const event of decodeStream(options.upstreamProtocol, options.source)) {
      events++
      if (event.type === 'start' && event.usage) {
        usage.input = event.usage.input || usage.input
        if (event.usage.cacheRead !== undefined) usage.cacheRead = event.usage.cacheRead
        if (event.usage.cacheWrite !== undefined) usage.cacheWrite = event.usage.cacheWrite
      }
      if (event.type === 'finish') {
        usage.input = event.usage.input || usage.input
        usage.output = event.usage.output
        if (event.usage.cacheRead !== undefined) usage.cacheRead = event.usage.cacheRead
        if (event.usage.cacheWrite !== undefined) usage.cacheWrite = event.usage.cacheWrite
      }
      if (event.type === 'error') error = event.message
      for (const output of encoder.push(event)) await options.write(output)
      if (event.type === 'error') return { usage, error, events }
    }
  } catch (failure) {
    if (failure instanceof ProtocolConversionError) {
      error = failure.message
      for (const output of encoder.push({ type: 'error', message: failure.message })) await options.write(output)
      return { usage, error, events }
    }
    throw failure
  }
  for (const output of encoder.end()) await options.write(output)
  return { usage, error, events }
}

export { ProtocolConversionError }
