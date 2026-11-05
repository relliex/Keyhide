import { join } from 'path'
import { readFileSync, existsSync, mkdirSync } from 'fs'
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto'
import { hostname, userInfo, homedir } from 'os'
import type { AppData, UpstreamPlatform, UpstreamKey, ProxyConfig, AppSettings, RequestLog, ModelAliasUpdate } from '../shared/types'
import { atomicWriteFile, quarantineFile } from './persistence'
import { validateData, validatePlatform, validateKey, validateProxy, validateSettings, validateModels, validateId, validateImport, validateProxyPatch, validateSettingsPatch } from './config-validation'

const DATA_FILE = 'keyhide.enc'
const SALT_FILE = 'keyhide.salt'
function generateId(): string { return randomBytes(12).toString('hex') }
function generateMaskedKey(): string { return 'sk-keyhide-' + randomBytes(16).toString('hex') }
function getDataDir(): string {
  return process.env.KEYHIDE_USER_DATA_DIR
    ? join(process.env.KEYHIDE_USER_DATA_DIR, 'data')
    : join(homedir(), 'AppData', 'LocalLow', 'Keyhide')
}
function getDataPath(): string { return join(getDataDir(), DATA_FILE) }
function getSaltPath(): string { return join(getDataDir(), SALT_FILE) }

let encryptionKey: Buffer | null = null
let encryptionSalt = ''
function getEncryptionKey(salt: Buffer): Buffer {
  if (salt.length !== 32) throw new Error('加密盐损坏')
  const fingerprint = salt.toString('hex')
  if (!encryptionKey || encryptionSalt !== fingerprint) {
    encryptionKey = scryptSync(`${hostname()}-${userInfo().username}-keyhide-v1`, salt, 32)
    encryptionSalt = fingerprint
  }
  return encryptionKey
}

function encryptData(data: string, key: Buffer): Buffer {
  // Keep the existing on-disk format compatible with previous releases.
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
}

function decryptData(encrypted: Buffer, key: Buffer): string {
  if (encrypted.length < 33) throw new Error('加密数据不完整')
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 16))
  decipher.setAuthTag(encrypted.subarray(16, 32))
  return decipher.update(encrypted.subarray(32), undefined, 'utf8') + decipher.final('utf8')
}

function getOrCreateSalt(): Buffer {
  const path = getSaltPath()
  if (existsSync(path)) {
    const salt = readFileSync(path)
    if (salt.length !== 32) throw new Error('加密盐损坏')
    return salt
  }
  const salt = randomBytes(32)
  atomicWriteFile(path, salt)
  return salt
}

function defaultData(): AppData {
  return {
    platforms: [],
    proxy: {
      port: 7860, host: '127.0.0.1', maskedApiKey: generateMaskedKey(), running: false,
      cors: true, timeout: 120000, logRequests: true, maxLogs: 2000
    },
    settings: {
      routeMode: 'auto', defaultPlatformId: null, enableModelAliases: false, keyErrorPolicy: 'cooldown', autoStartProxy: false,
      minimizeToTray: false, theme: 'dark'
    },
    logs: []
  }
}

let cache: AppData | null = null
let dirty = false
let saveTimer: NodeJS.Timeout | null = null

export function loadData(): AppData {
  if (cache) return cache
  mkdirSync(getDataDir(), { recursive: true })
  const path = getDataPath()
  const backupPath = `${path}.bak`
  const defaults = defaultData()
  if (existsSync(path) || existsSync(backupPath)) {
    let readError: unknown
    for (const candidate of [path, backupPath]) {
      if (!existsSync(candidate)) continue
      let parsed: AppData
      try {
        // Never create a new salt for existing ciphertext, which would make recovery impossible.
        const key = getEncryptionKey(readFileSync(getSaltPath()))
        parsed = validateData(JSON.parse(decryptData(readFileSync(candidate), key)), defaults)
      } catch (error) {
        readError = error
        continue
      }
      parsed.proxy.running = false
      cache = parsed
      if (candidate === backupPath) {
        const preserved = quarantineFile(path)
        console.warn('Recovered encrypted data from backup; damaged file preserved:', preserved)
        // A repair-write failure does not make the successfully decoded backup corrupt.
        try { persist(parsed) } catch (error) { console.error('Backup loaded, but could not repair the main data file:', error) }
      }
      return cache
    }
    console.error('Failed to load encrypted data; preserving damaged files before recovery:', readError)
    // If preservation itself fails (permissions/disk full), propagate instead of destroying data.
    quarantineFile(path)
    quarantineFile(backupPath)
    if (existsSync(getSaltPath()) && readFileSync(getSaltPath()).length !== 32) quarantineFile(getSaltPath())
  }
  persist(defaults)
  cache = defaults
  return cache
}

function persist(data: AppData): void {
  mkdirSync(getDataDir(), { recursive: true })
  const key = getEncryptionKey(getOrCreateSalt())
  const stored = { ...data, proxy: { ...data.proxy, running: false } }
  atomicWriteFile(getDataPath(), encryptData(JSON.stringify(stored), key), true)
}

/** Configuration changes are synchronous transactions: failed saves do not update the cache. */
export function saveData(data?: AppData): void {
  const value = data || cache
  if (!value) return
  const validated = validateData(value, defaultData())
  persist(validated)
  cache = validated
  dirty = false
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
}

/** Statistics/logs share a short write batch, without recalculating scrypt on every request. */
function scheduleSave(): void {
  dirty = true
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try { flushData() } catch (error) { console.error('Failed to persist request statistics:', error) }
  }, 200)
  saveTimer.unref()
}

export function flushData(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (dirty && cache) {
    persist(cache)
    dirty = false
  }
}

export function getData(): AppData { return structuredClone(loadData()) }

/** Running is a runtime fact, never accepted from imported or renderer configuration. */
let proxyStarting = false
export function setProxyStarting(starting: boolean): void { proxyStarting = starting }

export function setProxyRunning(running: boolean): void { loadData().proxy.running = running }

export function savePlatform(platform: UpstreamPlatform, lastRendererSnapshot?: UpstreamPlatform): UpstreamPlatform {
  const data = loadData()
  const incoming = validatePlatform(platform)
  const previous = data.platforms.find((item) => item.id === incoming.id)
  if (previous) {
    incoming.createdAt = previous.createdAt
    incoming.keys = incoming.keys.map((key) => {
      const current = previous.keys.find((item) => item.id === key.id)
      if (!current) return key
      const snapshot = lastRendererSnapshot?.keys.find((item) => item.id === key.id)
      const credentialChanged = key.key !== current.key
      return {
        ...key,
        requestCount: current.requestCount, quotaUsed: current.quotaUsed,
        lastUsedAt: current.lastUsedAt, createdAt: current.createdAt,
        errorStreak: credentialChanged ? 0 : current.errorStreak,
        lastError: credentialChanged ? null : current.lastError,
        // Preserve runtime status when a stale UI merely saves a label/header/etc.
        status: credentialChanged ? key.status : snapshot && snapshot.status === key.status ? current.status : key.status
      }
    })
  }
  incoming.updatedAt = Date.now()
  const platforms = previous ? data.platforms.map((item) => item.id === incoming.id ? incoming : item) : [...data.platforms, incoming]
  saveData({ ...data, platforms })
  return structuredClone(loadData().platforms.find((item) => item.id === incoming.id)!)
}

export function deletePlatform(id: string): void {
  validateId(id)
  const data = loadData()
  saveData({
    ...data,
    platforms: data.platforms.filter((platform) => platform.id !== id),
    settings: { ...data.settings, defaultPlatformId: data.settings.defaultPlatformId === id ? null : data.settings.defaultPlatformId }
  })
}

export function assertProxyConfigMutable(next: ProxyConfig): void {
  const current = loadData().proxy
  if ((current.running || proxyStarting) && (next.port !== current.port || next.host !== current.host || next.cors !== current.cors)) {
    throw new Error('请先停止代理服务，再修改监听地址、端口或跨域设置')
  }
}

export function saveProxyConfig(config: Partial<ProxyConfig>): ProxyConfig {
  const data = loadData()
  const proxy = validateProxy({ ...data.proxy, ...validateProxyPatch(config), running: data.proxy.running })
  assertProxyConfigMutable(proxy)
  saveData({ ...data, proxy, logs: data.logs.slice(0, proxy.maxLogs) })
  return structuredClone(loadData().proxy)
}

export function saveSettings(settings: Partial<AppSettings>): AppSettings {
  const data = loadData()
  saveData({ ...data, settings: validateSettings({ ...data.settings, ...validateSettingsPatch(settings) }) })
  return structuredClone(loadData().settings)
}

export function importConfig(value: unknown): void {
  const next = validateImport(value, loadData())
  assertProxyConfigMutable(next.proxy)
  saveData(next)
}

export function addLog(log: RequestLog): void {
  const data = loadData()
  if (!data.proxy.logRequests || data.proxy.maxLogs === 0) return
  data.logs.unshift(log)
  data.logs.length = Math.min(data.logs.length, data.proxy.maxLogs)
  scheduleSave()
}

export function clearLogs(): void { saveData({ ...loadData(), logs: [] }) }

export function resetStats(): void {
  const data = getData()
  data.logs = []
  for (const platform of data.platforms) {
    for (const key of platform.keys) {
      key.requestCount = 0; key.quotaUsed = 0; key.errorStreak = 0
      key.lastError = null; key.lastUsedAt = null
      if (key.status === 'exhausted' || key.status === 'error') key.status = 'active'
    }
  }
  saveData(data)
}

export function clearAllData(): void {
  const current = loadData()
  if (current.proxy.running || proxyStarting) throw new Error('请先停止代理服务，再清除所有数据')
  const next = defaultData()
  next.proxy.maskedApiKey = current.proxy.maskedApiKey
  saveData(next)
}

export function updatePlatformModels(platformId: string, models: string[]): void {
  const data = loadData()
  const validated = validateModels(models)
  saveData({ ...data, platforms: data.platforms.map((platform) => platform.id === platformId ? { ...platform, models: validated, updatedAt: Date.now() } : platform) })
}

export function updateKeyStatus(platformId: string, keyId: string, update: Partial<UpstreamKey>): void {
  const data = loadData()
  const platform = data.platforms.find((item) => item.id === platformId)
  const index = platform?.keys.findIndex((key) => key.id === keyId) ?? -1
  if (!platform || index < 0) return
  platform.keys[index] = { ...platform.keys[index], ...update }
  platform.updatedAt = Date.now()
  scheduleSave()
}

export function createNewPlatform(): UpstreamPlatform {
  return {
    id: generateId(), name: '', type: 'openai', upstreamProtocol: 'openai-chat', baseUrl: 'https://api.openai.com',
    models: [], modelAliases: [], keys: [], strategy: 'round-robin', enabled: true, customHeaders: {},
    createdAt: Date.now(), updatedAt: Date.now()
  }
}

/** 小范围别名保存：只合并指定平台/模型的别名，不覆盖整个平台草稿或其他 Key 状态。 */
export function saveModelAliases(update: ModelAliasUpdate): UpstreamPlatform {
  if (!update || typeof update !== 'object') throw new Error('别名配置无效')
  validateId(update.platformId)
  if (typeof update.model !== 'string' || !update.model.trim()) throw new Error('真实模型名称不能为空')
  const data = loadData()
  const platform = data.platforms.find((item) => item.id === update.platformId)
  if (!platform) throw new Error('平台不存在')
  const current = platform.modelAliases.find((entry) => entry.model === update.model)
  if (update.expectedAliases && JSON.stringify(current?.aliases || []) !== JSON.stringify(update.expectedAliases)) {
    throw new Error('该模型的别名已被其他操作修改，请刷新后重试')
  }
  if (update.expectedShowOriginal !== undefined && (current?.showOriginal ?? true) !== update.expectedShowOriginal) {
    throw new Error('该模型的显示原名设置已被其他操作修改，请刷新后重试')
  }
  const aliases = (Array.isArray(update.aliases) ? update.aliases : []).map((alias) => String(alias).trim()).filter(Boolean)
  const showOriginal = update.showOriginal !== false
  const next = aliases.length || !showOriginal
    ? { model: update.model, aliases, showOriginal }
    : null
  const modelAliases = next
    ? current ? platform.modelAliases.map((entry) => entry.model === update.model ? next : entry) : [...platform.modelAliases, next]
    : platform.modelAliases.filter((entry) => entry.model !== update.model)
  return savePlatform({ ...platform, modelAliases, updatedAt: Date.now() }, platform)
}

export function createNewKey(keyValue: string, label = ''): UpstreamKey {
  return validateKey({ id: generateId(), key: keyValue, label: label || `Key-${Date.now().toString(36)}` })
}
