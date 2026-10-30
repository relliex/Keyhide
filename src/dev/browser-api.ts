import type { AppData, UpstreamKey, UpstreamPlatform } from '../../electron/shared/types'

export function installBrowserPreview(): void {
  const key = (label: string, status: UpstreamKey['status'] = 'active'): UpstreamKey => ({ id: crypto.randomUUID(), label, key: `preview-only-${label}`, status, requestCount: 24, lastUsedAt: Date.now(), lastError: null, errorStreak: 0, weight: 1, priority: 0, quotaLimit: 0, quotaUsed: 2400, createdAt: Date.now() })
  const platform = (): UpstreamPlatform => ({ id: crypto.randomUUID(), name: '', type: 'openai', baseUrl: '', models: [], keys: [], strategy: 'round-robin', enabled: true, customHeaders: {}, createdAt: Date.now(), updatedAt: Date.now() })
  const now = Date.now()
  const examplePlatforms: UpstreamPlatform[] = [
    { ...platform(), id: 'preview-development', name: '开发环境', baseUrl: 'https://api.example.com', keys: [key('主账户'), key('备用账户')], models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'o3', 'text-embedding-3-small'] },
    { ...platform(), id: 'preview-anthropic', name: 'Anthropic 工作空间', type: 'anthropic', baseUrl: 'https://api.anthropic.com', keys: [key('工作账户')], models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
    { ...platform(), id: 'preview-local', name: '本地兼容服务', type: 'custom', baseUrl: 'http://127.0.0.1:11434', keys: [key('本地开发', 'disabled')], models: ['local-model'], enabled: false }
  ]
  const storageKey = 'keyhide-interface-preview-v1'
  const initial: AppData = { platforms: examplePlatforms, proxy: { host: '127.0.0.1', port: 7860, maskedApiKey: 'sk-keyhide-preview-not-a-real-credential', running: false, cors: false, timeout: 120000, logRequests: true, maxLogs: 1000 }, settings: { routeMode: 'auto', defaultPlatformId: 'preview-development', autoStartProxy: false, minimizeToTray: true, autoDisableKeyOnError: false, theme: 'dark' }, logs: Array.from({ length: 124 }, (_, index) => ({ id: `preview-log-${index}`, timestamp: now - index * 45000, method: 'POST', path: index % 3 === 0 ? '/v1/messages' : '/v1/chat/completions', format: index % 3 === 0 ? 'anthropic' : 'openai', model: index % 3 === 0 ? 'claude-sonnet-5-5' : index % 2 ? 'gpt-4.1-mini' : 'gpt-4.1', platformId: index % 3 === 0 ? 'preview-anthropic' : 'preview-development', platformName: index % 3 === 0 ? 'Anthropic 工作空间' : '开发环境', keyLabel: index % 3 === 0 ? '工作账户' : '主账户', statusCode: index % 11 === 0 ? 429 : 200, duration: 640 + index * 17 % 1300, promptTokens: 128 + index * 8, completionTokens: index % 11 === 0 ? 0 : 320 + index * 3, stream: index % 2 === 0, error: index % 11 === 0 ? 'HTTP 429：请求频率超过上游限制' : null, clientIp: '127.0.0.1' })) }
  let data: AppData = initial
  try { const stored = localStorage.getItem(storageKey); if (stored) data = JSON.parse(stored) } catch { data = initial }
  const listeners = new Set<() => void>()
  const statusListeners = new Set<(running: boolean) => void>()
  const persist = () => { localStorage.setItem(storageKey, JSON.stringify(data)); listeners.forEach((listener) => listener()) }
  const clone = <T,>(value: T): T => structuredClone(value)
  window.api = {
    getData: async () => clone(data),
    savePlatform: async (value) => { const index = data.platforms.findIndex((item) => item.id === value.id); if (index >= 0) data.platforms[index] = clone(value); else data.platforms.push(clone(value)); persist(); return clone(value) },
    deletePlatform: async (id) => { data.platforms = data.platforms.filter((value) => value.id !== id); if (data.settings.defaultPlatformId === id) data.settings.defaultPlatformId = null; persist() },
    saveProxyConfig: async (value) => { data.proxy = { ...data.proxy, ...value }; persist(); return clone(data.proxy) },
    saveSettings: async (value) => { data.settings = { ...data.settings, ...value }; persist(); return clone(data.settings) },
    clearLogs: async () => { data.logs = []; persist() },
    resetStats: async () => { data.logs = []; for (const p of data.platforms) p.keys = p.keys.map((k) => ({ ...k, requestCount: 0, quotaUsed: 0, errorStreak: 0, lastError: null, lastUsedAt: null, status: k.status === 'disabled' ? 'disabled' : 'active' })); persist() },
    clearAllData: async () => { const maskedApiKey = data.proxy.maskedApiKey; data = clone(initial); data.platforms = []; data.logs = []; data.proxy.maskedApiKey = maskedApiKey; data.settings.defaultPlatformId = null; persist() },
    startProxy: async () => { data.proxy.running = true; statusListeners.forEach((callback) => callback(true)); persist(); return { success: true, message: '预览状态已切换，未启动真实服务' } },
    stopProxy: async () => { data.proxy.running = false; statusListeners.forEach((callback) => callback(false)); persist(); return { success: true, message: '预览状态已停止' } },
    fetchModels: async (id) => clone(data.platforms.find((value) => value.id === id)?.models || []),
    testConnection: async () => ({ success: true, message: '仅界面预览，未进行真实连接测试' }),
    exportConfig: async () => JSON.stringify({ platforms: data.platforms, proxy: data.proxy, settings: data.settings }, null, 2),
    importConfig: async (content) => { const imported = JSON.parse(content); data = { ...data, ...imported }; persist(); return { success: true, message: '预览配置已导入' } },
    previewRoute: async (input) => { const explicit = input.path.split('/')[1]; const selected = data.platforms.find((p) => p.id === explicit) || (data.settings.routeMode === 'by-path' ? data.platforms.find((p) => p.id === data.settings.defaultPlatformId) : data.platforms.find((p) => p.enabled && p.models.includes(input.model))); const usable = selected?.enabled && selected.keys.some((k) => k.status === 'active'); return { platformId: usable ? selected!.id : null, platformName: usable ? selected!.name : null, reason: '仅预览模拟数据。实际路由由桌面代理判断。', error: usable ? undefined : '没有匹配的可用模拟平台' } },
    onLogAdded: () => () => {},
    onProxyStatusChanged: (callback) => { statusListeners.add(callback); return () => { statusListeners.delete(callback) } },
    onToast: () => () => {},
    onDataChanged: (callback) => { listeners.add(callback); return () => { listeners.delete(callback) } }
  }
  window.extraApi = {
    createPlatform: async () => platform(),
    createKey: async (value, label) => ({ ...key(label), key: value, requestCount: 0, quotaUsed: 0 }),
    regenerateMaskedKey: async () => { data.proxy.maskedApiKey = `sk-keyhide-preview-${crypto.randomUUID()}`; persist(); return clone(data.proxy) },
    clipboardWrite: async (value) => navigator.clipboard.writeText(value),
    saveFileDialog: async (name, content) => { const objectUrl = URL.createObjectURL(new Blob([content], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); return { success: true, path: name } },
    openFileDialog: async () => ({ success: false })
  }
}
