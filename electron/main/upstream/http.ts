import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders } from 'http'
import https from 'https'
import type { UpstreamPlatform, UpstreamKey } from '../../shared/types'

export const BACKEND_VERSION = '1.0.1'
const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function filteredHeaders(original: IncomingHttpHeaders | Record<string, string>): OutgoingHttpHeaders {
  const connection = original.connection
  const omitted = new Set([...hopByHop, ...String(connection || '').split(',').map((value) => value.trim().toLowerCase())])
  const result: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(original)) {
    if (value !== undefined && !omitted.has(name.toLowerCase())) result[name.toLowerCase()] = value
  }
  return result
}

export function buildUpstreamHeaders(platform: UpstreamPlatform, key: UpstreamKey, original: IncomingHttpHeaders = {}, body: Buffer | null = null): OutgoingHttpHeaders {
  const headers = filteredHeaders(original)
  for (const name of ['host', 'authorization', 'x-api-key', 'content-length', 'expect']) delete headers[name]
  headers['user-agent'] ||= `keyhide/${BACKEND_VERSION}`
  for (const [name, value] of Object.entries(platform.customHeaders)) headers[name.toLowerCase()] = value
  if (platform.type === 'anthropic') {
    headers['x-api-key'] = key.key
    headers['anthropic-version'] ||= '2023-06-01'
  } else if (platform.type !== 'custom' || (!headers.authorization && !headers['x-api-key'])) {
    headers.authorization = `Bearer ${key.key}`
  }
  if (body !== null) headers['content-length'] = String(body.length)
  return headers
}

export function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders { return filteredHeaders(headers) }

export function splitProxyPath(path: string): { upstreamPath: string; platformId?: string } {
  const pathname = path.split('?')[0]
  if (pathname === '/v1' || pathname.startsWith('/v1/')) return { upstreamPath: path }
  const match = /^\/([^/]+)(?=\/v1(?:\/|$))/.exec(pathname)
  if (!match) throw new Error('请求路径必须以 /v1 或 /{platformId}/v1 开头')
  const platformId = decodeURIComponent(match[1])
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(platformId)) throw new Error('平台 ID 无效')
  return { upstreamPath: path.slice(match[0].length), platformId }
}

/** Keep base prefixes, avoid /v1/v1, and carry both base and incoming query parameters. */
export function buildUpstreamUrl(baseUrl: string, incomingPath: string): URL {
  const url = new URL(baseUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) upstream URLs are supported')
  const queryIndex = incomingPath.indexOf('?')
  let path = queryIndex < 0 ? incomingPath : incomingPath.slice(0, queryIndex)
  const query = queryIndex < 0 ? '' : incomingPath.slice(queryIndex + 1)
  const basePath = url.pathname.replace(/\/+$/, '')
  if (basePath.endsWith('/v1') && (path === '/v1' || path.startsWith('/v1/'))) path = path.slice(3)
  url.pathname = `${basePath}${path || '/'}`
  const baseQuery = url.search.slice(1)
  url.search = baseQuery && query ? `${baseQuery}&${query}` : baseQuery || query
  return url
}

export class UpstreamTimeoutError extends Error {
  constructor() { super('上游响应超时'); this.name = 'UpstreamTimeoutError' }
}
export class ClientAbortError extends Error {
  constructor() { super('客户端已断开连接'); this.name = 'ClientAbortError' }
}

export interface OpenResponse { response: IncomingMessage; release: () => void }

/** Timeout before headers is absolute; thereafter it is an idle timeout, suitable for long SSE streams. */
export function openUpstream(method: string, target: URL, headers: OutgoingHttpHeaders, body: Buffer | null, timeoutMs: number, signal: AbortSignal): Promise<OpenResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new ClientAbortError()); return }
    let response: IncomingMessage | undefined
    let settled = false
    let headerTimer: NodeJS.Timeout | undefined
    const request = (target.protocol === 'https:' ? https : http).request(target, { method, headers })
    const abort = (): void => { request.destroy(new ClientAbortError()); response?.destroy(new ClientAbortError()) }
    const release = (): void => {
      if (headerTimer) clearTimeout(headerTimer)
      request.setTimeout(0)
      signal.removeEventListener('abort', abort)
    }
    const fail = (error: Error): void => {
      if (!settled) { settled = true; release(); reject(error) }
      else response?.destroy(error)
    }
    signal.addEventListener('abort', abort, { once: true })
    headerTimer = setTimeout(() => request.destroy(new UpstreamTimeoutError()), Math.max(1, timeoutMs))
    request.setTimeout(Math.max(1, timeoutMs), () => request.destroy(new UpstreamTimeoutError()))
    request.on('error', fail)
    request.on('response', (incoming) => {
      response = incoming
      if (settled || signal.aborted) { incoming.destroy(); return }
      settled = true
      if (headerTimer) clearTimeout(headerTimer)
      headerTimer = undefined
      // Keep response errors handled even while the caller decides whether to retry.
      incoming.on('error', () => {})
      incoming.once('close', release)
      resolve({ response: incoming, release })
    })
    request.end(body ?? undefined)
  })
}

export async function collectResponse(response: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) {
      response.destroy()
      throw new Error('上游响应超过允许的缓冲大小')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, size)
}

export function retryAfterMilliseconds(value: string | string[] | undefined): number | undefined {
  if (!value) return undefined
  const text = Array.isArray(value) ? value[0] : value
  const seconds = Number(text)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(text)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

export function hasQuotaError(body: Buffer): boolean {
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    const error = parsed.error
    const code = String(error?.code || error?.type || '')
    return /^(insufficient_quota|quota_exhausted|billing_hard_limit_reached|credit_balance_too_low)$/.test(code)
  } catch { return false }
}

export function canRetry(method: string, statusCode: number, headers: IncomingHttpHeaders, error?: unknown): boolean {
  // Credential/rate-limit rejections are safe to fail over. Do not replay a possibly completed paid or mutating POST after a timeout/5xx without an idempotency key.
  if ([401, 403, 429].includes(statusCode)) return true
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(method) || !!headers['idempotency-key']
  if (error) return safe || ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes((error as NodeJS.ErrnoException).code || '')
  return safe && statusCode >= 500 && statusCode <= 504
}
