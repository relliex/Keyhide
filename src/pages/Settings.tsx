import { UnsavedChangesGuard } from '../components/UnsavedChangesGuard'
import { useState, type FormEvent } from 'react'
import { useAppStore } from '../stores/app'
import { Card, Button, Input, Select, Toggle, Badge, Modal, EmptyState, PageHeader, SettingRow } from '../components/ui'
import {
  Settings as SettingsIcon, Download, Upload, Route, Shield, Zap, Info,
  Trash2, RotateCcw, AlertTriangle, CheckCircle2, Loader2, Save
} from 'lucide-react'
import type { AppSettings, RouteMode, ApiProtocol, KeyErrorPolicy } from '../../electron/shared/types'
import { PROTOCOL_OPTIONS, protocolLabel } from '../../electron/shared/protocols'
import { APP_VERSION } from '../../electron/shared/version'
import { errorMessage } from '../lib/utils'

type RoutingDraft = Pick<AppSettings, 'routeMode' | 'defaultPlatformId'>
type ToggleSetting = 'autoStartProxy' | 'minimizeToTray' | 'enableModelAliases'
type BusyAction = 'routing' | ToggleSetting | 'keyErrorPolicy' | 'readImport' | 'import' | 'export' | 'reset' | 'clear' | null
type RoutePreview = { platformId: string | null; platformName: string | null; reason: string; error?: string; requestedModel?: string; resolvedModel?: string | null; downstreamProtocol?: ApiProtocol; upstreamProtocol?: ApiProtocol; conversion?: 'native' | 'convert' }
type ImportPreview = {
  content: string
  platformCount: number
  keyCount: number
  hasPlatforms: boolean
  hasProxy: boolean
  hasSettings: boolean
}

const routeDescriptions: Record<RouteMode, string> = {
  'by-path': '不按模型切换平台。未指定平台前缀的请求使用默认平台，因此必须选择启用的默认平台。',
  'auto': '根据模型寻找可用平台，支持该模型的默认平台优先。没有匹配的平台或可用 Key 时返回错误。',
  'by-model': '仅匹配平台明确声明的模型名称，不以默认平台兜底。空模型列表不参与模型匹配。'
}
const routeLabels: Record<RouteMode, string> = { 'by-path': '按路径', 'auto': '自动匹配', 'by-model': '严格按模型' }
const toggleLabels: Record<ToggleSetting, string> = {
  autoStartProxy: '自动启动代理服务', minimizeToTray: '关闭窗口后留在托盘', enableModelAliases: '启用模型别名'
}
const keyErrorPolicyLabels: Record<KeyErrorPolicy, string> = {
  cooldown: '暂时冷却', ignore: '完全忽略错误', disable: '出错即禁用 Key'
}
const keyErrorPolicyOptions: { value: KeyErrorPolicy; label: string }[] = [
  { value: 'cooldown', label: '暂时冷却（冷却后自动重试）' },
  { value: 'ignore', label: '完全忽略错误（不冷却、不禁用）' },
  { value: 'disable', label: '出错即禁用 Key（手动恢复）' }
]
const previewPaths: Record<ApiProtocol, string> = {
  'openai-chat': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
  anthropic: '/v1/messages',
  gemini: '/v1beta/models/example-model:generateContent'
}

export function Settings() {
  const data = useAppStore((s) => s.data)
  const loading = useAppStore((s) => s.loading)
  const proxyRunning = useAppStore((s) => s.proxyRunning)
  const proxyBusy = useAppStore((s) => s.proxyBusy)
  const error = useAppStore((s) => s.error)
  const loadData = useAppStore((s) => s.loadData)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const showToast = useAppStore((s) => s.showToast)
  const resetStats = useAppStore((s) => s.resetStats)
  const clearAllData = useAppStore((s) => s.clearAllData)

  const [routingDraft, setRoutingDraft] = useState<RoutingDraft | null>(null)
  const [routingError, setRoutingError] = useState('')
  const [busyAction, setBusyAction] = useState<BusyAction>(null)
  const [actionError, setActionError] = useState('')
  const [previewModel, setPreviewModel] = useState('')
  const [previewPath, setPreviewPath] = useState('/v1/chat/completions')
  const [previewFormat, setPreviewFormat] = useState<ApiProtocol>('openai-chat')
  const [previewResult, setPreviewResult] = useState<RoutePreview | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [importError, setImportError] = useState('')
  const [exportOpen, setExportOpen] = useState(false)
  const [exportError, setExportError] = useState('')
  const [resetOpen, setResetOpen] = useState(false)
  const [resetError, setResetError] = useState('')
  const [clearOpen, setClearOpen] = useState(false)
  const [clearError, setClearError] = useState('')

  const savedRouting: RoutingDraft = {
    routeMode: data?.settings.routeMode ?? 'by-path', defaultPlatformId: data?.settings.defaultPlatformId ?? null
  }
  const routing = routingDraft ?? savedRouting
  const routingDirty = routing.routeMode !== savedRouting.routeMode || routing.defaultPlatformId !== savedRouting.defaultPlatformId
  const selectedDefault = data?.platforms.find((platform) => platform.id === routing.defaultPlatformId)
  const busy = busyAction !== null

  function updateRouting(patch: Partial<RoutingDraft>) {
    setRoutingDraft({ ...routing, ...patch })
    setRoutingError('')
  }

  async function handleReload() {
    try {
      await loadData()
      setActionError('')
    } catch (err) {
      showToast({ type: 'error', message: `读取配置失败：${errorMessage(err)}` })
    }
  }

  async function handleSaveRouting(event: FormEvent) {
    event.preventDefault()
    if (!data || busy || !routingDirty) return
    if (routing.routeMode === 'by-path' && (!selectedDefault || !selectedDefault.enabled)) {
      setRoutingError('按路径模式必须选择启用的默认平台。请先在「上游平台」启用平台，再保存路由。')
      return
    }
    if (routing.defaultPlatformId && !selectedDefault) {
      setRoutingError('所选默认平台已不存在，请重新选择。')
      return
    }
    setBusyAction('routing')
    setRoutingError('')
    try {
      await saveSettings(routing)
      setRoutingDraft(null)
      setPreviewResult(null)
      showToast({ type: 'success', message: '路由设置已保存，新请求将使用此设置' })
    } catch (err) {
      const message = errorMessage(err)
      setRoutingError(message)
      showToast({ type: 'error', message: `保存路由失败：${message}` })
    } finally {
      setBusyAction(null)
    }
  }

  async function handleToggle(setting: ToggleSetting, checked: boolean) {
    if (busy) return
    setBusyAction(setting)
    setActionError('')
    try {
      await saveSettings({ [setting]: checked })
      showToast({ type: 'success', message: `${toggleLabels[setting]}已${checked ? '开启' : '关闭'}` })
    } catch (err) {
      const message = `${toggleLabels[setting]}保存失败：${errorMessage(err)}`
      setActionError(message)
      showToast({ type: 'error', message })
    } finally {
      setBusyAction(null)
    }
  }

  async function handleKeyErrorPolicy(policy: KeyErrorPolicy) {
    if (busy || !data) return
    setBusyAction('keyErrorPolicy')
    setActionError('')
    try {
      await saveSettings({ keyErrorPolicy: policy })
      showToast({ type: 'success', message: `Key 故障处理已切换为「${keyErrorPolicyLabels[policy]}」` })
    } catch (err) {
      const message = `Key 故障处理保存失败：${errorMessage(err)}`
      setActionError(message)
      showToast({ type: 'error', message })
    } finally {
      setBusyAction(null)
    }
  }

  async function handlePreview(event: FormEvent) {
    event.preventDefault()
    if (previewing || busy) return
    const path = previewPath.trim()
    if (!path.startsWith('/')) {
      setPreviewError('请输入以 / 开头的请求路径，不要填写完整的上游网址。')
      setPreviewResult(null)
      return
    }
    setPreviewing(true)
    setPreviewError('')
    setPreviewResult(null)
    try {
      const result = await window.api.previewRoute({ model: previewModel.trim(), path, format: previewFormat })
      setPreviewResult(result)
    } catch (err) {
      setPreviewError(`路由预览失败：${errorMessage(err)}`)
    } finally {
      setPreviewing(false)
    }
  }

  function clearPreview() {
    setPreviewResult(null)
    setPreviewError('')
  }

  async function handleReadImport() {
    if (busy) return
    setBusyAction('readImport')
    setActionError('')
    setImportError('')
    try {
      const result = await window.extraApi.openFileDialog()
      if (!result.success) return
      if (typeof result.content !== 'string' || !result.content.trim()) throw new Error('所选配置文件为空或无法读取。')
      setImportPreview(summarizeImport(result.content))
    } catch (err) {
      const message = `无法预览配置文件：${errorMessage(err)}`
      setActionError(message)
      showToast({ type: 'error', message })
    } finally {
      setBusyAction(null)
    }
  }

  async function handleImport() {
    if (!importPreview || busy) return
    setBusyAction('import')
    setImportError('')
    try {
      const result = await window.api.importConfig(importPreview.content)
      if (!result.success) throw new Error(result.message)
      setImportPreview(null)
      setRoutingDraft(null)
      setRoutingError('')
      setPreviewResult(null)
      showToast({ type: 'success', message: result.message || '配置已导入' })
      try {
        await loadData()
      } catch (err) {
        const message = `配置已导入，但界面刷新失败：${errorMessage(err)}。请重新读取本机数据。`
        setActionError(message)
        showToast({ type: 'error', message })
      }
    } catch (err) {
      const message = errorMessage(err)
      setImportError(message)
      showToast({ type: 'error', message: `导入配置失败：${message}` })
    } finally {
      setBusyAction(null)
    }
  }

  async function handleExport() {
    if (busy) return
    setBusyAction('export')
    setExportError('')
    try {
      const config = await window.api.exportConfig()
      const result = await window.extraApi.saveFileDialog('keyhide-config.json', config)
      setExportOpen(false)
      showToast(result.success
        ? { type: 'success', message: `配置已导出：${result.path}` }
        : { type: 'info', message: '已取消配置导出' })
    } catch (err) {
      const message = errorMessage(err)
      setExportError(message)
      showToast({ type: 'error', message: `导出配置失败：${message}` })
    } finally {
      setBusyAction(null)
    }
  }

  async function handleResetStats() {
    if (busy) return
    setBusyAction('reset')
    setResetError('')
    try {
      await resetStats()
      setResetOpen(false)
      setPreviewResult(null)
      showToast({ type: 'success', message: '日志与 Key 计数已重置，手动禁用的 Key 保持禁用' })
    } catch (err) {
      const message = errorMessage(err)
      setResetError(message)
      showToast({ type: 'error', message: `重置统计失败：${message}` })
    } finally {
      setBusyAction(null)
    }
  }

  async function handleClearAllData() {
    if (busy) return
    setBusyAction('clear')
    setClearError('')
    try {
      await clearAllData()
      setClearOpen(false)
      setRoutingDraft(null)
      setRoutingError('')
      setPreviewResult(null)
      showToast({ type: 'success', message: '所有配置与日志已清除，伪装 API Key 已保留' })
    } catch (err) {
      const message = errorMessage(err)
      setClearError(message)
      showToast({ type: 'error', message: `清除数据失败：${message}` })
    } finally {
      setBusyAction(null)
    }
  }

  function toggleControl(setting: ToggleSetting) {
    return <div className="flex shrink-0 items-center gap-3">
      {busyAction === setting && <Loader2 className="h-4 w-4 animate-spin text-text-secondary" role="status" aria-label="正在保存" />}
      <Toggle checked={Boolean(data?.settings[setting])} onChange={(checked) => handleToggle(setting, checked)} label={toggleLabels[setting]} disabled={busy} />
    </div>
  }

  if (!data) {
    return <div className="page-shell">
      <PageHeader title="设置与路由" description="决定请求发往哪里，管理仅保存在本机的配置。" />
      <Card>{loading ? <p role="status" className="py-8 text-sm text-text-secondary">正在读取本机设置…</p> :
        <EmptyState icon={<SettingsIcon className="h-8 w-8" />} title="无法读取设置" description={error || '本机数据尚未加载，请重试。'} action={<Button onClick={handleReload}>重新读取</Button>} />}</Card>
    </div>
  }

  const platformOptions = [
    { value: '', label: '不设置默认平台' },
    ...data.platforms.map((platform) => ({ value: platform.id, label: `${platform.name || '未命名平台'}${platform.enabled ? '' : '（已停用）'}`, disabled: !platform.enabled })),
    ...(routing.defaultPlatformId && !selectedDefault ? [{ value: routing.defaultPlatformId, label: '已删除的平台（请重新选择）' }] : [])
  ]

  return (
    <div className="page-shell">
      <UnsavedChangesGuard dirty={routingDirty} />
      <PageHeader title="设置与路由" description="路由更改需保存后生效；全局开关会立即保存到本机。" />

      {error && <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm">
        <p className="text-text-secondary">读取配置失败：{error}。当前显示上次读取的设置。</p>
        <Button variant="secondary" size="sm" onClick={handleReload} disabled={busy || loading}>重新读取</Button>
      </div>}
      {actionError && <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-text-secondary">
        <p className="min-w-0 flex-1 break-words">{actionError}</p>
        <Button variant="ghost" size="sm" onClick={() => setActionError('')}>关闭提示</Button>
      </div>}

      <div className="settings-grid mb-6">
        <Card>
          <div className="section-heading"><h2 className="flex items-center gap-2"><Route className="h-4 w-4 text-accent" />请求路由</h2></div>
          <form onSubmit={handleSaveRouting} className="space-y-4">
            <Select label="路由模式" value={routing.routeMode} onChange={(value) => updateRouting({ routeMode: value as RouteMode })} disabled={busy || previewing} options={[
              { value: 'by-path', label: '按路径（固定默认平台）' },
              { value: 'auto', label: '自动匹配（默认平台优先）' },
              { value: 'by-model', label: '严格按模型（无默认兜底）' }
            ]} />
            <p className="text-sm leading-relaxed text-text-secondary">{routeDescriptions[routing.routeMode]}</p>
            <Select label={routing.routeMode === 'by-path' ? '默认平台（必选）' : '默认平台'} value={routing.defaultPlatformId || ''} onChange={(value) => updateRouting({ defaultPlatformId: value || null })} options={platformOptions} disabled={busy || previewing} />
            {selectedDefault && <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
              <Badge variant={selectedDefault.enabled ? 'success' : 'warning'}>{selectedDefault.enabled ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}{selectedDefault.enabled ? '平台已启用' : '平台已停用'}</Badge>
              <span>{selectedDefault.keys.filter((key) => key.status === 'active').length} / {selectedDefault.keys.length} 个 Key 处于活跃状态</span>
            </div>}
            {routing.routeMode === 'by-path' && !selectedDefault && <p className="flex items-start gap-2 text-xs leading-relaxed text-text-secondary"><Info className="mt-0.5 h-4 w-4 shrink-0 text-warning" />先选择默认平台。未设置时，普通请求无法确定转发目标。</p>}
            {routing.routeMode === 'by-model' && <p className="text-xs leading-relaxed text-text-muted">严格按模型模式不使用默认平台兜底；此选项会保留，便于切换路由模式。</p>}
            <div className="rounded-lg border border-border bg-bg-tertiary p-3 text-xs leading-relaxed text-text-secondary">
              <p>请求也可通过平台前缀明确指定目标：</p>
              <code className="mt-1 block break-all font-mono text-text-primary">/{'{platformId}'}/v1/chat/completions</code>
              <p className="mt-2">明确指定的平台不可用时返回错误，不会悄悄改发到其他平台。</p>
            </div>
            {routingError && <p role="alert" className="break-words text-sm text-danger">{routingError}</p>}
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <Button type="submit" loading={busyAction === 'routing'} disabled={busy || previewing || !routingDirty}><Save className="h-4 w-4" />保存更改</Button>
              <Button type="button" variant="ghost" disabled={busy || !routingDirty} onClick={() => { setRoutingDraft(null); setRoutingError('') }}>放弃更改</Button>
              <span className="text-xs text-text-muted" role="status">{routingDirty ? '有未保存的路由更改' : '路由设置已同步'}</span>
            </div>
          </form>
        </Card>

        <Card>
          <div className="section-heading"><h2 className="flex items-center gap-2"><Route className="h-4 w-4 text-accent" />路由预览</h2></div>
          <p className="mb-4 text-sm leading-relaxed text-text-secondary">只在点击后计算路由，不发送请求、不调用上游，也不消耗 Key 额度。</p>
          <p className="mb-4 text-xs text-text-muted">使用已保存的「{routeLabels[savedRouting.routeMode]}」设置。{routingDirty ? '左侧更改尚未保存，不会用于此预览。' : '预览只说明路由选择，不代表上游连接正常。'}</p>
          <form onSubmit={handlePreview} className="space-y-4">
            <Input label="模型名" placeholder="填写请求中的 model，路径请求可留空" value={previewModel} onChange={(event) => { setPreviewModel(event.target.value); clearPreview() }} disabled={previewing || busy} />
            <Input label="请求路径" value={previewPath} placeholder="/v1/chat/completions" onChange={(event) => { setPreviewPath(event.target.value); clearPreview() }} disabled={previewing || busy} required hint="使用客户端发送到 Keyhide 的路径，可包含平台前缀。" />
            <Select label="请求格式" value={previewFormat} onChange={(value) => {
              const next = value as ApiProtocol
              setPreviewFormat(next)
              if (Object.values(previewPaths).includes(previewPath)) setPreviewPath(previewPaths[next])
              clearPreview()
            }} disabled={previewing || busy} options={PROTOCOL_OPTIONS} />
            <Button type="submit" variant="secondary" loading={previewing} disabled={busy}><Route className="h-4 w-4" />预览路由</Button>
          </form>
          {previewError && <p role="alert" className="mt-4 break-words text-sm text-danger">{previewError}</p>}
          {previewResult && <div className={`mt-4 rounded-lg border p-4 ${previewResult.error || !previewResult.platformId ? 'border-warning/40 bg-warning/5' : 'border-border bg-bg-tertiary'}`} role="status">
            <p className="flex items-center gap-2 text-sm font-medium text-text-primary">
              {previewResult.platformId && !previewResult.error ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> : <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />}
              {previewResult.platformId ? `目标平台：${previewResult.platformName || '未命名平台'}` : '没有可用的目标平台'}
            </p>
            {previewResult.platformId && <p className="mt-1 break-all font-mono text-xs text-text-muted">{previewResult.platformId}</p>}
            {previewResult.requestedModel && <p className="mt-2 break-words text-xs text-text-secondary">请求模型：<span className="font-mono">{previewResult.requestedModel}</span>{previewResult.resolvedModel && previewResult.resolvedModel !== previewResult.requestedModel ? <> → 实际路由 <span className="font-mono">{previewResult.resolvedModel}</span></> : null}</p>}
            {previewResult.downstreamProtocol && previewResult.upstreamProtocol && <p className="mt-1 break-words text-xs text-text-secondary">下游 {protocolLabel(previewResult.downstreamProtocol)} → 上游 {protocolLabel(previewResult.upstreamProtocol)}（{previewResult.conversion === 'convert' ? '自动转换' : '原生转发'}）</p>}
            <p className="mt-2 break-words text-sm leading-relaxed text-text-secondary">{previewResult.reason}</p>
            {previewResult.error && <p className="mt-2 break-words text-xs text-text-secondary">{previewResult.error}</p>}
          </div>}
        </Card>
      </div>

      <Card className="mb-6">
        <div className="section-heading"><h2 className="flex items-center gap-2"><Zap className="h-4 w-4 text-accent" />模型别名</h2></div>
        <div className="divide-y divide-border">
          <SettingRow title="启用模型别名" description="开启后可在「模型目录」按平台 + 真实模型配置多个公开名称，并选择是否继续公开原名。关闭时保留已保存的别名配置，但目录与请求都使用原始模型名。">
            {toggleControl('enableModelAliases')}
          </SettingRow>
        </div>
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-bg-tertiary p-3 text-xs leading-relaxed text-text-secondary">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <p>别名用于下游看到和调用的名称，请求会自动替换为真实模型。隐藏原名只是目录展示，不是访问控制；已知真实名称仍可直接请求。真实模型身份仍会保留在日志和供应商响应中。</p>
        </div>
      </Card>

      <Card className="mb-6">
        <div className="section-heading"><h2 className="flex items-center gap-2"><Zap className="h-4 w-4 text-accent" />启动与容错</h2></div>
        <div className="divide-y divide-border">
          <SettingRow title="自动启动代理服务" description="下次启动 Keyhide 时自动开启代理。不会改变本次服务运行状态。">{toggleControl('autoStartProxy')}</SettingRow>
          <SettingRow title="关闭窗口后留在托盘" description="关闭窗口时保留后台服务；可从系统托盘重新打开或退出 Keyhide。">{toggleControl('minimizeToTray')}</SettingRow>
          <SettingRow title="Key 故障处理方式" description="决定 401、403、429、服务端和网络故障对 Key 的影响。请求参数类错误不会改变 Key 状态。">
            <div className="flex items-center gap-3">
              {busyAction === 'keyErrorPolicy' && <Loader2 className="h-4 w-4 animate-spin text-text-secondary" role="status" aria-label="正在保存" />}
              <Select aria-label="Key 故障处理方式" value={data.settings.keyErrorPolicy} onChange={(value) => void handleKeyErrorPolicy(value as KeyErrorPolicy)} disabled={busy} options={keyErrorPolicyOptions} className="w-64" />
            </div>
          </SettingRow>
        </div>
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-bg-tertiary p-3 text-xs leading-relaxed text-text-secondary">
          <Shield className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <div><p>{data.settings.keyErrorPolicy === 'cooldown' ? '当前策略：暂时冷却。401、403、429、服务端和网络故障只进入冷却，冷却结束后 agent 重试可自动恢复；明确额度耗尽也会进入较长冷却。' : data.settings.keyErrorPolicy === 'ignore' ? '当前策略：完全忽略错误。任何错误都不改变 Key 状态，也不进入冷却；Key 会持续参与路由。' : '当前策略：出错即禁用。401、403、429、服务端和网络故障都会禁用 Key，需要手动恢复。'}</p>
            <p className="mt-1">切换策略会清除现有冷却，让新策略立即生效；已经禁用的 Key 仍需在「上游平台」手动恢复。</p>
          </div>
        </div>
      </Card>

      <Card className="mb-6">
        <div className="section-heading"><h2 className="flex items-center gap-2"><Shield className="h-4 w-4 text-accent" />配置备份与恢复</h2></div>
        <div className="divide-y divide-border">
          <SettingRow title="导出配置" description="导出已保存的平台、真实 API Key、代理和全局设置；不导出请求日志。JSON 中的凭证是明文。">
            <Button variant="secondary" disabled={busy} onClick={() => { setExportError(''); setExportOpen(true) }}><Download className="h-4 w-4" />导出配置</Button>
          </SettingRow>
          <SettingRow title="导入配置" description="先选择 JSON 文件并预览平台、Key 数量，再确认覆盖。已有日志保持不变；未保存的路由更改会被放弃。">
            <Button variant="secondary" loading={busyAction === 'readImport'} disabled={busy} onClick={handleReadImport}><Upload className="h-4 w-4" />选择配置文件</Button>
          </SettingRow>
        </div>
      </Card>

      <Card className="mb-6">
        <div className="section-heading"><h2 className="flex items-center gap-2"><Trash2 className="h-4 w-4 text-danger" />数据管理</h2></div>
        <div className="divide-y divide-border">
          <SettingRow title="重置统计数据" description="清空日志与 Key 的计数、额度用量和错误记录。恢复耗尽 / 错误状态，手动禁用的 Key 保持禁用；不删除平台与密钥。">
            <Button variant="secondary" disabled={busy} onClick={() => { setResetError(''); setResetOpen(true) }}><RotateCcw className="h-4 w-4" />重置统计</Button>
          </SettingRow>
          <SettingRow title="清除所有数据" description="先在「代理服务」中停止代理。永久删除平台、真实 API Key、日志与自定义设置，仅保留当前伪装 API Key。">
            <Button variant="danger" disabled={busy || proxyRunning || proxyBusy} onClick={() => { setClearError(''); setClearOpen(true) }}><Trash2 className="h-4 w-4" />清除数据</Button>
          </SettingRow>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5 text-xs text-text-muted">
        <div className="flex items-center gap-2"><span className="font-semibold text-text-secondary">Keyhide</span><Badge>v{APP_VERSION}</Badge><span>本地 API 密钥保护与透明转发</span></div>
        <span>Anthropic / OpenAI Chat / OpenAI Responses / Gemini</span>
      </div>

      <Modal open={Boolean(importPreview)} onClose={() => { if (!busy) { setImportPreview(null); setImportError('') } }} title="预览并确认导入" width="640px" busy={busyAction === 'import'} footer={<>
        <Button variant="secondary" disabled={busy} onClick={() => { setImportPreview(null); setImportError('') }}>取消</Button>
        <Button variant="danger" loading={busyAction === 'import'} disabled={busy} onClick={handleImport}><Upload className="h-4 w-4" />确认覆盖并导入</Button>
      </>}>
        {importPreview && <div className="space-y-4">
          <p className="text-sm leading-relaxed text-text-secondary">只解析文件并统计内容，尚未写入任何配置。密钥内容不会在预览中显示。</p>
          <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-bg-tertiary p-4">
            <PreviewCount label="文件中的平台" value={importPreview.platformCount} hint={importPreview.hasPlatforms ? '将替换现有平台列表' : '文件未包含平台列表，保留现有平台'} />
            <PreviewCount label="文件中的 Key" value={importPreview.keyCount} hint={importPreview.hasPlatforms ? '随平台列表一同导入' : '不改变现有 Key'} />
            <PreviewCount label="当前平台" value={data.platforms.length} />
            <PreviewCount label="当前 Key" value={data.platforms.reduce((sum, platform) => sum + platform.keys.length, 0)} />
          </dl>
          <div className="flex flex-wrap gap-2"><Badge>{importPreview.hasProxy ? '包含代理设置' : '不包含代理设置'}</Badge><Badge>{importPreview.hasSettings ? '包含全局设置' : '不包含全局设置'}</Badge></div>
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm leading-relaxed text-text-secondary"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" /><p>导入会覆盖文件中包含的配置，无法自动撤销。已有日志不受影响。请确认来自受信任的本地备份，必要时先取消并导出当前配置。</p></div>
          {routingDirty && <p className="text-xs text-warning">当前尚未保存的路由更改将被放弃。</p>}
          {importError && <p role="alert" className="break-words text-sm text-danger">导入失败：{importError}。当前文件仍保留，可重试或取消。</p>}
        </div>}
      </Modal>

      <Modal open={exportOpen} onClose={() => { if (!busy) setExportOpen(false) }} title="导出包含明文密钥的配置？" busy={busyAction === 'export'} footer={<>
        <Button variant="secondary" disabled={busy} onClick={() => setExportOpen(false)}>取消</Button>
        <Button variant="primary" loading={busyAction === 'export'} disabled={busy} onClick={handleExport}><Download className="h-4 w-4" />确认导出</Button>
      </>}>
        <div className="space-y-4 text-sm leading-relaxed text-text-secondary">
          <p className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" /><span>导出的 JSON 包含真实 API Key、伪装 API Key 及自定义认证请求头，均以明文保存。</span></p>
          <p>请只保存到受信任的本地位置，不要提交到版本库、上传公开位置或分享给他人。</p>
          <p className="text-xs text-text-muted">导出只读取已保存的配置，不包含日志。{routingDirty ? '当前未保存的路由更改不会导出。' : ''}</p>
          {exportError && <p role="alert" className="break-words text-danger">导出失败：{exportError}。请重试或取消。</p>}
        </div>
      </Modal>

      <Modal open={resetOpen} onClose={() => { if (!busy) setResetOpen(false) }} title="重置统计数据？" busy={busyAction === 'reset'} footer={<>
        <Button variant="secondary" disabled={busy} onClick={() => setResetOpen(false)}>取消</Button>
        <Button variant="primary" loading={busyAction === 'reset'} disabled={busy} onClick={handleResetStats}><RotateCcw className="h-4 w-4" />确认重置统计</Button>
      </>}>
        <div className="space-y-3 text-sm leading-relaxed text-text-secondary">
          <p>平台与密钥配置保留，此操作会：</p>
          <ul className="list-inside list-disc space-y-2">
            <li>清空所有保留的请求日志。</li>
            <li>将 Key 请求计数、Token 用量、错误计数及最后使用时间归零。</li>
            <li>恢复耗尽 / 错误状态的 Key；手动禁用的 Key 保持禁用。</li>
          </ul>
          <p className="flex items-center gap-2 text-xs text-text-secondary"><AlertTriangle className="h-4 w-4 shrink-0 text-warning" />日志与计数删除后无法恢复。</p>
          {resetError && <p role="alert" className="break-words text-danger">重置失败：{resetError}。请重试或取消。</p>}
        </div>
      </Modal>

      <Modal open={clearOpen} onClose={() => { if (!busy) setClearOpen(false) }} title="永久清除所有数据？" busy={busyAction === 'clear'} footer={<>
        <Button variant="secondary" disabled={busy} onClick={() => setClearOpen(false)}>取消</Button>
        <Button variant="danger" loading={busyAction === 'clear'} disabled={busy || proxyRunning || proxyBusy} onClick={handleClearAllData}><Trash2 className="h-4 w-4" />确认清除所有数据</Button>
      </>}>
        <div className="space-y-3 text-sm leading-relaxed text-text-secondary">
          <p className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" /><span>将永久删除全部上游平台、真实 API Key、请求日志、统计数据与自定义设置。此操作不可撤销。</span></p>
          <p>仅保留当前伪装 API Key。现有客户端仍可使用此凭证，但需重新配置上游平台才能转发请求。</p>
          <p className="text-xs text-text-muted">如需保留备份，请先取消并导出配置。</p>
          {proxyRunning && <p role="alert" className="text-warning">代理正在运行，请取消并先停止代理服务。</p>}
          {clearError && <p role="alert" className="break-words text-danger">清除失败：{clearError}。请重试或取消。</p>}
        </div>
      </Modal>
    </div>
  )
}

function PreviewCount({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return <div><dt className="text-xs text-text-secondary">{label}</dt><dd className="mt-1 text-lg font-semibold text-text-primary">{value.toLocaleString()}</dd>{hint && <p className="mt-1 text-xs leading-relaxed text-text-muted">{hint}</p>}</div>
}

function summarizeImport(content: string): ImportPreview {
  const cleanContent = content.trim()
  const parsed: unknown = JSON.parse(cleanContent)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置必须是 JSON 对象。')
  const config = parsed as Record<string, unknown>
  const hasPlatforms = Object.prototype.hasOwnProperty.call(config, 'platforms')
  const hasProxy = Object.prototype.hasOwnProperty.call(config, 'proxy')
  const hasSettings = Object.prototype.hasOwnProperty.call(config, 'settings')
  if (!hasPlatforms && !hasProxy && !hasSettings) throw new Error('文件中没有 platforms、proxy 或 settings 配置。')
  if (hasPlatforms && !Array.isArray(config.platforms)) throw new Error('文件中的 platforms 必须是列表。')
  const platforms = hasPlatforms ? config.platforms as unknown[] : []
  let keyCount = 0
  for (const platform of platforms) {
    if (!platform || typeof platform !== 'object' || Array.isArray(platform)) throw new Error('平台列表中包含无效条目。')
    const keys = (platform as Record<string, unknown>).keys
    if (Array.isArray(keys)) keyCount += keys.length
  }
  // The backend performs full schema validation only after explicit confirmation.
  return { content: cleanContent, platformCount: platforms.length, keyCount, hasPlatforms, hasProxy, hasSettings }
}
