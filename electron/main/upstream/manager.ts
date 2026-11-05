import type { UpstreamPlatform, UpstreamKey, RouteMode } from '../../shared/types'
import { loadData, updateKeyStatus } from '../database'
import { publicModelNames, resolveRequestedModel } from '../../shared/models'

export interface SelectionResult { platform: UpstreamPlatform; key: UpstreamKey; requestedModel: string; resolvedModel: string }
export interface RoutePreview {
  platformId: string | null
  platformName: string | null
  reason: string
  error?: string
  requestedModel?: string
  resolvedModel?: string | null
  upstreamProtocol?: 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini'
  downstreamProtocol?: 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini'
  conversion?: 'native' | 'convert'
}
interface Cooldown { until: number; credential: string; error: string }
const lastRoundRobinKey = new Map<string, string>()
const cooldowns = new Map<string, Cooldown>()
const identity = (platformId: string, keyId: string): string => `${platformId}:${keyId}`

export function clearRoutingState(): void { lastRoundRobinKey.clear(); cooldowns.clear() }

function supportsModel(platform: UpstreamPlatform, model: string): boolean {
  return !model || platform.models.length === 0 || platform.models.includes(model)
}

export function findPlatformsByModel(model: string): UpstreamPlatform[] {
  const { settings, platforms } = loadData()
  return platforms.filter((platform) => platform.enabled && supportsModel(platform, resolveRequestedModel(platform, model, settings.enableModelAliases)))
}

/** Explicit paths are pinned; model/path modes never silently send a request to an unrelated platform. */
function routeCandidates(model: string, routeMode: RouteMode, defaultPlatformId: string | null, preferredPlatformId?: string): { platforms: UpstreamPlatform[]; reason: string; aliasesEnabled: boolean } {
  const data = loadData()
  const aliasesEnabled = data.settings.enableModelAliases
  const enabled = data.platforms.filter((platform) => platform.enabled)
  if (preferredPlatformId) {
    return { platforms: enabled.filter((platform) => platform.id === preferredPlatformId), reason: '请求路径明确指定平台（不会切换到其他平台）', aliasesEnabled }
  }
  if (routeMode === 'by-path') {
    return { platforms: enabled.filter((platform) => platform.id === defaultPlatformId), reason: '按路径模式使用默认平台（未设置默认平台时不自动兜底）', aliasesEnabled }
  }
  const matches = (platform: UpstreamPlatform): boolean => {
    const real = resolveRequestedModel(platform, model, aliasesEnabled)
    if (routeMode === 'by-model') return !!model && platform.models.includes(real)
    return supportsModel(platform, real)
  }
  const platforms = enabled.filter(matches)
  // Exact declarations precede platforms with an unknown/empty catalog.
  platforms.sort((a, b) => Number(b.models.includes(resolveRequestedModel(b, model, aliasesEnabled))) - Number(a.models.includes(resolveRequestedModel(a, model, aliasesEnabled))))
  if (routeMode === 'auto' && defaultPlatformId) {
    const index = platforms.findIndex((platform) => platform.id === defaultPlatformId)
    if (index > 0) platforms.unshift(platforms.splice(index, 1)[0])
  }
  return { platforms, reason: !model ? '请求没有 model，使用默认/首个可用平台' : routeMode === 'auto' ? '自动匹配模型，支持该模型的默认平台优先' : '严格按平台模型列表精确匹配（空模型列表不参与匹配）', aliasesEnabled }
}

export function keyRetryAt(platform: UpstreamPlatform, key: UpstreamKey): number | undefined {
  const id = identity(platform.id, key.id)
  const cooldown = cooldowns.get(id)
  if (!cooldown) return undefined
  if (cooldown.credential !== key.key || cooldown.error !== key.lastError || key.status !== 'error' || cooldown.until <= Date.now()) {
    cooldowns.delete(id)
    return undefined
  }
  return cooldown.until
}

function keyAvailable(platform: UpstreamPlatform, key: UpstreamKey): boolean {
  return !!key.key.trim() && ['active', 'error'].includes(key.status) && (key.quotaLimit === 0 || key.quotaUsed < key.quotaLimit) && keyRetryAt(platform, key) === undefined
}

export function selectUpstream(model: string, routeMode: RouteMode, defaultPlatformId: string | null, preferredPlatformId?: string, excluded: ReadonlySet<string> = new Set(), dryRun = false): SelectionResult | null {
  const { platforms, aliasesEnabled } = routeCandidates(model, routeMode, defaultPlatformId, preferredPlatformId)
  for (const platform of platforms) {
    const key = selectKey(platform, excluded, dryRun)
    if (key) return { platform, key, requestedModel: model, resolvedModel: resolveRequestedModel(platform, model, aliasesEnabled) }
  }
  return null
}

export function previewRoute(model: string, preferredPlatformId?: string, downstreamProtocol?: RoutePreview['downstreamProtocol']): RoutePreview {
  const { settings } = loadData()
  const route = routeCandidates(model, settings.routeMode, settings.defaultPlatformId, preferredPlatformId)
  const selection = selectUpstream(model, settings.routeMode, settings.defaultPlatformId, preferredPlatformId, new Set(), true)
  if (!selection) {
    const error = route.platforms.length ? '匹配的平台没有可用 Key（可能已禁用、额度耗尽或暂时冷却）' : preferredPlatformId ? '指定的平台不存在或已禁用' : '没有符合路由规则的平台'
    return { platformId: null, platformName: null, reason: route.reason, error, requestedModel: model, resolvedModel: null, downstreamProtocol }
  }
  return {
    platformId: selection.platform.id, platformName: selection.platform.name, reason: route.reason,
    requestedModel: model, resolvedModel: selection.resolvedModel,
    downstreamProtocol, upstreamProtocol: selection.platform.upstreamProtocol,
    conversion: downstreamProtocol && downstreamProtocol !== selection.platform.upstreamProtocol ? 'convert' : 'native'
  }
}

export function selectKey(platform: UpstreamPlatform, excluded: ReadonlySet<string> = new Set(), dryRun = false): UpstreamKey | null {
  const pool = platform.keys.filter((key) => keyAvailable(platform, key) && !excluded.has(identity(platform.id, key.id)))
  if (!pool.length) return null
  switch (platform.strategy) {
    case 'round-robin': {
      const last = lastRoundRobinKey.get(platform.id)
      const lastIndex = platform.keys.findIndex((key) => key.id === last)
      for (let offset = 1; offset <= platform.keys.length; offset++) {
        const key = platform.keys[(lastIndex + offset) % platform.keys.length]
        if (pool.includes(key)) {
          if (!dryRun) lastRoundRobinKey.set(platform.id, key.id)
          return key
        }
      }
      return pool[0]
    }
    case 'priority': return [...pool].sort((a, b) => a.priority - b.priority || a.errorStreak - b.errorStreak)[0]
    case 'weighted': {
      if (dryRun) return pool[0]
      const total = pool.reduce((sum, key) => sum + key.weight, 0)
      let value = Math.random() * total
      for (const key of pool) { value -= key.weight; if (value < 0) return key }
      return pool[pool.length - 1]
    }
    case 'random': return dryRun ? pool[0] : pool[Math.floor(Math.random() * pool.length)]
    default: return pool[0]
  }
}

export function markKeySuccess(platformId: string, keyId: string, tokens: number, expectedCredential?: string): void {
  const key = loadData().platforms.find((platform) => platform.id === platformId)?.keys.find((item) => item.id === keyId)
  if (!key || (expectedCredential !== undefined && key.key !== expectedCredential)) return
  cooldowns.delete(identity(platformId, keyId))
  const quotaUsed = Math.min(Number.MAX_SAFE_INTEGER, key.quotaUsed + (Number.isFinite(tokens) ? Math.max(0, tokens) : 0))
  updateKeyStatus(platformId, keyId, {
    requestCount: Math.min(Number.MAX_SAFE_INTEGER, key.requestCount + 1), quotaUsed,
    errorStreak: 0, lastError: null, lastUsedAt: Date.now(),
    // A request completing after a manual disable must not re-enable that Key.
    status: key.status === 'disabled' || key.status === 'exhausted' ? key.status : key.quotaLimit > 0 && quotaUsed >= key.quotaLimit ? 'exhausted' : 'active'
  })
}

export function recordPartialUsage(platformId: string, keyId: string, tokens: number, expectedCredential: string): void {
  const key = loadData().platforms.find((platform) => platform.id === platformId)?.keys.find((item) => item.id === keyId)
  if (!key || key.key !== expectedCredential || !Number.isFinite(tokens) || tokens <= 0) return
  const quotaUsed = Math.min(Number.MAX_SAFE_INTEGER, key.quotaUsed + tokens)
  updateKeyStatus(platformId, keyId, { quotaUsed, status: key.status === 'disabled' || key.status === 'exhausted' ? key.status : key.quotaLimit > 0 && quotaUsed >= key.quotaLimit ? 'exhausted' : key.status })
}

export function markKeyError(platformId: string, keyId: string, error: string, statusCode: number, retryAfterMs?: number, quotaExhausted = false, expectedCredential?: string): void {
  const data = loadData()
  const key = data.platforms.find((platform) => platform.id === platformId)?.keys.find((item) => item.id === keyId)
  if (!key || (expectedCredential !== undefined && key.key !== expectedCredential)) return
  const fault = statusCode === 401 || statusCode === 403 || statusCode === 429 || statusCode >= 500 || statusCode === 0
  const streak = fault ? Math.min(Number.MAX_SAFE_INTEGER, key.errorStreak + 1) : key.errorStreak
  const message = error.slice(0, 4096)
  let status = key.status
  if (status !== 'disabled' && status !== 'exhausted' && fault) {
    const policy = data.settings.keyErrorPolicy
    if (policy === 'disable') status = 'disabled'
    else if (policy === 'ignore') {
      // 完全忽略故障：不冷却、不改状态，只记录错误用于展示。
      cooldowns.delete(identity(platformId, keyId))
    } else {
      status = 'error'
      const baseDelay = quotaExhausted ? 300000 : statusCode === 429 ? 30000 : Math.min(60000, 1000 * 2 ** Math.min(streak - 1, 6))
      const delay = retryAfterMs ?? baseDelay
      cooldowns.set(identity(platformId, keyId), { until: Date.now() + Math.max(100, Math.min(delay, 86400000)), credential: key.key, error: message })
    }
  }
  updateKeyStatus(platformId, keyId, { requestCount: Math.min(Number.MAX_SAFE_INTEGER, key.requestCount + 1), errorStreak: streak, lastError: message, lastUsedAt: Date.now(), status })
}

function platformUsable(platform: UpstreamPlatform): boolean {
  return platform.enabled && platform.keys.some((key) => ['active', 'error'].includes(key.status) && (key.quotaLimit === 0 || key.quotaUsed < key.quotaLimit))
}

/** 下游公开模型目录：应用别名与显示原名规则，不泄露应隐藏的真实模型名。 */
export function getAllAvailableModels(platformId?: string): string[] {
  const { platforms, settings } = loadData()
  const models = new Set<string>()
  for (const platform of platforms) {
    if (platformId && platform.id !== platformId) continue
    if (!platformUsable(platform)) continue
    for (const model of publicModelNames(platform, settings.enableModelAliases)) models.add(model)
  }
  return [...models].sort()
}

export function selectionIdentity(selection: SelectionResult): string { return identity(selection.platform.id, selection.key.id) }
