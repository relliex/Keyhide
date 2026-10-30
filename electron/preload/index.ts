import { contextBridge, ipcRenderer } from 'electron'
import type { IpcApi, RequestLog, ToastMessage } from '../shared/types'

const api: IpcApi = {
  getData: () => ipcRenderer.invoke('get-data'),
  savePlatform: (platform, original) => ipcRenderer.invoke('save-platform', platform, original),
  deletePlatform: (id) => ipcRenderer.invoke('delete-platform', id),
  saveProxyConfig: (config) => ipcRenderer.invoke('save-proxy-config', config),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
  resetStats: () => ipcRenderer.invoke('reset-stats'),
  clearAllData: () => ipcRenderer.invoke('clear-all-data'),
  startProxy: () => ipcRenderer.invoke('start-proxy'),
  stopProxy: () => ipcRenderer.invoke('stop-proxy'),
  fetchModels: (platformId) => ipcRenderer.invoke('fetch-models', platformId),
  testConnection: (platformId) => ipcRenderer.invoke('test-connection', platformId),
  exportConfig: () => ipcRenderer.invoke('export-config'),
  importConfig: (data) => ipcRenderer.invoke('import-config', data),
  previewRoute: (input) => ipcRenderer.invoke('preview-route', input),
  onDataChanged: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('data-changed', handler)
    return () => ipcRenderer.removeListener('data-changed', handler)
  },
  onLogAdded: (callback: (log: RequestLog) => void) => {
    const handler = (_: unknown, log: RequestLog) => callback(log)
    ipcRenderer.on('log-added', handler)
    return () => ipcRenderer.removeListener('log-added', handler)
  },
  onProxyStatusChanged: (callback: (running: boolean) => void) => {
    const handler = (_: unknown, running: boolean) => callback(running)
    ipcRenderer.on('proxy-status-changed', handler)
    return () => ipcRenderer.removeListener('proxy-status-changed', handler)
  },
  onToast: (callback: (toast: ToastMessage) => void) => {
    const handler = (_: unknown, toast: ToastMessage) => callback(toast)
    ipcRenderer.on('toast', handler)
    return () => ipcRenderer.removeListener('toast', handler)
  }
}

// 额外的辅助 API
const extraApi = {
  createPlatform: () => ipcRenderer.invoke('create-platform'),
  createKey: (keyValue: string, label: string) => ipcRenderer.invoke('create-key', keyValue, label),
  regenerateMaskedKey: () => ipcRenderer.invoke('regenerate-masked-key'),
  clipboardWrite: (text: string) => ipcRenderer.invoke('clipboard-write', text),
  saveFileDialog: (defaultName: string, content: string) =>
    ipcRenderer.invoke('save-file-dialog', defaultName, content),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog')
}

contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('extraApi', extraApi)
