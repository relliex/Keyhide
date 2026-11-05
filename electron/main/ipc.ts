import { ipcMain, dialog, clipboard } from 'electron'
import { randomBytes } from 'crypto'
import { readFileSync, statSync } from 'fs'
import {
  getData,
  savePlatform,
  deletePlatform,
  saveModelAliases,
  saveProxyConfig,
  saveSettings,
  clearLogs,
  createNewPlatform,
  createNewKey,
  loadData,
  resetStats,
  clearAllData,
  importConfig
} from './database'
import { startProxy, stopProxy, isProxyRunning, fetchUpstreamModels, testConnection, previewProxyRoute } from './proxy-server'
import { clearRoutingState, keyRetryAt } from './upstream/manager'
import { atomicWriteFile } from './persistence'
import type { UpstreamPlatform, ProxyConfig, AppSettings, ModelAliasUpdate, LogProtocol } from '../shared/types'

/** 生成随机 API Key */
function generateMaskedKey(): string {
  return 'sk-keyhide-' + randomBytes(16).toString('hex')
}

const MAX_CONFIG_BYTES = 10 * 1024 * 1024
const rendererSnapshots = new Map<number, Map<string, UpstreamPlatform>>()

export function registerIpc(): void {
  // Keep the last delivered view so stale configuration edits do not undo runtime key status.
  ipcMain.handle('get-data', async (event) => {
    const data = getData()
    for (const platform of data.platforms) {
      for (const key of platform.keys) key.retryAt = keyRetryAt(platform, key)
    }
    if (!rendererSnapshots.has(event.sender.id)) {
      event.sender.once('destroyed', () => rendererSnapshots.delete(event.sender.id))
    }
    rendererSnapshots.set(event.sender.id, new Map(data.platforms.map((platform) => [platform.id, structuredClone(platform)])))
    return data
  })

  ipcMain.handle('save-platform', async (event, platform: UpstreamPlatform, original?: UpstreamPlatform) => {
    const snapshot = original || rendererSnapshots.get(event.sender.id)?.get(platform?.id)
    const saved = savePlatform(platform, snapshot)
    rendererSnapshots.get(event.sender.id)?.set(saved.id, structuredClone(saved))
    return saved
  })

  // 别名单独保存，避免旧平台草稿覆盖其他编辑或运行中的 Key 状态。
  ipcMain.handle('save-model-aliases', async (event, update: ModelAliasUpdate) => {
    const saved = saveModelAliases(update)
    rendererSnapshots.get(event.sender.id)?.set(saved.id, structuredClone(saved))
    return saved
  })

  // 删除平台
  ipcMain.handle('delete-platform', async (_, id: string) => {
    deletePlatform(id)
    clearRoutingState()
    for (const snapshot of rendererSnapshots.values()) snapshot.delete(id)
  })

  // 保存代理配置
  ipcMain.handle('save-proxy-config', async (_, config: Partial<ProxyConfig>) => {
    return saveProxyConfig(config)
  })

  // 保存设置
  ipcMain.handle('save-settings', async (_, settings: Partial<AppSettings>) => {
    const saved = saveSettings(settings)
    // 切换 Key 故障策略时清除已有冷却，让新策略立即生效。
    if (settings && typeof settings === 'object' && settings.keyErrorPolicy !== undefined) clearRoutingState()
    return saved
  })

  // 清空日志
  ipcMain.handle('clear-logs', async () => {
    clearLogs()
  })

  // 重置统计数据（清除日志 + 重置Key使用计数）
  ipcMain.handle('reset-stats', async () => {
    resetStats()
    clearRoutingState()
  })

  // 清除配置前先停止实际监听，避免界面与运行中的服务不一致。
  ipcMain.handle('clear-all-data', async () => {
    if (isProxyRunning()) {
      const stopped = await stopProxy()
      if (!stopped.success) throw new Error(stopped.message)
    }
    clearAllData()
    clearRoutingState()
    rendererSnapshots.clear()
  })

  // 启动代理
  ipcMain.handle('start-proxy', async () => {
    return startProxy()
  })

  // 停止代理
  ipcMain.handle('stop-proxy', async () => {
    return stopProxy()
  })

  // 获取代理状态
  ipcMain.handle('proxy-status', async () => {
    return isProxyRunning()
  })

  // 与真实请求共用路由规则，仅预览，不改变轮询位置或 Key 统计。
  ipcMain.handle('preview-route', async (_, input: { model: string; path: string; format?: LogProtocol }) => {
    return previewProxyRoute(input)
  })

  // 获取上游模型
  ipcMain.handle('fetch-models', async (_, platformId: string) => {
    return fetchUpstreamModels(platformId)
  })

  // 测试连接
  ipcMain.handle('test-connection', async (_, platformId: string) => {
    return testConnection(platformId)
  })

  // 创建新平台
  ipcMain.handle('create-platform', async () => {
    return createNewPlatform()
  })

  // 创建新 Key
  ipcMain.handle('create-key', async (_, keyValue: string, label: string) => {
    return createNewKey(keyValue, label)
  })

  // 重新生成伪装 API Key
  ipcMain.handle('regenerate-masked-key', async () => {
    const newKey = generateMaskedKey()
    return saveProxyConfig({ maskedApiKey: newKey })
  })

  // 导出配置
  ipcMain.handle('export-config', async () => {
    const data = loadData()
    // 导出时清除日志
    const exportData = { ...data, logs: [] }
    return JSON.stringify(exportData, null, 2)
  })

  // 导入配置
  ipcMain.handle('import-config', async (_, dataStr: string) => {
    try {
      if (typeof dataStr !== 'string' || Buffer.byteLength(dataStr, 'utf8') > MAX_CONFIG_BYTES) throw new Error('配置文件必须是字符串，且不能超过 10MB')
      importConfig(JSON.parse(dataStr))
      clearRoutingState()
      rendererSnapshots.clear()
      return { success: true, message: '配置导入成功' }
    } catch (err: any) {
      return { success: false, message: `导入失败: ${err.message}` }
    }
  })

  // 复制到剪贴板
  ipcMain.handle('clipboard-write', async (_, text: string) => {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) throw new Error('剪贴板内容无效或超过 10MB')
    clipboard.writeText(text)
  })

  // 选择文件保存
  ipcMain.handle('save-file-dialog', async (_, defaultName: string, content: string) => {
    if (typeof defaultName !== 'string' || typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) throw new Error('文件内容无效或超过 10MB')
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (!result.canceled && result.filePath) {
      atomicWriteFile(result.filePath, content)
      return { success: true, path: result.filePath }
    }
    return { success: false, path: '' }
  })

  // 选择文件打开
  ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (!result.canceled && result.filePaths.length > 0) {
      if (statSync(result.filePaths[0]).size > MAX_CONFIG_BYTES) throw new Error('配置文件不能超过 10MB')
      const content = readFileSync(result.filePaths[0], 'utf-8')
      return { success: true, content }
    }
    return { success: false, content: '' }
  })
}
