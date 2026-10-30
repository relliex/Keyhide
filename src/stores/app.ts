import { create } from 'zustand'
import type { AppData, UpstreamPlatform, ProxyConfig, AppSettings, RequestLog, ToastMessage } from '../../electron/shared/types'
import { errorMessage } from '../lib/utils'

type ToastEntry = ToastMessage & { id: string }

interface AppState {
  data: AppData | null
  loading: boolean
  refreshing: boolean
  error: string | null
  proxyRunning: boolean
  proxyBusy: boolean
  toasts: ToastEntry[]
  loadData: () => Promise<void>
  savePlatform: (platform: UpstreamPlatform, original?: UpstreamPlatform) => Promise<void>
  deletePlatform: (id: string) => Promise<void>
  saveProxyConfig: (config: Partial<ProxyConfig>) => Promise<void>
  saveSettings: (settings: Partial<AppSettings>) => Promise<void>
  clearLogs: () => Promise<void>
  resetStats: () => Promise<void>
  clearAllData: () => Promise<void>
  startProxy: () => Promise<{ success: boolean; message: string }>
  stopProxy: () => Promise<{ success: boolean; message: string }>
  addLog: (log: RequestLog) => void
  setProxyRunning: (running: boolean) => void
  showToast: (toast: ToastMessage) => void
  removeToast: (id: string) => void
}

let dataRequest = 0
let mutationQueue: Promise<unknown> = Promise.resolve()
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>()

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation)
  mutationQueue = result.catch(() => undefined)
  return result
}

export const useAppStore = create<AppState>((set, get) => {
  let eligibilityTimer: ReturnType<typeof setTimeout> | undefined
  const refresh = async () => {
    const request = ++dataRequest
    const data = await window.api.getData()
    if (request === dataRequest) {
      clearTimeout(eligibilityTimer)
      set({ data, proxyRunning: data.proxy.running, error: null })
      const retryTimes = data.platforms.flatMap((platform) => platform.keys.map((key) => key.retryAt)).filter((time): time is number => time !== undefined && time > Date.now())
      if (retryTimes.length) eligibilityTimer = setTimeout(() => void get().loadData(), Math.max(1, Math.min(...retryTimes) - Date.now() + 20))
    }
  }
  const mutate = (operation: () => Promise<unknown>) => enqueue(async () => {
    await operation()
    await refresh()
  })
  const controlProxy = async (start: boolean) => {
    if (get().proxyBusy) return { success: false, message: '服务正在切换状态，请稍候' }
    set({ proxyBusy: true })
    try {
      const result = await (start ? window.api.startProxy() : window.api.stopProxy())
      if (result.success) {
        set({ proxyRunning: start })
        await refresh()
      }
      get().showToast({ type: result.success ? 'success' : 'error', message: result.message })
      return result
    } catch (error) {
      const result = { success: false, message: errorMessage(error) }
      get().showToast({ type: 'error', message: result.message })
      return result
    } finally {
      set({ proxyBusy: false })
    }
  }

  return {
    data: null,
    loading: true,
    refreshing: false,
    error: null,
    proxyRunning: false,
    proxyBusy: false,
    toasts: [],
    loadData: async () => {
      const initial = !get().data
      set({ loading: initial, refreshing: !initial })
      try {
        await refresh()
      } catch (error) {
        set({ error: errorMessage(error) })
      } finally {
        set({ loading: false, refreshing: false })
      }
    },
    savePlatform: (platform, original) => mutate(() => window.api.savePlatform(platform, original)),
    deletePlatform: (id) => mutate(() => window.api.deletePlatform(id)),
    saveProxyConfig: (config) => mutate(() => window.api.saveProxyConfig(config)),
    saveSettings: (settings) => mutate(() => window.api.saveSettings(settings)),
    clearLogs: () => mutate(() => window.api.clearLogs()),
    resetStats: () => mutate(() => window.api.resetStats()),
    clearAllData: () => mutate(() => window.api.clearAllData()),
    startProxy: () => controlProxy(true),
    stopProxy: () => controlProxy(false),
    addLog: (log) => set((state) => state.data ? {
      data: { ...state.data, logs: [log, ...state.data.logs.filter((entry) => entry.id !== log.id)].slice(0, state.data.proxy.maxLogs) }
    } : {}),
    setProxyRunning: (running) => set((state) => ({
      proxyRunning: running,
      data: state.data ? { ...state.data, proxy: { ...state.data.proxy, running } } : null
    })),
    showToast: (toast) => {
      const id = crypto.randomUUID()
      set((state) => ({ toasts: [...state.toasts.slice(-3), { ...toast, id }] }))
      toastTimers.set(id, setTimeout(() => get().removeToast(id), toast.type === 'error' ? 7000 : 4000))
    },
    removeToast: (id) => {
      clearTimeout(toastTimers.get(id))
      toastTimers.delete(id)
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
    }
  }
})
