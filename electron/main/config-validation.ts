import { z } from 'zod'
import { validateHeaderName, validateHeaderValue } from 'http'
import type { AppData, AppSettings, ProxyConfig, UpstreamPlatform, UpstreamKey } from '../shared/types'

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'ID 只能包含字母、数字、下划线和连字符')
const counter = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER)
const timestamp = counter
const secret = z.string().trim().min(1).max(16384).refine((value) => !/[\r\n\0]/.test(value), 'Key 不能包含换行或空字符')
const modelList = z.array(z.string().trim().min(1).max(512)).max(20000).transform((models) => [...new Set(models)])
const reservedHeaders = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'trailer', 'te', 'proxy-authorization', 'proxy-authenticate'])

const headers = z.record(z.string(), z.string().max(16384)).superRefine((values, ctx) => {
  for (const [name, value] of Object.entries(values)) {
    try {
      validateHeaderName(name)
      validateHeaderValue(name, value)
      if (reservedHeaders.has(name.toLowerCase())) throw new Error('该请求头由代理管理')
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: '请求头无效或属于代理保留字段' })
    }
  }
}).transform((values) => Object.fromEntries(Object.entries(values).map(([name, value]) => [name.toLowerCase(), value])))

const baseUrl = z.string().trim().min(1).max(8192).superRefine((value, ctx) => {
  try {
    const url = new URL(value)
    // Local HTTP services are legitimate upstreams; do not impose an SSRF-style host blocklist.
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) throw new Error()
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Base URL 必须是有效的 HTTP(S) 地址，不能包含用户名、密码或片段' })
  }
})

export const keySchema = z.object({
  id,
  key: secret,
  label: z.string().trim().max(256).default(''),
  status: z.enum(['active', 'exhausted', 'error', 'disabled']).default('active'),
  requestCount: counter.int().default(0),
  lastUsedAt: timestamp.nullable().default(null),
  lastError: z.string().max(4096).nullable().default(null),
  errorStreak: counter.int().default(0),
  weight: z.number().finite().positive().max(1000000).default(1),
  priority: z.number().int().min(-1000000).max(1000000).default(0),
  quotaLimit: counter.default(0),
  quotaUsed: counter.default(0),
  createdAt: timestamp.default(() => Date.now())
})

export const platformSchema = z.object({
  id: id.refine((value) => value !== 'v1', '平台 ID 不能使用保留路径 v1'),
  name: z.string().trim().max(256).default(''),
  type: z.enum(['openai', 'anthropic', 'custom']).default('openai'),
  baseUrl,
  models: modelList.default([]),
  keys: z.array(keySchema).max(500).default([]),
  strategy: z.enum(['round-robin', 'weighted', 'priority', 'random']).default('round-robin'),
  enabled: z.boolean().default(true),
  customHeaders: headers.default({}),
  createdAt: timestamp.default(() => Date.now()),
  updatedAt: timestamp.default(() => Date.now())
}).superRefine((platform, ctx) => {
  if (new Set(platform.keys.map((key) => key.id)).size !== platform.keys.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keys'], message: 'Key ID 不能重复' })
  }
})

const proxySchema = z.object({
  port: z.number().int().min(1).max(65535),
  host: z.string().trim().min(1).max(253).refine((value) => {
    // Support IPs (including IPv6), localhost and custom bind hostnames, not URLs or paths.
    return !/[\s/\\?#@\0]/.test(value) && (value.includes(':') ? /^[0-9a-f:.]+$/i.test(value) : /^[a-z0-9._-]+$/i.test(value))
  }, '监听地址无效（请填写 IP 或主机名，不要填写 URL）'),
  maskedApiKey: secret,
  running: z.boolean(),
  cors: z.boolean(),
  timeout: z.number().int().min(100).max(3600000),
  logRequests: z.boolean(),
  maxLogs: z.number().int().min(0).max(20000)
})

const settingsSchema = z.object({
  routeMode: z.enum(['auto', 'by-model', 'by-path']),
  defaultPlatformId: id.nullable(),
  autoStartProxy: z.boolean(),
  minimizeToTray: z.boolean(),
  autoDisableKeyOnError: z.boolean(),
  theme: z.literal('dark')
})

const logSchema = z.object({
  id, timestamp, method: z.string().max(32), path: z.string().max(16384),
  format: z.enum(['openai', 'anthropic']), model: z.string().max(512),
  platformId: z.string().max(128), platformName: z.string().max(256), keyLabel: z.string().max(256),
  statusCode: z.number().int().min(0).max(599), duration: counter,
  promptTokens: counter, completionTokens: counter, stream: z.boolean(),
  error: z.string().max(4096).nullable(), clientIp: z.string().max(256)
})

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new Error(`配置无效：${issue.path.join('.') || '配置'} ${issue.message}`)
  }
  return result.data
}

export function validatePlatform(value: unknown): UpstreamPlatform { return parse(platformSchema, value) }
export function validateKey(value: unknown): UpstreamKey { return parse(keySchema, value) }
export function validateId(value: unknown): string { return parse(id, value) }
export function validateModels(value: unknown): string[] { return parse(modelList, value) }
export function validateProxy(value: unknown): ProxyConfig { return parse(proxySchema, value) }
export function validateSettings(value: unknown): AppSettings { return parse(settingsSchema, value) }
export function validateProxyPatch(value: unknown): Partial<ProxyConfig> { return parse(proxySchema.partial(), value) }
export function validateSettingsPatch(value: unknown): Partial<AppSettings> { return parse(settingsSchema.partial(), value) }

export function validateData(value: unknown, defaults: AppData): AppData {
  const object = parse(z.object({
    platforms: z.array(platformSchema).max(200).default([]),
    proxy: proxySchema.partial().default({}),
    settings: settingsSchema.partial().default({}),
    logs: z.array(logSchema).max(20000).default([])
  }), value)
  if (new Set(object.platforms.map((platform) => platform.id)).size !== object.platforms.length) {
    throw new Error('配置无效：平台 ID 不能重复')
  }
  const proxy = validateProxy({ ...defaults.proxy, ...object.proxy })
  const settings = validateSettings({ ...defaults.settings, ...object.settings })
  if (settings.defaultPlatformId && !object.platforms.some((platform) => platform.id === settings.defaultPlatformId)) {
    throw new Error('配置无效：默认平台不存在')
  }
  return { platforms: object.platforms, proxy, settings, logs: object.logs.slice(0, proxy.maxLogs) }
}

export function validateImport(value: unknown, current: AppData): AppData {
  const imported = parse(z.object({
    platforms: z.array(platformSchema).max(200).optional(),
    proxy: proxySchema.partial().optional(),
    settings: settingsSchema.partial().optional()
  }).refine((data) => data.platforms !== undefined || data.proxy !== undefined || data.settings !== undefined, '没有可导入的配置'), value)
  return validateData({
    ...current,
    ...imported,
    proxy: { ...current.proxy, ...imported.proxy, running: current.proxy.running },
    settings: { ...current.settings, ...imported.settings },
    logs: current.logs
  }, current)
}
