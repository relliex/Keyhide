import type { IpcApi, ProxyConfig, UpstreamKey, UpstreamPlatform } from '../../electron/shared/types'

interface ExtraApi {
  createPlatform: () => Promise<UpstreamPlatform>
  createKey: (keyValue: string, label: string) => Promise<UpstreamKey>
  regenerateMaskedKey: () => Promise<ProxyConfig>
  clipboardWrite: (text: string) => Promise<void>
  saveFileDialog: (defaultName: string, content: string) => Promise<{ success: boolean; path?: string }>
  openFileDialog: () => Promise<{ success: boolean; content?: string }>
}

declare global {
  interface Window {
    api: IpcApi
    extraApi: ExtraApi
  }
}

export {}
