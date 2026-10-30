import type { ProxyConfig, UpstreamKey, UpstreamPlatform } from '../../electron/shared/types'

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

export function clientBaseUrl(proxy: Pick<ProxyConfig, 'host' | 'port'>): string {
  const host = proxy.host === '0.0.0.0' ? '127.0.0.1' : proxy.host === '::' ? '::1' : proxy.host
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${proxy.port}`
}

export function usableKeys(platform: UpstreamPlatform): UpstreamKey[] {
  return platform.keys.filter((key) => !!key.key.trim() && ['active', 'error'].includes(key.status) && (key.retryAt === undefined || key.retryAt <= Date.now()) && (key.quotaLimit === 0 || key.quotaUsed < key.quotaLimit))
}

export function maskSecret(secret: string): string {
  return secret.length > 12 ? `${secret.slice(0, 4)}••••••••${secret.slice(-4)}` : '••••••••••••'
}

export function formatDuration(milliseconds: number): string {
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(2)} s` : `${Math.round(milliseconds)} ms`
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}
