import { StringDecoder } from 'string_decoder'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'zlib'
import { geminiModelAction } from '../../shared/protocols'

export interface TokenUsage { prompt: number; completion: number }
const CAPTURE_LIMIT = 512 * 1024
const BODY_CAPTURE_LIMIT = 5 * 1024 * 1024
function count(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)) : 0 }

/** Observe usage without buffering an unbounded binary response or SSE transcript. */
export class UsageTracker {
  private readonly decoder = new StringDecoder('utf8')
  private chunks: Buffer[] = []
  private bytes = 0
  private pendingLine = ''
  private eventData: string[] = []
  private eventBytes = 0
  private skipLine = false
  readonly tokens: TokenUsage = { prompt: 0, completion: 0 }
  readonly stream: boolean
  private readonly json: boolean
  private readonly encoding: string
  private readonly contentType: string
  error: string | null = null

  constructor(contentType: string, contentEncoding?: string) {
    this.contentType = contentType
    this.encoding = (contentEncoding || '').trim().toLowerCase()
    this.stream = /text\/event-stream/i.test(contentType)
    this.json = /(?:application\/(?:[\w.+-]*\+)?json)/i.test(contentType)
  }

  observe(chunk: Buffer): void {
    if (this.stream && !this.encoding) { this.readLines(this.decoder.write(chunk)); return }
    if (!this.json && !this.stream) return
    this.bytes += chunk.length
    if (this.bytes <= BODY_CAPTURE_LIMIT) this.chunks.push(chunk)
    else this.chunks = []
  }

  finish(): TokenUsage {
    if (this.encoding) {
      if (this.bytes <= BODY_CAPTURE_LIMIT) {
        try {
          const buffer = Buffer.concat(this.chunks)
          const options = { maxOutputLength: BODY_CAPTURE_LIMIT }
          const decoded = this.encoding === 'gzip' ? gunzipSync(buffer, options) : this.encoding === 'deflate' ? inflateSync(buffer, options) : this.encoding === 'br' ? brotliDecompressSync(buffer, options) : this.encoding === 'identity' ? buffer : null
          if (decoded) {
            const tracker = new UsageTracker(this.contentType)
            tracker.observe(decoded)
            Object.assign(this.tokens, tracker.finish())
            this.error = tracker.error
          }
        } catch { /* Malformed or oversized compression must not interrupt passthrough. */ }
      }
    } else if (this.stream) {
      this.readLines(this.decoder.end())
      if (this.pendingLine) this.processLine(this.pendingLine.replace(/\r$/, ''))
      this.processEvent()
    } else if (this.json && this.bytes <= BODY_CAPTURE_LIMIT) {
      this.parse(Buffer.concat(this.chunks).toString('utf8'))
    }
    return this.tokens
  }

  private readLines(text: string): void {
    for (const segment of text.split('\n').entries()) {
      const [index, part] = segment
      if (index > 0) {
        if (!this.skipLine) this.processLine(this.pendingLine.replace(/\r$/, ''))
        this.pendingLine = ''
        this.skipLine = false
      }
      if (!this.skipLine) {
        if (this.pendingLine.length + part.length > CAPTURE_LIMIT) { this.pendingLine = ''; this.skipLine = true; this.eventData = []; this.eventBytes = 0 }
        else this.pendingLine += part
      }
    }
  }

  private processLine(line: string): void {
    if (!line) { this.processEvent(); return }
    if (!line.startsWith('data:')) return
    const data = line.slice(5).replace(/^ /, '')
    this.eventBytes += data.length
    if (this.eventBytes <= CAPTURE_LIMIT) this.eventData.push(data)
    else this.eventData = []
  }

  private processEvent(): void {
    if (this.eventBytes <= CAPTURE_LIMIT) this.parse(this.eventData.join('\n'))
    this.eventData = []; this.eventBytes = 0
  }

  private parse(text: string): void {
    if (!text || text === '[DONE]') return
    try {
      const body = JSON.parse(text)
      if (this.stream && body?.error) this.error = String(body.error.message || body.error.type || '上游流返回错误').slice(0, 4096)
      const gemini = body?.usageMetadata
      if (gemini && typeof gemini === 'object') {
        this.tokens.prompt = Math.min(Number.MAX_SAFE_INTEGER, Math.max(this.tokens.prompt, count(gemini.promptTokenCount)))
        this.tokens.completion = Math.max(this.tokens.completion, count(gemini.candidatesTokenCount) + count(gemini.thoughtsTokenCount))
        return
      }
      const usage = body.usage || body.message?.usage || body.response?.usage || body.delta?.usage
      if (!usage || typeof usage !== 'object') return
      const prompt = count(usage.prompt_tokens ?? usage.input_tokens) + (usage.prompt_tokens === undefined ? count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens) : 0)
      this.tokens.prompt = Math.min(Number.MAX_SAFE_INTEGER, Math.max(this.tokens.prompt, prompt))
      this.tokens.completion = Math.max(this.tokens.completion, count(usage.completion_tokens ?? usage.output_tokens))
    } catch { /* Usage is optional; malformed events must never interfere with forwarding. */ }
  }
}

/** Metadata inspection never changes the bytes sent upstream. */
export function requestMetadata(body: Buffer | null, contentType: string, requestUrl: string): { model: string; stream: boolean } {
  let model = ''
  let stream = false
  if (body && /(?:json|^\s*$)/i.test(contentType) && body.length <= 50 * 1024 * 1024) {
    try {
      const parsed = JSON.parse(body.toString('utf8'))
      model = typeof parsed?.model === 'string' ? parsed.model.slice(0, 512) : ''
      stream = parsed?.stream === true
    } catch { /* Upstream decides how to handle non-JSON or malformed JSON. */ }
  } else if (body && /multipart\/form-data/i.test(contentType)) {
    // Inspect only small text model fields, never reserialize uploaded files/binary payloads.
    const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
    const marker = boundary && Buffer.from(`--${boundary[1] || boundary[2]}`)
    if (marker && marker.length <= 204) {
      let offset = 0
      while ((offset = body.indexOf(marker, offset)) >= 0) {
        const start = offset + marker.length
        const headerEnd = body.indexOf('\r\n\r\n', start)
        offset = start
        if (headerEnd < 0 || headerEnd - start > 8192) continue
        const header = body.subarray(start, headerEnd).toString('utf8')
        if (!/\bname="model"/i.test(header) || /\bfilename=/i.test(header)) continue
        const end = body.indexOf(marker, headerEnd + 4)
        if (end < 0 || end - headerEnd > 1028) break
        model = body.subarray(headerEnd + 4, end - 2).toString('utf8').slice(0, 512)
        break
      }
    }
  }
  try {
    const url = new URL(requestUrl, 'http://localhost')
    const gemini = geminiModelAction(url.pathname)
    if (gemini) {
      // Gemini 的模型与流式动作在 URL 路径中，必须优先于 body 元数据。
      model = gemini.model.slice(0, 512)
      stream = gemini.stream
    } else if (!model) {
      model = (url.searchParams.get('model') || '').slice(0, 512)
      const singleModel = /^\/v1\/models\/([^/]+)$/.exec(url.pathname)
      if (!model && singleModel) model = decodeURIComponent(singleModel[1]).slice(0, 512)
    }
  } catch { /* Bad paths are handled by routing, not metadata inspection. */ }
  return { model, stream }
}
