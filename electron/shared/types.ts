// 共享类型定义 - 主进程与渲染进程共用

/** 上游平台类型（认证方式/自定义兼容用途） */
export type PlatformType = 'openai' | 'anthropic' | 'custom'

/** 四种生成接口协议 */
export const API_PROTOCOLS = ['anthropic', 'openai-chat', 'openai-responses', 'gemini'] as const
export type ApiProtocol = typeof API_PROTOCOLS[number]

/** 日志兼容 1.0.1 中记录的 'openai' 值 */
export type LogProtocol = ApiProtocol | 'openai'

/** Key 状态 */
export type KeyStatus = 'active' | 'exhausted' | 'error' | 'disabled'

/** 负载均衡策略 */
export type LoadBalanceStrategy = 'round-robin' | 'weighted' | 'priority' | 'random'

/** 上游 API Key 配置 */
export interface UpstreamKey {
  id: string
  key: string
  label: string
  status: KeyStatus
  retryAt?: number
  /** 请求次数统计 */
  requestCount: number
  /** 最后使用时间 */
  lastUsedAt: number | null
  /** 最后错误信息 */
  lastError: string | null
  /** 错误次数（连续） */
  errorStreak: number
  /** 权重（加权轮询用） */
  weight: number
  /** 优先级（数字越小优先级越高） */
  priority: number
  /** 额度上限（0表示不限） */
  quotaLimit: number
  /** 已用额度估算 */
  quotaUsed: number
  /** 创建时间 */
  createdAt: number
}

/** 单个真实模型的公开别名配置 */
export interface ModelAlias {
  /** 上游真实模型名称 */
  model: string
  /** 对外公开的名称（可多个） */
  aliases: string[]
  /** 下游目录是否同时保留真实模型名称 */
  showOriginal: boolean
}

/** 上游平台配置 */
export interface UpstreamPlatform {
  id: string
  name: string
  type: PlatformType
  /** 上游实际支持的生成接口协议 */
  upstreamProtocol: ApiProtocol
  /** 上游 baseURL，如 https://api.openai.com */
  baseUrl: string
  /** 该平台支持的模型列表 */
  models: string[]
  /** 模型别名配置 */
  modelAliases: ModelAlias[]
  /** API Key 列表 */
  keys: UpstreamKey[]
  /** 负载均衡策略 */
  strategy: LoadBalanceStrategy
  /** 是否启用 */
  enabled: boolean
  /** 自定义请求头 */
  customHeaders: Record<string, string>
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

/** 伪装服务配置 */
export interface ProxyConfig {
  /** 监听端口 */
  port: number
  /** 监听地址 */
  host: string
  /** 伪装的 API Key */
  maskedApiKey: string
  /** 服务是否运行中 */
  running: boolean
  /** 是否允许跨域 */
  cors: boolean
  /** 请求超时（毫秒） */
  timeout: number
  /** 是否记录请求日志 */
  logRequests: boolean
  /** 日志最大条数 */
  maxLogs: number
}

/** 请求日志条目 */
export interface RequestLog {
  id: string
  timestamp: number
  method: string
  path: string
  /** 下游请求协议；旧日志可能是 'openai' 或 'anthropic' */
  format: LogProtocol
  /** 下游请求的模型（别名启用时为请求名称） */
  model: string
  /** 实际转发给上游的真实模型；旧日志为空 */
  resolvedModel?: string
  /** 上游实际协议；旧日志为空 */
  upstreamProtocol?: ApiProtocol
  /** 命中的上游平台ID */
  platformId: string
  /** 命中的上游平台名称 */
  platformName: string
  /** 使用的 Key 标签 */
  keyLabel: string
  /** 状态码 */
  statusCode: number
  /** 耗时（毫秒） */
  duration: number
  /** 请求 token 数 */
  promptTokens: number
  /** 响应 token 数 */
  completionTokens: number
  /** 是否流式 */
  stream: boolean
  /** 错误信息 */
  error: string | null
  /** 客户端 IP */
  clientIp: string
}

/** 路由模式 */
export type RouteMode = 'auto' | 'by-path' | 'by-model'

/** Key 出错后的处理策略 */
export type KeyErrorPolicy = 'cooldown' | 'ignore' | 'disable'

/** 全局设置 */
export interface AppSettings {
  /** 路由模式 */
  routeMode: RouteMode
  /** 默认平台ID（auto模式下优先） */
  defaultPlatformId: string | null
  /** 是否启用模型别名目录与请求改名 */
  enableModelAliases: boolean
  /** Key 出错后的处理方式 */
  keyErrorPolicy: KeyErrorPolicy
  /** 是否在启动时自动开启代理服务 */
  autoStartProxy: boolean
  /** 是否最小化到托盘 */
  minimizeToTray: boolean
  /** 主题 */
  theme: 'dark'
}

/** 应用完整数据 */
export interface AppData {
  platforms: UpstreamPlatform[]
  proxy: ProxyConfig
  settings: AppSettings
  logs: RequestLog[]
}

/** 路由预览结果 */
export interface RoutePreview {
  platformId: string | null
  platformName: string | null
  reason: string
  error?: string
  requestedModel?: string
  resolvedModel?: string | null
  downstreamProtocol?: ApiProtocol
  upstreamProtocol?: ApiProtocol
  conversion?: 'native' | 'convert'
}

/** 模型别名保存请求 */
export interface ModelAliasUpdate {
  platformId: string
  model: string
  aliases: string[]
  showOriginal: boolean
  expectedAliases?: string[]
  expectedShowOriginal?: boolean
}

/** IPC 请求/响应类型 */
export interface IpcApi {
  // 数据操作
  getData: () => Promise<AppData>
  savePlatform: (platform: UpstreamPlatform, original?: UpstreamPlatform) => Promise<UpstreamPlatform>
  deletePlatform: (id: string) => Promise<void>
  saveModelAliases: (update: ModelAliasUpdate) => Promise<UpstreamPlatform>
  saveProxyConfig: (config: Partial<ProxyConfig>) => Promise<ProxyConfig>
  saveSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>
  clearLogs: () => Promise<void>
  resetStats: () => Promise<void>
  clearAllData: () => Promise<void>
  // 服务控制
  startProxy: () => Promise<{ success: boolean; message: string }>
  stopProxy: () => Promise<{ success: boolean; message: string }>
  // 模型获取
  fetchModels: (platformId: string) => Promise<string[]>
  // 测试连接
  testConnection: (platformId: string) => Promise<{ success: boolean; message: string }>
  // 导入导出
  exportConfig: () => Promise<string>
  importConfig: (data: string) => Promise<{ success: boolean; message: string }>
  previewRoute: (input: { model: string; path: string; format?: LogProtocol }) => Promise<RoutePreview>
  // 事件
  onLogAdded: (callback: (log: RequestLog) => void) => () => void
  onProxyStatusChanged: (callback: (running: boolean) => void) => () => void
  onToast: (callback: (toast: ToastMessage) => void) => () => void
  onDataChanged: (callback: () => void) => () => void
}

export interface ToastMessage {
  type: 'success' | 'error' | 'warning' | 'info'
  message: string
}
