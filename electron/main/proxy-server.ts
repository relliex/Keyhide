import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify'
import cors from '@fastify/cors'
import { randomBytes, timingSafeEqual } from 'crypto'
import { pipeline } from 'stream/promises'
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from 'http'
import { gunzipSync, inflateSync, brotliDecompressSync, createGunzip, createInflate, createBrotliDecompress } from 'zlib'
import type { RequestLog, UpstreamPlatform, UpstreamKey, ApiProtocol, LogProtocol } from '../shared/types'
import { loadData, addLog, updatePlatformModels, setProxyRunning, setProxyStarting, flushData } from './database'
import { validateId, validateModels } from './config-validation'
import { selectUpstream, selectKey, markKeySuccess, markKeyError, recordPartialUsage, getAllAvailableModels, selectionIdentity, previewRoute, type RoutePreview, type SelectionResult } from './upstream/manager'
import { BACKEND_VERSION, buildUpstreamHeaders, buildUpstreamUrl, splitProxyPath, stripClientCredentialQuery, responseHeaders, openUpstream, collectResponse, canRetry, retryAfterMilliseconds, hasQuotaError, UpstreamTimeoutError, ClientAbortError } from './upstream/http'
import { requestMetadata, UsageTracker, type TokenUsage } from './upstream/usage'
import { detectGenerationProtocol, geminiModelAction, retargetSameProtocolPath, targetGenerationPath, PROTOCOL_LABELS } from '../shared/protocols'
import { decodeRequest, encodeRequest, decodeResponse, encodeResponse, decodeError, encodeErrorBody, pipeConvertedStream, aggregateStream, ProtocolConversionError, usageTotal, type IRRequest, type IRResponse, type IRUsage, type IRStreamEvent } from './protocols/index'
import { createStreamEncoder } from './protocols/stream'

let server: FastifyInstance | null = null
let starting: Promise<{ success: boolean; message: string }> | null = null
let stopping: Promise<{ success: boolean; message: string }> | null = null
const activeRequests = new Set<AbortController>()
let emitLog: ((log: RequestLog) => void) | null = null
let emitStatus: ((running: boolean) => void) | null = null
let emitData: (() => void) | undefined
const MAX_ATTEMPTS = 8
const ERROR_CAPTURE_LIMIT = 128 * 1024
const CONVERSION_CAPTURE_LIMIT = 10 * 1024 * 1024

class ConversionRequestError extends Error {
  constructor(message: string) { super(message); this.name = 'ConversionRequestError' }
}
class ConversionUpstreamError extends Error {
  constructor(message: string) { super(message); this.name = 'ConversionUpstreamError' }
}

export function setEmitCallbacks(logFn: (log: RequestLog) => void, statusFn: (running: boolean) => void, dataFn?: () => void): void {
  emitLog = logFn; emitStatus = statusFn; emitData = dataFn
}
function statusChanged(running: boolean): void {
  try { setProxyRunning(running) } catch (error) { console.error('Could not update runtime status:', error) }
  try { emitStatus?.(running) } catch (error) { console.error('Proxy status callback failed:', error) }
}

function validateApiKey(req: FastifyRequest): boolean {
  const bearer = typeof req.headers.authorization === 'string' ? /^Bearer\s+(\S+)$/i.exec(req.headers.authorization.trim())?.[1] : undefined
  const apiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : undefined
  const googleKey = typeof req.headers['x-goog-api-key'] === 'string' ? req.headers['x-goog-api-key'].trim() : undefined
  let queryKey: string | undefined
  try { queryKey = new URL(req.url, 'http://localhost').searchParams.get('key') || undefined } catch { queryKey = undefined }
  const supplied = Buffer.from(bearer || apiKey || googleKey || queryKey || '')
  const expected = Buffer.from(loadData().proxy.maskedApiKey)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function logSecrets(selection: SelectionResult | null = null): string[] {
  const data = loadData()
  return [...new Set([data.proxy.maskedApiKey, ...data.platforms.flatMap((platform) => [...platform.keys.map((key) => key.key), ...Object.values(platform.customHeaders)]), ...(selection ? [selection.key.key, ...Object.values(selection.platform.customHeaders)] : [])])].filter(Boolean).sort((a, b) => b.length - a.length)
}

function redactText(text: string, secrets: string[]): string {
  for (const secret of secrets) {
    text = text.split(secret).join('[REDACTED]')
    const encoded = encodeURIComponent(secret)
    if (encoded !== secret) {
      const escaped = encoded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      text = text.replace(new RegExp(escaped, 'gi'), '[REDACTED]')
      text = text.split(encoded.replace(/%20/g, '+')).join('[REDACTED]')
    }
  }
  return text
}

function redactError(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error), logSecrets()).slice(0, 4096)
}

function logPath(path: string, secrets: string[]): string {
  const index = path.indexOf('?')
  if (index < 0) return redactText(path, secrets).slice(0, 16384)
  const sensitive = /^(?:api[-_]?key|key|token|access[-_]?token|auth|authorization|credentials?|password|secret|signature|client[-_]?secret)$/i
  const query = [...new URLSearchParams(path.slice(index + 1))].map(([name, value]) => {
    const redacted = sensitive.test(name) ? '[REDACTED]' : redactText(value, secrets)
    return `${encodeURIComponent(redactText(name, secrets))}=${encodeURIComponent(redacted).replace(/%5BREDACTED%5D/g, '[REDACTED]')}`
  }).join('&')
  return `${redactText(path.slice(0, index), secrets)}?${query}`.slice(0, 16384)
}

function logRequest(req: FastifyRequest, selection: SelectionResult | null, model: string, format: LogProtocol, statusCode: number, start: number, stream: boolean, error: string | null, tokens: TokenUsage = { prompt: 0, completion: 0 }): void {
  try { emitData?.() } catch (failure) { console.error('Could not refresh proxy statistics:', failure) }
  if (!loadData().proxy.logRequests) return
  const secrets = logSecrets(selection)
  const log: RequestLog = {
    id: randomBytes(12).toString('hex'), timestamp: Date.now(), method: redactText(req.method, secrets).slice(0, 32), path: logPath(req.url, secrets),
    format, model: redactText(model, secrets).slice(0, 512),
    resolvedModel: redactText(selection?.resolvedModel || '', secrets).slice(0, 512),
    upstreamProtocol: selection?.platform.upstreamProtocol,
    platformId: selection && secrets.includes(selection.platform.id) ? '[REDACTED]' : selection?.platform.id || '', platformName: redactText(selection?.platform.name || '', secrets).slice(0, 256),
    keyLabel: redactText(selection?.key.label || '', secrets).slice(0, 256), statusCode, duration: Math.max(0, Date.now() - start),
    promptTokens: tokens.prompt, completionTokens: tokens.completion, stream,
    error: error ? redactText(error, secrets).slice(0, 4096) : null, clientIp: req.ip || ''
  }
  // Logging/callback failures must not corrupt an otherwise valid streamed response.
  try { addLog(log); emitLog?.(log) } catch (failure) { console.error('Failed to record proxy request:', failure) }
}

function requestFormat(path: string): LogProtocol {
  const pathname = path.split('?')[0]
  return /^\/v1\/(?:messages(?:\/|$)|complete(?:\/|$))/.test(pathname) ? 'anthropic' : 'openai-chat'
}

export function previewProxyRoute(input: { model: string; path: string; format?: LogProtocol }): RoutePreview {
  if (!input || typeof input.model !== 'string' || input.model.length > 512 || typeof input.path !== 'string' || input.path.length > 16384 || (input.format !== undefined && !PROTOCOL_LABELS[input.format])) {
    return { platformId: null, platformName: null, reason: '路由预览参数无效', error: '请填写合法的 model、path 和 format' }
  }
  try {
    const path = splitProxyPath(input.path)
    const downstream = detectGenerationProtocol(path.upstreamPath.split('?')[0])
    const model = input.model || requestMetadata(null, '', path.upstreamPath).model
    return previewRoute(model, path.platformId, downstream || undefined)
  } catch (error) {
    return { platformId: null, platformName: null, reason: '请求路径无效', error: redactError(error) }
  }
}

function responseProtocolFor(path: string): ApiProtocol | null {
  return detectGenerationProtocol(path.split('?')[0])
}

function patchModelBody(body: Buffer | null, model: string, requested: string): Buffer | null {
  if (!body || model === requested) return body
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    if (typeof parsed.model !== 'string') return body
    parsed.model = model
    return Buffer.from(JSON.stringify(parsed))
  } catch {
    throw new ConversionRequestError('模型改名需要 JSON 请求体，且 body 必须是 JSON 对象')
  }
}

function convertedHeaders(headers: IncomingHttpHeaders, mode: 'json' | 'sse'): OutgoingHttpHeaders {
  const result = responseHeaders(headers)
  for (const name of ['content-type', 'content-length', 'content-encoding', 'etag', 'content-md5', 'accept-ranges', 'content-range', 'last-modified']) delete result[name]
  result['content-type'] = mode === 'sse' ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8'
  if (mode === 'sse') result['cache-control'] = 'no-cache'
  return result
}

function writeHead(reply: FastifyReply, status: number, headers: OutgoingHttpHeaders): void {
  reply.hijack()
  reply.raw.writeHead(status, { ...reply.getHeaders(), ...headers } as OutgoingHttpHeaders)
}

async function collectWithTimeout(response: IncomingMessage, limit: number, timeoutMs: number): Promise<Buffer> {
  const timer = setTimeout(() => response.destroy(new UpstreamTimeoutError()), Math.max(1, timeoutMs))
  try { return await collectResponse(response, limit) } finally { clearTimeout(timer) }
}

function streamSource(response: IncomingMessage): AsyncIterable<Buffer | string> {
  const encoding = String(response.headers['content-encoding'] || '').toLowerCase().trim()
  if (!encoding || encoding === 'identity') return response
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null
  if (!decoder) throw new ConversionUpstreamError(`不支持压缩编码 ${encoding}`)
  response.pipe(decoder)
  return decoder
}

function tokenUsageFromIR(usage: IRUsage): TokenUsage {
  return { prompt: usageTotal(usage), completion: usage.output }
}

async function writeFrame(reply: FastifyReply, frame: string, signal: AbortSignal): Promise<void> {
  if (reply.raw.destroyed || signal.aborted) throw new ClientAbortError()
  if (reply.raw.write(frame)) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      reply.raw.removeListener('drain', onDrain)
      reply.raw.removeListener('close', onClose)
      signal.removeEventListener('abort', onAbort)
    }
    const onDrain = (): void => { cleanup(); resolve() }
    const onClose = (): void => { cleanup(); reject(new ClientAbortError()) }
    const onAbort = (): void => { cleanup(); reject(new ClientAbortError()) }
    reply.raw.once('drain', onDrain)
    reply.raw.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function writeSyntheticStream(reply: FastifyReply, protocol: ApiProtocol, response: IRResponse, model: string, signal: AbortSignal): Promise<void> {
  const encoder = createStreamEncoder(protocol, model)
  const events: IRStreamEvent[] = [{ type: 'start', id: response.id, model: response.model, usage: response.usage }]
  const parts: { type: 'text' | 'tool'; index: number; part: any }[] = []
  for (const [index, part] of response.content.entries()) {
    if (part.type === 'text' || part.type === 'tool_call') parts.push({ type: part.type === 'tool_call' ? 'tool' : 'text', index, part })
    else throw new ConversionUpstreamError('上游响应包含无法转换的内容块')
  }
  for (const item of parts) {
    if (item.type === 'text') {
      events.push({ type: 'text_start', index: item.index }, { type: 'text_delta', index: item.index, text: item.part.text }, { type: 'text_end', index: item.index })
    } else {
      events.push({ type: 'tool_start', index: item.index, id: item.part.id, name: item.part.name }, { type: 'tool_args_delta', index: item.index, delta: item.part.arguments || '{}' }, { type: 'tool_end', index: item.index })
    }
  }
  events.push({ type: 'finish', stopReason: response.stopReason, usage: response.usage })
  for (const event of events) for (const frame of encoder.push(event)) await writeFrame(reply, frame, signal)
  for (const frame of encoder.end()) await writeFrame(reply, frame, signal)
  reply.raw.end()
}

async function handleProxy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const start = Date.now()
  const data = loadData()
  const incomingPath = stripClientCredentialQuery(req.url)
  const path = splitProxyPath(incomingPath)
  const downstream = responseProtocolFor(path.upstreamPath)
  const format: LogProtocol = downstream || requestFormat(path.upstreamPath)
  const body = Buffer.isBuffer(req.body) ? req.body : null
  const metadata = requestMetadata(body, String(req.headers['content-type'] || ''), path.upstreamPath)
  const controller = new AbortController()
  let upstreamFailed = false
  let stream = metadata.stream
  let ir: IRRequest | null = null
  const abort = (): void => { if (!reply.raw.writableFinished && !upstreamFailed) controller.abort() }
  req.raw.once('aborted', abort)
  reply.raw.once('close', abort)
  activeRequests.add(controller)
  const excluded = new Set<string>()
  let selection: SelectionResult | null = null
  let statusCode = 503
  let reportedError: string | null = null
  let usage: TokenUsage = { prompt: 0, completion: 0 }
  let keyRecorded = false
  const remainingTime = (): number => data.proxy.timeout - (Date.now() - start)
  const getIR = (): IRRequest => {
    if (ir) return ir
    if (!downstream) throw new ConversionRequestError('该端点不支持跨协议转换')
    if (!body) throw new ConversionRequestError('跨协议转换需要 JSON 请求体')
    let parsed: unknown
    try { parsed = JSON.parse(body.toString('utf8')) } catch { throw new ConversionRequestError('请求体不是有效 JSON，无法进行跨协议转换') }
    try {
      ir = decodeRequest(downstream, parsed, metadata.model)
    } catch (error) {
      if (error instanceof ProtocolConversionError) throw new ConversionRequestError(error.message)
      throw error
    }
    stream = stream || ir.stream
    ir.stream = stream
    return ir
  }
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (controller.signal.aborted) throw new ClientAbortError()
      selection = selectUpstream(metadata.model, data.settings.routeMode, data.settings.defaultPlatformId, path.platformId, excluded)
      if (!selection) break
      keyRecorded = false
      excluded.add(selectionIdentity(selection))
      const { platform, key } = selection
      const upstreamProtocol = platform.upstreamProtocol
      const converting = !!downstream && upstreamProtocol !== downstream
      const resolvedModel = selection.resolvedModel
      const remaining = remainingTime()
      if (remaining <= 0) throw new UpstreamTimeoutError()
      upstreamFailed = false
      let targetPath = path.upstreamPath
      let outBody: Buffer | null = body
      if (downstream) {
        if (!converting) {
          if (upstreamProtocol === 'gemini' && resolvedModel !== metadata.model) targetPath = retargetSameProtocolPath(path.upstreamPath, upstreamProtocol, resolvedModel)
          else if (upstreamProtocol !== 'gemini') outBody = patchModelBody(body, resolvedModel, metadata.model)
        } else {
          // 跨协议统一请求上游流式：适配只支持流式或长任务较慢的供应商；
          // 下游要求非流式时再聚合为完整 JSON。
          const request = { ...getIR(), model: resolvedModel, stream: true }
          targetPath = targetGenerationPath(upstreamProtocol, resolvedModel, true)
          try {
            outBody = Buffer.from(JSON.stringify(encodeRequest(upstreamProtocol, request)))
          } catch (error) {
            if (error instanceof ProtocolConversionError) throw new ConversionRequestError(error.message)
            throw error
          }
        }
      }
      try {
        const target = buildUpstreamUrl(platform.baseUrl, targetPath)
        const headers = buildUpstreamHeaders(platform, key, req.headers, outBody, converting)
        const upstream = await openUpstream(converting ? 'POST' : req.method, target, headers, outBody, remaining, controller.signal)
        const response = upstream.response
        upstreamFailed = false
        response.once('error', () => { upstreamFailed = true })
        response.once('aborted', () => { upstreamFailed = true })
        statusCode = response.statusCode || 502
        const upstreamContentType = String(response.headers['content-type'] || '')
        const retryable = canRetry(converting ? 'POST' : req.method, statusCode, req.headers)
        const alternate = retryable && attempt + 1 < MAX_ATTEMPTS && selectUpstream(metadata.model, data.settings.routeMode, data.settings.defaultPlatformId, path.platformId, excluded, true)
        if (alternate) {
          // Only discarded retry responses are buffered, and even those are strictly bounded.
          let errorBody: Buffer = Buffer.alloc(0)
          const timer = setTimeout(() => response.destroy(new UpstreamTimeoutError()), Math.max(1, remainingTime()))
          try { errorBody = await collectResponse(response, ERROR_CAPTURE_LIMIT) } catch { response.destroy() }
          finally { clearTimeout(timer); upstream.release() }
          markKeyError(platform.id, key.id, `HTTP ${statusCode}`, statusCode, retryAfterMilliseconds(response.headers['retry-after']), hasQuotaError(errorBody), key.key)
          keyRecorded = true
          continue
        }

        if (converting && downstream) {
          keyRecorded = true
          if (statusCode >= 400 && statusCode !== 499) {
            let errorBody: Buffer = Buffer.alloc(0)
            try { errorBody = await collectWithTimeout(response, ERROR_CAPTURE_LIMIT, remainingTime()) } catch { response.destroy() }
            finally { upstream.release() }
            reportedError = `HTTP ${statusCode}`
            let decodedBody = errorBody
            try { decodedBody = decodeModelResponse(errorBody, response.headers['content-encoding']) } catch { /* 保留原始错误正文 */ }
            const decoded = decodeError(upstreamProtocol, statusCode, decodedBody, upstreamContentType)
            const payload = encodeErrorBody(downstream, statusCode, decoded)
            writeHead(reply, statusCode, convertedHeaders(response.headers, 'json'))
            reply.raw.end(JSON.stringify(payload))
            markKeyError(platform.id, key.id, reportedError, statusCode, retryAfterMilliseconds(response.headers['retry-after']), hasQuotaError(decodedBody), key.key)
            return
          }
          const wantsStream = stream
          const upstreamIsSSE = /text\/event-stream/i.test(upstreamContentType)
          if (wantsStream && upstreamIsSSE) {
            const headers = convertedHeaders(response.headers, 'sse')
            writeHead(reply, statusCode, headers)
            let result: Awaited<ReturnType<typeof pipeConvertedStream>> | null = null
            try {
              result = await pipeConvertedStream({
                source: streamSource(response as any), upstreamProtocol, downstreamProtocol: downstream, model: resolvedModel,
                write: (frame) => writeFrame(reply, frame, controller.signal)
              })
            } catch (error) {
              if (error instanceof ClientAbortError || controller.signal.aborted) throw new ClientAbortError()
              if (error instanceof ProtocolConversionError) throw new ConversionUpstreamError(error.message)
              throw error
            } finally { upstream.release() }
            if (!result) throw new ConversionUpstreamError('上游流转换失败')
            if (result.error) {
              statusCode = 502
              reportedError = result.error
              markKeyError(platform.id, key.id, reportedError, 502, undefined, false, key.key)
            } else {
              markKeySuccess(platform.id, key.id, usageTotal(result.usage), key.key)
            }
            usage = tokenUsageFromIR(result.usage)
            if (!reply.raw.writableFinished) reply.raw.end()
            return
          }
          if (!wantsStream && upstreamIsSSE) {
            let aggregated: IRResponse
            try {
              aggregated = await aggregateStream(upstreamProtocol, streamSource(response), resolvedModel)
            } catch (error) {
              if (error instanceof ClientAbortError || controller.signal.aborted) throw new ClientAbortError()
              if (error instanceof ProtocolConversionError) throw new ConversionUpstreamError(error.message)
              throw error
            } finally { upstream.release() }
            usage = tokenUsageFromIR(aggregated.usage)
            let payload: string
            try { payload = JSON.stringify(encodeResponse(downstream, aggregated)) }
            catch (error) {
              if (error instanceof ProtocolConversionError) throw new ConversionUpstreamError(error.message)
              throw error
            }
            writeHead(reply, statusCode, convertedHeaders(response.headers, 'json'))
            reply.raw.end(payload)
            markKeySuccess(platform.id, key.id, usageTotal(aggregated.usage), key.key)
            return
          }
          // Buffered JSON conversion for normal responses; HTTP errors were handled above.
          let responseBody: Buffer
          try { responseBody = await collectWithTimeout(response, CONVERSION_CAPTURE_LIMIT, remainingTime()) }
          finally { upstream.release() }
          let decodedResponse: IRResponse
          try {
            decodedResponse = decodeResponse(upstreamProtocol, JSON.parse(decodeModelResponse(responseBody, response.headers['content-encoding']).toString('utf8')), resolvedModel)
          } catch (error) {
            if (error instanceof ProtocolConversionError) throw new ConversionUpstreamError(error.message)
            throw new ConversionUpstreamError('上游返回了无法解析的 JSON 响应')
          }
          usage = tokenUsageFromIR(decodedResponse.usage)
          let payload: string | null = null
          if (!wantsStream) {
            try { payload = JSON.stringify(encodeResponse(downstream, decodedResponse)) }
            catch (error) {
              if (error instanceof ProtocolConversionError) throw new ConversionUpstreamError(error.message)
              throw error
            }
          }
          if (wantsStream) {
            writeHead(reply, statusCode, convertedHeaders(response.headers, 'sse'))
            await writeSyntheticStream(reply, downstream, decodedResponse, resolvedModel, controller.signal)
          } else {
            writeHead(reply, statusCode, convertedHeaders(response.headers, 'json'))
            reply.raw.end(payload)
          }
          markKeySuccess(platform.id, key.id, usageTotal(decodedResponse.usage), key.key)
          return
        }

        // Same protocol (or non-generation endpoint): raw passthrough.
        const tracker = new UsageTracker(String(response.headers['content-type'] || ''), response.headers['content-encoding'])
        stream ||= tracker.stream
        const errorChunks: Buffer[] = []
        let errorBytes = 0
        response.on('data', (chunk: Buffer) => {
          tracker.observe(chunk)
          if (statusCode >= 400) {
            errorBytes += chunk.length
            if (errorBytes <= ERROR_CAPTURE_LIMIT) errorChunks.push(chunk)
            else errorChunks.length = 0
          }
        })
        // Raw passthrough preserves binary bodies, SSE, content type, encoding, status and cookies.
        writeHead(reply, statusCode, responseHeaders(response.headers))
        try { await pipeline(response, reply.raw) } finally { upstream.release(); usage = tracker.finish() }
        if (tracker.error) {
          statusCode = 502
          reportedError = redactError(tracker.error)
          recordPartialUsage(platform.id, key.id, usage.prompt + usage.completion, key.key)
          markKeyError(platform.id, key.id, reportedError, statusCode, undefined, false, key.key)
        } else if (statusCode >= 200 && statusCode < 400) {
          reportedError = null
          markKeySuccess(platform.id, key.id, usage.prompt + usage.completion, key.key)
        } else {
          reportedError = `HTTP ${statusCode}`
          markKeyError(platform.id, key.id, reportedError, statusCode, retryAfterMilliseconds(response.headers['retry-after']), hasQuotaError(Buffer.concat(errorChunks)), key.key)
        }
        keyRecorded = true
        return
      } catch (error) {
        recordPartialUsage(platform.id, key.id, usage.prompt + usage.completion, key.key)
        if (error instanceof ClientAbortError || controller.signal.aborted) throw error
        if (error instanceof ConversionRequestError) throw error
        statusCode = error instanceof UpstreamTimeoutError ? 504 : error instanceof ConversionUpstreamError ? 502 : 502
        reportedError = redactError(error)
        if (!keyRecorded) { markKeyError(platform.id, key.id, reportedError, statusCode, undefined, false, key.key); keyRecorded = true }
        if (reply.raw.headersSent || !canRetry(converting ? 'POST' : req.method, statusCode, req.headers, error)) throw error
        if (attempt + 1 >= MAX_ATTEMPTS || !selectUpstream(metadata.model, data.settings.routeMode, data.settings.defaultPlatformId, path.platformId, excluded, true)) throw error
      }
    }
    reportedError = '没有符合路由规则的可用上游平台或 Key'
    statusCode = 503
    reply.code(statusCode).send({ error: { message: reportedError, type: 'server_error' } })
  } catch (error) {
    if (error instanceof ConversionRequestError) {
      statusCode = 400
      reportedError = redactError(error)
      if (!reply.raw.headersSent) reply.code(400).send(encodeErrorBody(downstream || 'openai-chat', 400, { message: reportedError, type: 'invalid_request_error' }))
      else if (!reply.raw.destroyed) reply.raw.destroy()
    } else if (error instanceof ConversionUpstreamError) {
      statusCode = 502
      reportedError = redactError(error)
      if (!reply.raw.headersSent) reply.code(502).send(encodeErrorBody(downstream || 'openai-chat', 502, { message: reportedError, type: 'upstream_error' }))
      else if (!reply.raw.destroyed) reply.raw.destroy()
    } else {
      const aborted = error instanceof ClientAbortError || controller.signal.aborted
      statusCode = aborted ? 499 : error instanceof UpstreamTimeoutError ? 504 : 502
      reportedError = aborted ? '客户端断开连接或服务已停止' : redactError(error)
      if (!aborted && !reply.raw.headersSent && !reply.raw.destroyed) reply.code(statusCode).send(encodeErrorBody(downstream || 'openai-chat', statusCode, { message: reportedError, type: 'upstream_error' }))
      else if (!reply.raw.destroyed && !reply.raw.writableFinished) reply.raw.destroy()
    }
  } finally {
    req.raw.removeListener('aborted', abort)
    reply.raw.removeListener('close', abort)
    activeRequests.delete(controller)
    logRequest(req, selection, metadata.model, format, statusCode, start, stream, reportedError, usage)
  }
}

function modelList(): string[] { return getAllAvailableModels() }

function openAIModelList(models: string[]): Record<string, unknown> {
  return { object: 'list', data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'keyhide' })), has_more: false, first_id: models[0] || null, last_id: models[models.length - 1] || null }
}

function anthropicModelList(models: string[]): Record<string, unknown> {
  return {
    data: models.map((id) => ({ id, type: 'model', display_name: id, created_at: new Date(0).toISOString() })),
    has_more: false, first_id: models[0] || null, last_id: models[models.length - 1] || null
  }
}

function geminiModelList(models: string[]): Record<string, unknown> {
  return { models: models.map((id) => ({ name: `models/${id}`, displayName: id, description: '', version: '', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] })) }
}

function createServer(): FastifyInstance {
  const data = loadData()
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024, forceCloseConnections: true })
  if (data.proxy.cors) app.register(cors, { origin: '*', methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'], allowedHeaders: '*' })
  // Raw parsing supports JSON, multipart uploads, audio and vendor-specific formats without rewriting.
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.split('?')[0] === '/health' || (req.method === 'OPTIONS' && data.proxy.cors)) return
    if (!validateApiKey(req)) {
      reply.code(401).send({ error: { message: 'Invalid API key', type: 'authentication_error' } })
      logRequest(req, null, '', 'openai-chat', 401, Date.now(), false, 'Invalid API key')
    }
  })
  const aliasesEnabled = (): boolean => loadData().settings.enableModelAliases
  const listRoute = (gemini: boolean, prefix?: string) => async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const models = prefix ? getAllAvailableModels(prefix) : modelList()
    // 开启别名后必须使用本地目录（即使为空），避免 query/分页/透传分支泄露真实名称。
    if (aliasesEnabled() || (models.length && !req.url.includes('?') && loadData().settings.routeMode !== 'by-path')) {
      // Anthropic SDK 会发送 anthropic-version；按它的列表结构返回，OpenAI 客户端仍得到 object:list。
      const anthropic = !gemini && typeof req.headers['anthropic-version'] === 'string'
      reply.send(gemini ? geminiModelList(models) : anthropic ? anthropicModelList(models) : openAIModelList(models))
    } else await handleProxy(req, reply)
  }
  app.get('/v1/models', listRoute(false))
  app.get('/v1beta/models', listRoute(true))
  app.get('/:platformId/v1/models', async (req, reply) => {
    const platformId = splitProxyPath(stripClientCredentialQuery(req.url)).platformId
    await listRoute(false, platformId)(req, reply)
  })
  app.get('/:platformId/v1beta/models', async (req, reply) => {
    const platformId = splitProxyPath(stripClientCredentialQuery(req.url)).platformId
    await listRoute(true, platformId)(req, reply)
  })
  app.all('/v1', handleProxy)
  app.all('/v1/*', handleProxy)
  app.all('/v1beta', handleProxy)
  app.all('/v1beta/*', handleProxy)
  app.all('/:platformId/v1', handleProxy)
  app.all('/:platformId/v1/*', handleProxy)
  app.all('/:platformId/v1beta', handleProxy)
  app.all('/:platformId/v1beta/*', handleProxy)
  app.get('/health', async (_req, reply) => reply.send({ status: 'ok', service: 'keyhide', version: BACKEND_VERSION }))
  app.setErrorHandler((error, _req, reply) => {
    const code = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined
    const status = typeof code === 'number' && code >= 400 && code < 600 ? code : 500
    const message = status === 500 ? 'Proxy internal error' : error instanceof Error ? error.message : 'Invalid request'
    reply.code(status).send({ error: { message, type: 'server_error' } })
  })
  return app
}

export async function startProxy(): Promise<{ success: boolean; message: string }> {
  if (stopping) await stopping
  if (starting) return starting
  if (server) return { success: false, message: '服务已在运行' }
  setProxyStarting(true)
  starting = (async () => {
    let app: FastifyInstance | null = null
    try {
      const { proxy } = loadData()
      app = createServer()
      await app.listen({ port: proxy.port, host: proxy.host })
      server = app
      statusChanged(true)
      return { success: true, message: `代理服务已启动: http://${proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host}:${proxy.port}` }
    } catch (error) {
      if (app) await app.close().catch(() => {})
      server = null; statusChanged(false)
      return { success: false, message: `启动失败: ${redactError(error)}` }
    }
  })()
  try { return await starting } finally { starting = null; setProxyStarting(false) }
}

export async function stopProxy(): Promise<{ success: boolean; message: string }> {
  if (starting) await starting
  if (stopping) return stopping
  if (!server) return { success: false, message: '服务未运行' }
  const app = server
  stopping = (async () => {
    try {
      for (const controller of activeRequests) controller.abort()
      await app.close()
      server = null; statusChanged(false)
      try { flushData() } catch (error) { return { success: true, message: `代理服务已停止；统计保存失败: ${redactError(error)}` } }
      return { success: true, message: '代理服务已停止' }
    } catch (error) { return { success: false, message: `停止失败: ${redactError(error)}` } }
  })()
  try { return await stopping } finally { stopping = null }
}

export function isProxyRunning(): boolean { return server !== null }

function decodeModelResponse(buffer: Buffer, encoding?: string): Buffer {
  const options = { maxOutputLength: 5 * 1024 * 1024 }
  if (encoding === 'gzip') return gunzipSync(buffer, options)
  if (encoding === 'deflate') return inflateSync(buffer, options)
  if (encoding === 'br') return brotliDecompressSync(buffer, options)
  return buffer
}

export async function fetchUpstreamModels(platformId: string): Promise<string[]> {
  validateId(platformId)
  const data = loadData()
  const platform = data.platforms.find((item) => item.id === platformId)
  if (!platform) throw new Error('平台不存在')
  const controller = new AbortController()
  activeRequests.add(controller)
  const started = Date.now()
  const models: string[] = []
  let cursor = ''
  const seenCursors = new Set<string>()
  const gemini = platform.upstreamProtocol === 'gemini'
  try {
    for (let page = 0; page < 20; page++) {
      const excluded = new Set<string>()
      let pageBody: any = null
      let lastError: unknown = new Error('平台没有可用的 API Key')
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const key = selectKey(platform, excluded)
        if (!key) break
        excluded.add(`${platform.id}:${key.id}`)
        const remaining = data.proxy.timeout - (Date.now() - started)
        if (remaining <= 0) throw new UpstreamTimeoutError()
        try {
          const target = gemini
            ? buildUpstreamUrl(platform.baseUrl, `/v1beta/models${cursor ? `?pageToken=${encodeURIComponent(cursor)}` : ''}`)
            : buildUpstreamUrl(platform.baseUrl, `/v1/models${cursor ? `?after_id=${encodeURIComponent(cursor)}` : ''}`)
          const upstream = await openUpstream('GET', target, buildUpstreamHeaders(platform, key), null, remaining, controller.signal)
          const timer = setTimeout(() => upstream.response.destroy(new UpstreamTimeoutError()), remaining)
          let responseBody: Buffer
          try { responseBody = await collectResponse(upstream.response, 5 * 1024 * 1024) }
          finally { clearTimeout(timer); upstream.release() }
          const status = upstream.response.statusCode || 502
          if (status < 200 || status >= 300) {
            markKeyError(platform.id, key.id, `HTTP ${status}`, status, retryAfterMilliseconds(upstream.response.headers['retry-after']), hasQuotaError(responseBody), key.key)
            lastError = new Error(`上游返回 HTTP ${status}`)
            if (canRetry('GET', status, {})) continue
            throw lastError
          }
          pageBody = JSON.parse(decodeModelResponse(responseBody, upstream.response.headers['content-encoding']).toString('utf8'))
          const list = gemini
            ? Array.isArray(pageBody.models) ? pageBody.models : null
            : Array.isArray(pageBody.data) ? pageBody.data : Array.isArray(pageBody.models) ? pageBody.models : null
          if (!list) throw new Error('上游模型列表缺少 data/models 数组')
          const pageModels = list.map((item: any) => {
            if (typeof item === 'string') return item
            if (gemini && typeof item?.name === 'string') return item.name.replace(/^models\//, '')
            return item?.id || item?.name
          }).filter((model: unknown) => typeof model === 'string' && model.trim())
          models.push(...validateModels(pageModels))
          if (models.length > 20000) throw new Error('上游模型列表超过 20000 个，原模型列表保持不变')
          if (list.length && !pageModels.length) throw new Error('上游模型列表没有有效的模型 ID')
          markKeySuccess(platform.id, key.id, 0, key.key)
          break
        } catch (error) {
          lastError = error
          if (controller.signal.aborted) throw new ClientAbortError()
          if (!(error instanceof UpstreamTimeoutError) && !(error as NodeJS.ErrnoException).code) throw error
          // Only transport failures reach this retry branch; ordinary 4xx/invalid JSON are not replayed.
          markKeyError(platform.id, key.id, redactError(error), error instanceof UpstreamTimeoutError ? 504 : 502, undefined, false, key.key)
        }
      }
      if (!pageBody) throw lastError
      if (gemini ? !pageBody.nextPageToken : pageBody.has_more !== true) {
        const result = validateModels(models)
        const current = loadData().platforms.find((item) => item.id === platformId)
        const source = (item: UpstreamPlatform) => JSON.stringify([item.baseUrl, item.type, item.upstreamProtocol, item.customHeaders, item.keys.map((key) => key.key)])
        if (!current || source(current) !== source(platform)) throw new Error('平台配置已改变，旧的模型获取结果未保存，请重新获取')
        updatePlatformModels(platformId, result)
        return result
      }
      cursor = gemini ? pageBody.nextPageToken : pageBody.last_id || models[models.length - 1]
      if (typeof cursor !== 'string' || !cursor || seenCursors.has(cursor)) throw new Error('上游模型分页游标无效')
      seenCursors.add(cursor)
    }
    throw new Error('上游模型分页超过 20 页，原模型列表保持不变')
  } finally { activeRequests.delete(controller) }
}

export async function testConnection(platformId: string): Promise<{ success: boolean; message: string }> {
  try {
    const models = await fetchUpstreamModels(platformId)
    return { success: true, message: `连接成功，共获取到 ${models.length} 个模型` }
  } catch (error) { return { success: false, message: `连接失败: ${redactError(error)}` } }
}
