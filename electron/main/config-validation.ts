import { z } from 'zod'
import { validateHeaderName, validateHeaderValue } from 'http'
import type { AppData, AppSettings, ProxyConfig, UpstreamPlatform, UpstreamKey } from '../shared/types'

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'ID 只能包含字母、数字、下划线和连字符')
const counter = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER)
const timestamp = counter
const secret = z.string().trim().min(1).max(16384).refine((value) => !/[\r\n\0]/.test(value), 'Key 不能包含换行或空字符')
const modelList = z.array(z.string().trim().min(1).max(512)).max(20000).transform((models) => [...new Set(models)])
const protocol = z.enum(['anthropic', 'openai-chat', 'openai-responses', 'gemini'])
const modelName = z.string().trim().min(1).max(512).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), '模型名称不能包含控制字符')
const aliasName = modelName.refine((value) => !/[/:]/.test(value), '模型别名不能包含 / 或 :')
const aliasSchema = z.object({
  model: modelName,
  aliases: z.array(aliasName).max(64).default([]),
  showOriginal: z.boolean().default(true)
})
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
  id: id.refine((value) => value !== 'v1' && value !== 'v1beta', '平台 ID 不能使用保留路径 v1 或 v1beta'),
  name: z.string().trim().max(256).default(''),
  type: z.enum(['openai', 'anthropic', 'custom']).default('openai'),
  upstreamProtocol: protocol.optional(),
  baseUrl,
  models: modelList.default([]),
  modelAliases: z.array(aliasSchema).max(20000).default([]),
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
  if (platform.modelAliases.length && new Set(platform.modelAliases.map((entry) => entry.model)).size !== platform.modelAliases.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['modelAliases'], message: '同一模型只能有一条别名配置' })
  }
  const realModels = new Set(platform.models)
  const claimed = new Map<string, string>()
  for (const entry of platform.modelAliases) {
    if (new Set(entry.aliases).size !== entry.aliases.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['modelAliases'], message: `模型“${entry.model}”的别名重复` })
    }
    for (const alias of entry.aliases) {
      if (alias === entry.model) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['modelAliases'], message: `别名“${alias}”不能与真实模型同名` })
      if (realModels.has(alias) && alias !== entry.model) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['modelAliases'], message: `别名“${alias}”与该平台的其他真实模型冲突` })
      const owner = claimed.get(alias)
      if (owner && owner !== entry.model) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['modelAliases'], message: `别名“${alias}”已用于模型“${owner}”` })
      claimed.set(alias, entry.model)
    }
  }
}).transform((platform) => ({
  ...platform,
  upstreamProtocol: (platform.upstreamProtocol || (platform.type === 'anthropic' ? 'anthropic' : 'openai-chat')) as 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini'
}))

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
  enableModelAliases: z.boolean(),
  keyErrorPolicy: z.enum(['cooldown', 'ignore', 'disable']),
  autoStartProxy: z.boolean(),
  minimizeToTray: z.boolean(),
  theme: z.literal('dark')
})

/** 1.0.3 之前的布尔开关迁移为三态策略；其余设置不受影响。 */
function migrateSettings(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const copy = { ...(value as Record<string, unknown>) }
  if (copy.keyErrorPolicy === undefined && copy.autoDisableKeyOnError !== undefined) {
    copy.keyErrorPolicy = copy.autoDisableKeyOnError === true ? 'disable' : 'cooldown'
  }
  delete copy.autoDisableKeyOnError
  return copy
}

const logSchema = z.object({
  id, timestamp, method: z.string().max(32), path: z.string().max(16384),
  format: z.enum(['openai', 'anthropic', 'openai-chat', 'openai-responses', 'gemini']), model: z.string().max(512),
  resolvedModel: z.string().max(512).optional(),
  upstreamProtocol: protocol.optional(),
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
export function validateSettings(value: unknown): AppSettings { return parse(settingsSchema, migrateSettings(value)) }
export function validateProxyPatch(value: unknown): Partial<ProxyConfig> { return parse(proxySchema.partial(), value) }
export function validateSettingsPatch(value: unknown): Partial<AppSettings> { return parse(settingsSchema.partial(), migrateSettings(value)) }

export function validateData(value: unknown, defaults: AppData): AppData {
  const object = parse(z.object({
    platforms: z.array(platformSchema).max(200).default([]),
    proxy: proxySchema.partial().default({}),
    settings: z.preprocess(migrateSettings, settingsSchema.partial()).optional(),
    logs: z.array(logSchema).max(20000).default([])
  }), value)
  if (new Set(object.platforms.map((platform) => platform.id)).size !== object.platforms.length) {
    throw new Error('配置无效：平台 ID 不能重复')
  }
  const proxy = validateProxy({ ...defaults.proxy, ...object.proxy })
  const settings = validateSettings({ ...defaults.settings, ...(object.settings || {}) })
  if (settings.defaultPlatformId && !object.platforms.some((platform) => platform.id === settings.defaultPlatformId)) {
    throw new Error('配置无效：默认平台不存在')
  }
  return { platforms: object.platforms, proxy, settings, logs: object.logs.slice(0, proxy.maxLogs) }
}

export function validateImport(value: unknown, current: AppData): AppData {
  const imported = parse(z.object({
    platforms: z.array(platformSchema).max(200).optional(),
    proxy: proxySchema.partial().optional(),
    settings: z.preprocess(migrateSettings, settingsSchema.partial()).optional()
  }).refine((data) => data.platforms !== undefined || data.proxy !== undefined || data.settings !== undefined, '没有可导入的配置'), value)
  return validateData({
    ...current,
    ...imported,
    proxy: { ...current.proxy, ...imported.proxy, running: current.proxy.running },
    settings: { ...current.settings, ...(imported.settings || {}) },
    logs: current.logs
  }, current)
}
