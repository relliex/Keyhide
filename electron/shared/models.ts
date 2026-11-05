import type { ModelAlias, UpstreamPlatform } from './types'

export function modelAliasEntry(platform: UpstreamPlatform, model: string): ModelAlias | undefined {
  return platform.modelAliases?.find((entry) => entry.model === model)
}

/** 下游请求名称 → 实际路由模型。隐藏原名只是目录展示，已知真实名称仍可直接请求。 */
export function resolveRequestedModel(platform: UpstreamPlatform, requested: string, aliasesEnabled: boolean): string {
  if (!aliasesEnabled || !requested) return requested
  const entry = platform.modelAliases?.find((item) => item.aliases?.includes(requested))
  return entry ? entry.model : requested
}

/** 一个平台对下游公开的模型名称。失效映射（真实模型已不在目录）不会公开。 */
export function publicModelNames(platform: UpstreamPlatform, aliasesEnabled: boolean): string[] {
  const names = new Set<string>()
  for (const model of platform.models) {
    if (!aliasesEnabled) { names.add(model); continue }
    const entry = modelAliasEntry(platform, model)
    if (!entry) { names.add(model); continue }
    for (const alias of entry.aliases) names.add(alias)
    if (entry.showOriginal) names.add(model)
  }
  return [...names].sort()
}

/** 一个平台里实际可用的模型（用于目录与路由）。 */
export function routableModelNames(platform: UpstreamPlatform, aliasesEnabled: boolean): string[] {
  return aliasesEnabled ? publicModelNames(platform, true) : platform.models
}

export function invalidAliasModels(platform: UpstreamPlatform): string[] {
  return (platform.modelAliases || []).filter((entry) => !platform.models.includes(entry.model)).map((entry) => entry.model)
}

/** 前端保存前的快速检查；后端仍有权威校验。 */
export function aliasValidationError(platform: UpstreamPlatform, model: string, aliases: string[]): string | null {
  const normalized = aliases.map((alias) => alias.trim()).filter(Boolean)
  const seen = new Set<string>()
  for (const alias of normalized) {
    if (alias.length > 512) return '别名不能超过 512 个字符'
    if (/[\u0000-\u001f\u007f]/.test(alias)) return '别名不能包含控制字符'
    if (/[/:]/.test(alias)) return '别名不能包含 / 或 :（避免与接口路径冲突）'
    if (seen.has(alias)) return `别名“${alias}”重复`
    seen.add(alias)
    if (alias === model) return '别名不能与真实模型同名'
    if (platform.models.some((name) => name !== model && name === alias)) return `别名“${alias}”与该平台的其他真实模型冲突`
    for (const entry of platform.modelAliases || []) {
      if (entry.model !== model && entry.aliases.includes(alias)) return `别名“${alias}”已用于模型“${entry.model}”`
    }
  }
  return null
}
