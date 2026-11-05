import type { ApiProtocol } from '../../shared/types'
import {
  ProtocolConversionError, asArray, asRecord, optionalNumber, optionalString, parseDataUrl, parseJsonValue,
  type IRContent, type IRMessage, type IRPart, type IRRequest, type IRTool, type IRToolChoice
} from './ir'

/* ------------------------------------------------------------------ */
/* 下游请求 → 中间表示                                                 */
/* ------------------------------------------------------------------ */

export function decodeRequest(protocol: ApiProtocol, body: unknown, modelFromPath: string): IRRequest {
  if (protocol === 'anthropic') return decodeAnthropicRequest(body, modelFromPath)
  if (protocol === 'openai-chat') return decodeChatRequest(body, modelFromPath)
  if (protocol === 'openai-responses') return decodeResponsesRequest(body, modelFromPath)
  return decodeGeminiRequest(body, modelFromPath)
}

function requestModel(body: Record<string, unknown>, fallback: string): string {
  const model = optionalString(body.model, 'model') || fallback
  if (!model) throw new ProtocolConversionError('model', '缺少模型名称')
  return model
}

function requestStream(body: Record<string, unknown>, fallback = false): boolean {
  return body.stream === true || fallback
}

function decodeAnthropicRequest(value: unknown, modelFromPath: string): IRRequest {
  const body = asRecord(value, 'body')
  const system: string[] = []
  if (body.system !== undefined) {
    if (typeof body.system === 'string') system.push(body.system)
    else for (const block of asArray(body.system, 'system')) {
      const item = asRecord(block, 'system')
      if (item.type !== 'text' || typeof item.text !== 'string') throw new ProtocolConversionError('system', '只支持文本 system 内容')
      system.push(item.text)
    }
  }
  const messages: IRMessage[] = []
  for (const raw of asArray(body.messages, 'messages')) {
    const message = asRecord(raw, 'messages')
    const role = message.role
    if (role !== 'user' && role !== 'assistant') throw new ProtocolConversionError('messages.role', '只支持 user/assistant 角色')
    messages.push({ role, parts: anthropicContent(message.content) })
  }
  const tools = anthropicTools(body.tools)
  return {
    model: requestModel(body, modelFromPath), system, messages: dropAssistantImages(messages), tools,
    toolChoice: anthropicToolChoice(body.tool_choice), stream: requestStream(body),
    maxTokens: optionalNumber(body.max_tokens, 'max_tokens', true),
    temperature: optionalNumber(body.temperature, 'temperature'),
    topP: optionalNumber(body.top_p, 'top_p'),
    topK: optionalNumber(body.top_k, 'top_k'),
    stop: stopSequences(body.stop_sequences)
  }
}

/** 助手历史中的图片在多数目标协议中无法表达；保留文字/工具调用，避免整个请求失败。 */
function dropAssistantImages(messages: IRMessage[]): IRMessage[] {
  const result: IRMessage[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') { result.push(message); continue }
    const parts = message.parts.filter((part) => part.type !== 'image')
    if (parts.length) result.push({ role: 'assistant', parts })
  }
  return result
}

function anthropicContent(value: unknown): IRPart[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  const parts: IRPart[] = []
  for (const raw of asArray(value, 'messages.content')) {
    const block = asRecord(raw, 'messages.content')
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw new ProtocolConversionError('messages.content.text', '必须是字符串')
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const source = asRecord(block.source, 'messages.content.image.source')
      if (source.type !== 'base64' || typeof source.data !== 'string' || typeof source.media_type !== 'string') {
        throw new ProtocolConversionError('messages.content.image', '只支持 base64 图片，不抓取外部图片 URL')
      }
      parts.push({ type: 'image', mediaType: source.media_type, data: source.data })
    } else if (block.type === 'tool_use') {
      const id = optionalString(block.id, 'tool_use.id')
      const name = optionalString(block.name, 'tool_use.name')
      if (!id || !name) throw new ProtocolConversionError('tool_use', '缺少 id 或 name')
      parts.push({ type: 'tool_call', id, name, arguments: JSON.stringify(block.input ?? {}) })
    } else if (block.type === 'tool_result') {
      const toolCallId = optionalString(block.tool_use_id, 'tool_result.tool_use_id')
      if (!toolCallId) throw new ProtocolConversionError('tool_result', '缺少 tool_use_id')
      parts.push({ type: 'tool_result', toolCallId, content: resultContent(block.content, 'tool_result.content') })
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // 推理轨迹与签名无法跨协议表达，保留可见文本和工具调用即可。
    } else {
      throw new ProtocolConversionError('messages.content.type', `无法转换的内容类型 ${String(block.type)}`)
    }
  }
  return parts
}

function resultContent(value: unknown, field: string): IRContent[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  const parts: IRContent[] = []
  for (const raw of asArray(value, field)) {
    const block = asRecord(raw, field)
    if (block.type === 'text' && typeof block.text === 'string') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image') {
      const source = asRecord(block.source, `${field}.source`)
      if (source.type !== 'base64' || typeof source.data !== 'string' || typeof source.media_type !== 'string') throw new ProtocolConversionError(field, '只支持 base64 图片')
      parts.push({ type: 'image', mediaType: source.media_type, data: source.data })
    } else throw new ProtocolConversionError(field, '只支持文本或 base64 图片')
  }
  return parts
}

function anthropicTools(value: unknown): IRTool[] {
  if (value === undefined) return []
  const tools: IRTool[] = []
  for (const raw of asArray(value, 'tools')) {
    const tool = asRecord(raw, 'tools')
    const name = optionalString(tool.name, 'tools.name')
    if (!name) throw new ProtocolConversionError('tools.name', '缺少名称')
    tools.push({ name, description: optionalString(tool.description, 'tools.description') || '', parameters: asRecord(tool.input_schema ?? { type: 'object', properties: {} }, 'tools.input_schema') })
  }
  return tools
}

function anthropicToolChoice(value: unknown): IRToolChoice | undefined {
  if (value === undefined || value === null) return undefined
  const choice = asRecord(value, 'tool_choice')
  if (choice.type === 'auto') return 'auto'
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  if (choice.type === 'tool') {
    const name = optionalString(choice.name, 'tool_choice.name')
    if (!name) throw new ProtocolConversionError('tool_choice.name', '缺少工具名称')
    return { name }
  }
  throw new ProtocolConversionError('tool_choice.type', '不支持的工具选择方式')
}

function stopSequences(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return [value]
  return asArray(value, 'stop_sequences').map((item, index) => {
    if (typeof item !== 'string') throw new ProtocolConversionError(`stop_sequences.${index}`, '必须是字符串')
    return item
  })
}

function decodeChatRequest(value: unknown, modelFromPath: string): IRRequest {
  const body = asRecord(value, 'body')
  if (body.n !== undefined && body.n !== 1) throw new ProtocolConversionError('n', '跨协议只支持单个候选结果')
  if (body.audio !== undefined || body.modalities !== undefined) throw new ProtocolConversionError('body', '跨协议无法传递音频或多种模态输出')
  if (body.response_format !== undefined) throw new ProtocolConversionError('response_format', '跨协议无法保证结构化输出约束')
  if (body.web_search_options !== undefined) throw new ProtocolConversionError('web_search_options', '跨协议无法传递供应商搜索工具')
  const system: string[] = []
  const messages: IRMessage[] = []
  let lastAssistant: IRMessage | null = null
  for (const raw of asArray(body.messages, 'messages')) {
    const message = asRecord(raw, 'messages')
    const role = message.role
    if (role === 'system' || role === 'developer') {
      for (const part of chatContent(message.content, 'system', true)) if (part.type === 'text') system.push(part.text)
      continue
    }
    if (role === 'tool' || role === 'function') {
      const toolCallId = optionalString(message.tool_call_id, 'messages.tool_call_id')
      if (!toolCallId) throw new ProtocolConversionError('messages.tool_call_id', '工具结果缺少 tool_call_id')
      const content = chatContent(message.content, 'messages.content', true).filter((part): part is IRContent => part.type === 'text')
      messages.push({ role: 'user', parts: [{ type: 'tool_result', toolCallId, content: content.length ? content : [{ type: 'text', text: '' }] }] })
      lastAssistant = null
      continue
    }
    if (role !== 'user' && role !== 'assistant') throw new ProtocolConversionError('messages.role', `不支持的角色 ${String(role)}`)
    const parts = chatContent(message.content, 'messages.content', true)
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const rawCall of message.tool_calls) {
        const call = asRecord(rawCall, 'tool_calls')
        const fn = asRecord(call.function, 'tool_calls.function')
        const name = optionalString(fn.name, 'tool_calls.function.name')
        if (!name) throw new ProtocolConversionError('tool_calls.function.name', '缺少工具名称')
        parts.push({ type: 'tool_call', id: optionalString(call.id, 'tool_calls.id') || `call_${messages.length}_${parts.length}`, name, arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}) })
      }
    }
    if (role === 'assistant' && lastAssistant) {
      // 连续 assistant 片段合并，保持同一轮工具调用的关联。
      lastAssistant.parts.push(...parts)
    } else {
      const messageItem: IRMessage = { role, parts }
      messages.push(messageItem)
      lastAssistant = role === 'assistant' ? messageItem : null
    }
  }
  return {
    model: requestModel(body, modelFromPath), system, messages: dropAssistantImages(messages), tools: chatTools(body.tools),
    toolChoice: chatToolChoice(body.tool_choice), stream: requestStream(body),
    maxTokens: optionalNumber(body.max_completion_tokens ?? body.max_tokens, 'max_tokens', true),
    temperature: optionalNumber(body.temperature, 'temperature'),
    topP: optionalNumber(body.top_p, 'top_p'),
    stop: stopSequences(body.stop)
  }
}

function chatContent(value: unknown, field: string, allowImages: boolean): IRPart[] {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value)) throw new ProtocolConversionError(field, '必须是字符串或内容数组')
  const parts: IRPart[] = []
  for (const raw of value) {
    const part = typeof raw === 'string' ? { type: 'text', text: raw } : asRecord(raw, field)
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw new ProtocolConversionError(`${field}.text`, '必须是字符串')
      parts.push({ type: 'text', text: part.text })
    } else if (part.type === 'image_url') {
      if (!allowImages) throw new ProtocolConversionError(field, '该角色不支持图片内容')
      const image = asRecord(part.image_url, `${field}.image_url`)
      if (typeof image.url !== 'string') throw new ProtocolConversionError(`${field}.image_url.url`, '缺少图片地址')
      const decoded = parseDataUrl(image.url, `${field}.image_url`)
      parts.push({ type: 'image', mediaType: decoded.mediaType, data: decoded.data })
    } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
      parts.push({ type: 'text', text: part.refusal })
    } else {
      throw new ProtocolConversionError(`${field}.type`, `无法转换的内容类型 ${String(part.type)}`)
    }
  }
  return parts
}

function chatTools(value: unknown): IRTool[] {
  if (value === undefined) return []
  const tools: IRTool[] = []
  for (const raw of asArray(value, 'tools')) {
    const tool = asRecord(raw, 'tools')
    if (tool.type !== 'function') throw new ProtocolConversionError('tools.type', '跨协议只支持 function 工具')
    const fn = asRecord(tool.function, 'tools.function')
    const name = optionalString(fn.name, 'tools.function.name')
    if (!name) throw new ProtocolConversionError('tools.function.name', '缺少工具名称')
    tools.push({ name, description: optionalString(fn.description, 'tools.function.description') || '', parameters: asRecord(fn.parameters ?? { type: 'object', properties: {} }, 'tools.function.parameters') })
  }
  return tools
}

function chatToolChoice(value: unknown): IRToolChoice | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    if (value === 'auto' || value === 'none' || value === 'required') return value
    throw new ProtocolConversionError('tool_choice', '不支持的工具选择方式')
  }
  const choice = asRecord(value, 'tool_choice')
  if (choice.type === 'function') {
    const fn = asRecord(choice.function, 'tool_choice.function')
    const name = optionalString(fn.name, 'tool_choice.function.name')
    if (!name) throw new ProtocolConversionError('tool_choice.function.name', '缺少工具名称')
    return { name }
  }
  throw new ProtocolConversionError('tool_choice.type', '不支持的工具选择方式')
}

function decodeResponsesRequest(value: unknown, modelFromPath: string): IRRequest {
  const body = asRecord(value, 'body')
  if (body.previous_response_id !== undefined) throw new ProtocolConversionError('previous_response_id', '跨协议不支持服务端会话续接')
  if (body.background === true) throw new ProtocolConversionError('background', '跨协议不支持后台任务')
  if (body.conversation !== undefined) throw new ProtocolConversionError('conversation', '跨协议不支持服务端会话对象')
  if (body.text !== undefined) {
    const text = asRecord(body.text, 'text')
    if (text.format !== undefined) throw new ProtocolConversionError('text.format', '跨协议无法保证结构化输出约束')
  }
  const system: string[] = []
  if (typeof body.instructions === 'string') system.push(body.instructions)
  else if (body.instructions !== undefined) throw new ProtocolConversionError('instructions', '必须是字符串')
  const messages: IRMessage[] = []
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', parts: [{ type: 'text', text: body.input }] })
  } else {
    for (const raw of asArray(body.input, 'input')) {
      const item = asRecord(raw, 'input')
      if (item.type === 'message') {
        const role = item.role
        if (role === 'system' || role === 'developer') {
          for (const part of responsesContent(item.content, 'input.content', true)) if (part.type === 'text') system.push(part.text)
          continue
        }
        if (role !== 'user' && role !== 'assistant') throw new ProtocolConversionError('input.role', `不支持的角色 ${String(role)}`)
        messages.push({ role, parts: responsesContent(item.content, 'input.content', true) })
      } else if (item.type === 'reasoning') {
        // 旧 Responses 推理项不参与可见对话，跨协议时忽略。
        continue
      } else if (item.type === 'function_call') {
        const callId = optionalString(item.call_id, 'input.call_id')
        const name = optionalString(item.name, 'input.name')
        if (!callId || !name) throw new ProtocolConversionError('input.function_call', '缺少 call_id 或 name')
        messages.push({ role: 'assistant', parts: [{ type: 'tool_call', id: callId, name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) }] })
      } else if (item.type === 'function_call_output') {
        const callId = optionalString(item.call_id, 'input.call_id')
        if (!callId) throw new ProtocolConversionError('input.function_call_output', '缺少 call_id')
        if (typeof item.output !== 'string') throw new ProtocolConversionError('input.function_call_output.output', '只支持文本输出')
        messages.push({ role: 'user', parts: [{ type: 'tool_result', toolCallId: callId, content: [{ type: 'text', text: item.output }] }] })
      } else {
        throw new ProtocolConversionError('input.type', `无法转换的输入项 ${String(item.type)}`)
      }
    }
  }
  return {
    model: requestModel(body, modelFromPath), system, messages: dropAssistantImages(messages),
    tools: responsesTools(body.tools), toolChoice: responsesToolChoice(body.tool_choice),
    stream: requestStream(body),
    maxTokens: optionalNumber(body.max_output_tokens, 'max_output_tokens', true),
    temperature: optionalNumber(body.temperature, 'temperature'),
    topP: optionalNumber(body.top_p, 'top_p'),
    stop: undefined
  }
}

function responsesContent(value: unknown, field: string, allowImages: boolean): IRPart[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  const parts: IRPart[] = []
  for (const raw of asArray(value, field)) {
    const part = asRecord(raw, field)
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      if (typeof part.text !== 'string') throw new ProtocolConversionError(`${field}.text`, '必须是字符串')
      parts.push({ type: 'text', text: part.text })
    } else if (part.type === 'input_image') {
      if (!allowImages) throw new ProtocolConversionError(field, '该角色不支持图片内容')
      if (typeof part.image_url !== 'string') throw new ProtocolConversionError(`${field}.image_url`, '只支持 data URL 图片')
      const decoded = parseDataUrl(part.image_url, `${field}.image_url`)
      parts.push({ type: 'image', mediaType: decoded.mediaType, data: decoded.data })
    } else {
      throw new ProtocolConversionError(`${field}.type`, `无法转换的内容类型 ${String(part.type)}`)
    }
  }
  return parts
}

function responsesTools(value: unknown): IRTool[] {
  if (value === undefined) return []
  const tools: IRTool[] = []
  for (const raw of asArray(value, 'tools')) {
    const tool = asRecord(raw, 'tools')
    if (tool.type !== 'function') throw new ProtocolConversionError('tools.type', '跨协议只支持 function 工具')
    const name = optionalString(tool.name, 'tools.name')
    if (!name) throw new ProtocolConversionError('tools.name', '缺少工具名称')
    tools.push({ name, description: optionalString(tool.description, 'tools.description') || '', parameters: asRecord(tool.parameters ?? { type: 'object', properties: {} }, 'tools.parameters') })
  }
  return tools
}

function responsesToolChoice(value: unknown): IRToolChoice | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    if (value === 'auto' || value === 'none' || value === 'required') return value
    throw new ProtocolConversionError('tool_choice', '不支持的工具选择方式')
  }
  const choice = asRecord(value, 'tool_choice')
  if (choice.type === 'function') {
    const name = optionalString(choice.name, 'tool_choice.name')
    if (!name) throw new ProtocolConversionError('tool_choice.name', '缺少工具名称')
    return { name }
  }
  throw new ProtocolConversionError('tool_choice.type', '不支持的工具选择方式')
}

function decodeGeminiRequest(value: unknown, modelFromPath: string): IRRequest {
  const body = asRecord(value, 'body')
  if (body.cachedContent !== undefined) throw new ProtocolConversionError('cachedContent', '跨协议不支持缓存内容引用')
  if (body.generationConfig !== undefined) {
    const config = asRecord(body.generationConfig, 'generationConfig')
    if (config.candidateCount !== undefined && config.candidateCount !== 1) throw new ProtocolConversionError('generationConfig.candidateCount', '跨协议只支持单个候选结果')
    if (config.responseMimeType !== undefined || config.responseSchema !== undefined) throw new ProtocolConversionError('generationConfig', '跨协议无法保证结构化输出约束')
  }
  const system: string[] = []
  if (body.systemInstruction !== undefined) {
    const instruction = asRecord(body.systemInstruction, 'systemInstruction')
    for (const part of geminiParts(instruction.parts, 'systemInstruction.parts', true)) if (part.type === 'text') system.push(part.text)
  }
  const messages: IRMessage[] = []
  const callIds = new Map<string, string>()
  let callCounter = 0
  for (const raw of asArray(body.contents, 'contents')) {
    const content = asRecord(raw, 'contents')
    const role = content.role === undefined ? 'user' : content.role
    if (role !== 'user' && role !== 'model') throw new ProtocolConversionError('contents.role', '只支持 user/model 角色')
    const parts: IRPart[] = []
    for (const rawPart of asArray(content.parts, 'contents.parts')) {
      const part = asRecord(rawPart, 'contents.parts')
      if (part.text !== undefined) {
        if (typeof part.text !== 'string') throw new ProtocolConversionError('contents.parts.text', '必须是字符串')
        if (part.thought === true) continue
        parts.push({ type: 'text', text: part.text })
      } else if (part.inlineData !== undefined) {
        const data = asRecord(part.inlineData, 'contents.parts.inlineData')
        if (typeof data.data !== 'string' || typeof data.mimeType !== 'string' || !data.mimeType.startsWith('image/')) throw new ProtocolConversionError('contents.parts.inlineData', '只支持 base64 图片')
        parts.push({ type: 'image', mediaType: data.mimeType, data: data.data })
      } else if (part.functionCall !== undefined) {
        const call = asRecord(part.functionCall, 'contents.parts.functionCall')
        const name = optionalString(call.name, 'functionCall.name')
        if (!name) throw new ProtocolConversionError('functionCall.name', '缺少工具名称')
        const id = `keyhide_call_${++callCounter}`
        callIds.set(name, id)
        parts.push({ type: 'tool_call', id, name, arguments: JSON.stringify(call.args ?? {}) })
      } else if (part.functionResponse !== undefined) {
        const result = asRecord(part.functionResponse, 'contents.parts.functionResponse')
        const name = optionalString(result.name, 'functionResponse.name')
        if (!name) throw new ProtocolConversionError('functionResponse.name', '缺少工具名称')
        const text = result.response === undefined ? '' : typeof result.response === 'string' ? result.response : JSON.stringify(result.response)
        parts.push({ type: 'tool_result', toolCallId: callIds.get(name) || name, name, content: [{ type: 'text', text }] })
      } else if (part.thought === true || part.thoughtSignature !== undefined) {
        throw new ProtocolConversionError('contents.parts', '跨协议无法传递思考签名')
      } else if (part.fileData !== undefined || part.executableCode !== undefined || part.codeExecutionResult !== undefined) {
        throw new ProtocolConversionError('contents.parts', '跨协议无法传递文件、代码执行或供应商内置内容')
      } else {
        throw new ProtocolConversionError('contents.parts', '无法识别的内容块')
      }
    }
    messages.push({ role: role === 'model' ? 'assistant' : 'user', parts })
  }
  const config = body.generationConfig === undefined ? {} : asRecord(body.generationConfig, 'generationConfig')
  return {
    model: requestModel(body, modelFromPath), system, messages: dropAssistantImages(messages),
    tools: geminiTools(body.tools), toolChoice: geminiToolChoice(body.toolConfig),
    stream: requestStream(body),
    maxTokens: optionalNumber(config.maxOutputTokens, 'generationConfig.maxOutputTokens', true),
    temperature: optionalNumber(config.temperature, 'generationConfig.temperature'),
    topP: optionalNumber(config.topP, 'generationConfig.topP'),
    topK: optionalNumber(config.topK, 'generationConfig.topK'),
    stop: stopSequences(config.stopSequences)
  }
}

function geminiParts(value: unknown, field: string, allowImages: boolean): IRPart[] {
  const parts: IRPart[] = []
  for (const raw of asArray(value, field)) {
    const part = asRecord(raw, field)
    if (part.text !== undefined) {
      if (typeof part.text !== 'string') throw new ProtocolConversionError(`${field}.text`, '必须是字符串')
      parts.push({ type: 'text', text: part.text })
    } else if (part.inlineData !== undefined && allowImages) {
      const data = asRecord(part.inlineData, `${field}.inlineData`)
      if (typeof data.data !== 'string' || typeof data.mimeType !== 'string' || !data.mimeType.startsWith('image/')) throw new ProtocolConversionError(field, '只支持 base64 图片')
      parts.push({ type: 'image', mediaType: data.mimeType, data: data.data })
    } else {
      throw new ProtocolConversionError(field, 'system 指令只支持文本')
    }
  }
  return parts
}

function geminiTools(value: unknown): IRTool[] {
  if (value === undefined) return []
  const tools: IRTool[] = []
  for (const raw of asArray(value, 'tools')) {
    const tool = asRecord(raw, 'tools')
    if (tool.functionDeclarations === undefined) throw new ProtocolConversionError('tools', '跨协议只支持函数工具声明')
    for (const rawFn of asArray(tool.functionDeclarations, 'tools.functionDeclarations')) {
      const fn = asRecord(rawFn, 'functionDeclarations')
      const name = optionalString(fn.name, 'functionDeclarations.name')
      if (!name) throw new ProtocolConversionError('functionDeclarations.name', '缺少工具名称')
      tools.push({ name, description: optionalString(fn.description, 'functionDeclarations.description') || '', parameters: asRecord(fn.parameters ?? { type: 'object', properties: {} }, 'functionDeclarations.parameters') })
    }
  }
  return tools
}

function geminiToolChoice(value: unknown): IRToolChoice | undefined {
  if (value === undefined) return undefined
  const config = asRecord(value, 'toolConfig')
  if (config.functionCallingConfig === undefined) return undefined
  const calling = asRecord(config.functionCallingConfig, 'functionCallingConfig')
  const mode = calling.mode
  if (mode === 'AUTO') return 'auto'
  if (mode === 'NONE') return 'none'
  if (mode === 'ANY') {
    const names = calling.allowedFunctionNames
    if (Array.isArray(names) && names.length === 1) {
      if (typeof names[0] !== 'string') throw new ProtocolConversionError('allowedFunctionNames', '必须是字符串数组')
      return { name: names[0] as string }
    }
    return 'required'
  }
  throw new ProtocolConversionError('functionCallingConfig.mode', '不支持的工具选择方式')
}

/* ------------------------------------------------------------------ */
/* 中间表示 → 上游请求                                                 */
/* ------------------------------------------------------------------ */

export function encodeRequest(protocol: ApiProtocol, request: IRRequest): Record<string, unknown> {
  if (protocol === 'anthropic') return encodeAnthropicRequest(request)
  if (protocol === 'openai-chat') return encodeChatRequest(request)
  if (protocol === 'openai-responses') return encodeResponsesRequest(request)
  return encodeGeminiRequest(request)
}

function encodeAnthropicRequest(request: IRRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens ?? 4096,
    messages: request.messages.map((message) => ({ role: message.role, content: anthropicBlocks(message, false) }))
  }
  if (request.system.length) body.system = request.system.join('\n\n')
  if (request.tools.length) body.tools = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
  if (request.toolChoice !== undefined) body.tool_choice = encodeAnthropicToolChoice(request.toolChoice)
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.topP !== undefined) body.top_p = request.topP
  if (request.topK !== undefined) body.top_k = request.topK
  if (request.stop?.length) body.stop_sequences = request.stop
  body.stream = request.stream
  return body
}

function encodeAnthropicToolChoice(choice: IRToolChoice): Record<string, unknown> {
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'none') return { type: 'none' }
  if (choice === 'required') return { type: 'any' }
  return { type: 'tool', name: choice.name }
}

function anthropicBlocks(message: IRMessage, allowImages = true): unknown[] {
  const blocks: unknown[] = []
  for (const part of message.parts) {
    if (part.type === 'text') blocks.push({ type: 'text', text: part.text })
    else if (part.type === 'image') {
      if (!allowImages || message.role === 'assistant') throw new ProtocolConversionError('messages.content.image', 'Anthropic 只支持 user 消息中的图片')
      blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } })
    } else if (part.type === 'tool_call') {
      blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: parseJsonValue(part.arguments, 'tool_call.arguments') })
    } else {
      const content = part.content.length === 1 && part.content[0].type === 'text'
        ? part.content[0].text
        : part.content.map((item) => item.type === 'text' ? { type: 'text', text: item.text } : { type: 'image', source: { type: 'base64', media_type: item.mediaType, data: item.data } })
      blocks.push({ type: 'tool_result', tool_use_id: part.toolCallId, content })
    }
  }
  return blocks
}

function encodeChatRequest(request: IRRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  if (request.system.length) messages.push({ role: 'system', content: request.system.join('\n\n') })
  for (const message of request.messages) {
    if (message.role === 'assistant') {
      const content = message.parts.filter((part) => part.type === 'text' || part.type === 'image')
      const calls = message.parts.filter((part) => part.type === 'tool_call')
      if (content.some((part) => part.type === 'image')) throw new ProtocolConversionError('messages.content.image', 'Chat Completions 不支持 assistant 图片')
      if (!content.length && !calls.length) continue
      const item: Record<string, unknown> = { role: 'assistant', content: content.length ? content.map((part) => part.type === 'text' ? part.text : '').join('') : null }
      if (calls.length) item.tool_calls = calls.map((part) => part.type === 'tool_call' ? { id: part.id, type: 'function', function: { name: part.name, arguments: part.arguments || '{}' } } : null).filter(Boolean)
      messages.push(item)
      continue
    }
    let pending: IRPart[] = []
    const flush = (): void => {
      if (!pending.length) return
      const content = pending.map((part) => part.type === 'text' ? { type: 'text', text: part.text } : part.type === 'image' ? { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } } : null).filter(Boolean)
      const singleText = pending.length === 1 && pending[0].type === 'text'
      messages.push({ role: 'user', content: singleText ? (pending[0] as { text: string }).text : content })
      pending = []
    }
    for (const part of message.parts) {
      if (part.type === 'tool_result') {
        flush()
        messages.push({ role: 'tool', tool_call_id: part.toolCallId, content: part.content.map((item) => item.type === 'text' ? item.text : '').join('') })
      } else if (part.type === 'text' || part.type === 'image') pending.push(part)
    }
    flush()
  }
  const body: Record<string, unknown> = { model: request.model, messages, stream: request.stream }
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.topP !== undefined) body.top_p = request.topP
  if (request.stop?.length) body.stop = request.stop
  if (request.tools.length) body.tools = request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
  if (request.toolChoice !== undefined) body.tool_choice = encodeChatToolChoice(request.toolChoice)
  return body
}

function encodeChatToolChoice(choice: IRToolChoice): unknown {
  return typeof choice === 'string' ? choice : { type: 'function', function: { name: choice.name } }
}

function encodeResponsesRequest(request: IRRequest): Record<string, unknown> {
  const input: Record<string, unknown>[] = []
  for (const message of request.messages) {
    let pending: IRPart[] = []
    const flush = (): void => {
      if (!pending.length) return
      input.push({
        type: 'message', role: message.role,
        content: pending.map((part) => {
          if (part.type === 'text') return { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text }
          if (part.type === 'image') {
            if (message.role === 'assistant') throw new ProtocolConversionError('messages.content.image', 'Responses 不支持 assistant 图片')
            return { type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}` }
          }
          throw new ProtocolConversionError('messages.content', '无法编码的响应输入内容')
        })
      })
      pending = []
    }
    for (const part of message.parts) {
      if (part.type === 'text' || part.type === 'image') pending.push(part)
      else if (part.type === 'tool_call') {
        flush()
        input.push({ type: 'function_call', call_id: part.id, name: part.name, arguments: part.arguments || '{}' })
      } else {
        flush()
        input.push({ type: 'function_call_output', call_id: part.toolCallId, output: part.content.map((item) => item.type === 'text' ? item.text : '').join('') })
      }
    }
    flush()
  }
  const body: Record<string, unknown> = { model: request.model, input, stream: request.stream }
  if (request.system.length) body.instructions = request.system.join('\n\n')
  if (request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.topP !== undefined) body.top_p = request.topP
  if (request.tools.length) body.tools = request.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters }))
  if (request.toolChoice !== undefined) body.tool_choice = encodeResponsesToolChoice(request.toolChoice)
  return body
}

function encodeResponsesToolChoice(choice: IRToolChoice): unknown {
  return typeof choice === 'string' ? choice : { type: 'function', name: choice.name }
}

function encodeGeminiRequest(request: IRRequest): Record<string, unknown> {
  const contents: Record<string, unknown>[] = []
  for (const message of request.messages) {
    const parts: Record<string, unknown>[] = []
    for (const part of message.parts) {
      if (part.type === 'text') parts.push({ text: part.text })
      else if (part.type === 'image') parts.push({ inlineData: { mimeType: part.mediaType, data: part.data } })
      else if (part.type === 'tool_call') parts.push({ functionCall: { name: part.name, args: parseJsonValue(part.arguments, 'tool_call.arguments') } })
      else {
        parts.push({ functionResponse: { name: part.name || part.toolCallId, response: { result: part.content.map((item) => item.type === 'text' ? item.text : '').join('') } } })
      }
    }
    const role = message.role === 'assistant' ? 'model' : 'user'
    const previous = contents[contents.length - 1]
    // Gemini 允许合并同角色连续内容，减少工具调用与结果之间的空轮次。
    if (previous && previous.role === role) (previous.parts as Record<string, unknown>[]).push(...parts)
    else contents.push({ role, parts })
  }
  const body: Record<string, unknown> = { contents }
  if (request.system.length) body.systemInstruction = { parts: request.system.map((text) => ({ text })) }
  if (request.tools.length) body.tools = [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }]
  if (request.toolChoice !== undefined) body.toolConfig = { functionCallingConfig: encodeGeminiToolChoice(request.toolChoice) }
  const generationConfig: Record<string, unknown> = {}
  if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature
  if (request.topP !== undefined) generationConfig.topP = request.topP
  if (request.topK !== undefined) generationConfig.topK = request.topK
  if (request.stop?.length) generationConfig.stopSequences = request.stop
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig
  return body
}

function encodeGeminiToolChoice(choice: IRToolChoice): Record<string, unknown> {
  if (choice === 'auto') return { mode: 'AUTO' }
  if (choice === 'none') return { mode: 'NONE' }
  if (choice === 'required') return { mode: 'ANY' }
  return { mode: 'ANY', allowedFunctionNames: [choice.name] }
}
