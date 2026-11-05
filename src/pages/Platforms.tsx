import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Network, ChevronDown, ChevronRight, Pencil, Trash2, RefreshCw, Zap, KeyRound, CheckCircle2, AlertTriangle, XCircle, Eye, EyeOff, Star, Search, Settings2, Copy } from 'lucide-react'
import { useAppStore } from '../stores/app'
import { Badge, Button, Card, ConfirmDialog, CopyButton, EmptyState, Input, Modal, PageHeader, Select, Toggle } from '../components/ui'
import type { LoadBalanceStrategy, PlatformType, UpstreamKey, UpstreamPlatform, ApiProtocol } from '../../electron/shared/types'
import { PROTOCOL_OPTIONS, PROTOCOL_SHORT_LABELS } from '../../electron/shared/protocols'
import { errorMessage, maskSecret, usableKeys, clientBaseUrl, formatCount } from '../lib/utils'

const keyStates = {
  active: { label: '可用', variant: 'success' as const, icon: CheckCircle2 },
  exhausted: { label: '额度耗尽', variant: 'warning' as const, icon: AlertTriangle },
  error: { label: '可重试', variant: 'warning' as const, icon: AlertTriangle },
  disabled: { label: '已禁用', variant: 'default' as const, icon: XCircle }
}

export function Platforms() {
  const data = useAppStore((state) => state.data)
  const savePlatform = useAppStore((state) => state.savePlatform)
  const deletePlatform = useAppStore((state) => state.deletePlatform)
  const saveSettings = useAppStore((state) => state.saveSettings)
  const showToast = useAppStore((state) => state.showToast)
  const [params, setParams] = useSearchParams()
  const selected = params.get('selected')
  const query = params.get('q') || ''
  const [editor, setEditor] = useState<UpstreamPlatform | null>(null)
  const [deleting, setDeleting] = useState<UpstreamPlatform | null>(null)
  const [keyDeleting, setKeyDeleting] = useState<{ platform: UpstreamPlatform; key: UpstreamKey } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const opening = useRef(false)
  const selectPlatform = (id: string | null) => { const next = new URLSearchParams(params); if (id) next.set('selected', id); else next.delete('selected'); next.delete('new'); setParams(next, { replace: true }) }
  const addPlatform = async () => {
    if (opening.current) return
    opening.current = true
    setBusy('new')
    try { setEditor(await window.extraApi.createPlatform()) }
    catch (error) { showToast({ type: 'error', message: errorMessage(error) }) }
    finally { opening.current = false; setBusy(null) }
  }
  useEffect(() => {
    if (params.get('new') === '1') {
      const next = new URLSearchParams(params); next.delete('new'); setParams(next, { replace: true })
      void addPlatform()
    }
  }, [params.get('new')])
  const run = async (id: string, action: () => Promise<unknown>, message?: string) => {
    if (busy) return
    setBusy(id)
    try { await action(); if (message) showToast({ type: 'success', message }); return true }
    catch (error) { showToast({ type: 'error', message: errorMessage(error) }); return false }
    finally { setBusy(null) }
  }
  if (!data) return null
  const filtered = data.platforms.filter((platform) => `${platform.name} ${platform.baseUrl} ${platform.type}`.toLowerCase().includes(query.trim().toLowerCase()))
  const fetchModels = (platform: UpstreamPlatform) => run(platform.id, async () => { const models = await window.api.fetchModels(platform.id); await useAppStore.getState().loadData(); showToast({ type: models.length ? 'success' : 'warning', message: models.length ? `已获取 ${models.length} 个模型` : '上游未返回模型。可编辑平台手动填写模型名称。' }) })
  const test = (platform: UpstreamPlatform) => run(platform.id, async () => { const result = await window.api.testConnection(platform.id); showToast({ type: result.success ? 'success' : 'error', message: result.message }); await useAppStore.getState().loadData() })
  return <div className="page-shell">
    <PageHeader title="上游平台" description="在本地管理真实地址与密钥。每个平台可以使用多个 Key 自动接力。" action={<Button onClick={() => void addPlatform()} loading={busy === 'new'} disabled={!!busy}><Plus className="h-4 w-4" />添加平台</Button>} />
    {!!data.platforms.length && <div className="mb-5 flex flex-wrap items-end justify-between gap-4"><div className="w-full max-w-sm"><Input label="搜索平台" value={query} placeholder="平台名称、地址或格式" onChange={(event) => { const next = new URLSearchParams(params); if (event.target.value) next.set('q', event.target.value); else next.delete('q'); setParams(next, { replace: true }) }} /></div><span className="text-xs text-text-muted">{data.platforms.length} 个已配置平台，{data.platforms.filter((platform) => platform.enabled && usableKeys(platform).length).length} 个可用</span></div>}
    {!filtered.length ? <Card><EmptyState icon={query ? <Search className="h-6 w-6" /> : <Network className="h-6 w-6" />} title={query ? '没有匹配的平台' : '添加第一个上游平台'} description={query ? '尝试其他平台名称或清除搜索内容。' : '填写上游基础地址和真实 API Key，随后获取模型列表并启动本地代理。'} action={<Button onClick={query ? () => setParams({}) : () => void addPlatform()}>{query ? '清除搜索' : '添加平台'}</Button>} /></Card> : <div className="space-y-4">{filtered.map((platform) => {
      const available = usableKeys(platform).length
      const expanded = selected === platform.id
      const isDefault = data.settings.defaultPlatformId === platform.id
      return <section key={platform.id} className="card overflow-hidden">
        <button type="button" className="flex w-full items-center justify-between gap-4 p-5 text-left hover:bg-bg-tertiary/30" aria-expanded={expanded} aria-controls={`platform-${platform.id}`} onClick={() => selectPlatform(expanded ? null : platform.id)}><div className="flex min-w-0 items-center gap-4"><div className="hidden h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-border text-accent sm:flex"><Network className="h-5 w-5" /></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold">{platform.name}</h2><Badge>{PROTOCOL_SHORT_LABELS[platform.upstreamProtocol] || platform.upstreamProtocol}</Badge>{isDefault && <Badge variant="accent"><Star className="h-3 w-3" />默认</Badge>}{platform.type === 'custom' && <Badge>自定义认证</Badge>}{!platform.enabled && <Badge>已停用</Badge>}</div><p className="mt-2 truncate font-mono text-xs text-text-muted" title={platform.baseUrl}>{platform.baseUrl}</p></div></div><div className="flex flex-shrink-0 items-center gap-3"><div className="hidden text-right sm:block"><p className="text-xs text-text-secondary">{available} / {platform.keys.length} 个可用 Key</p><p className="mt-1 text-xs text-text-muted">{platform.models.length} 个模型</p></div>{expanded ? <ChevronDown className="h-4 w-4 text-text-muted" /> : <ChevronRight className="h-4 w-4 text-text-muted" />}</div></button>
        {expanded && <div id={`platform-${platform.id}`} className="border-t border-border p-5">
          <div className="mb-5 flex flex-wrap gap-2"><Button variant="secondary" size="sm" onClick={() => setEditor(structuredClone(platform))} disabled={!!busy}><Pencil className="h-3.5 w-3.5" />编辑平台</Button><Button variant="secondary" size="sm" onClick={() => void fetchModels(platform)} disabled={!!busy || !available} loading={busy === platform.id}><RefreshCw className="h-3.5 w-3.5" />获取模型</Button><Button variant="secondary" size="sm" onClick={() => void test(platform)} disabled={!!busy || !available}><Zap className="h-3.5 w-3.5" />测试连接</Button><Button variant="ghost" size="sm" disabled={!!busy || !platform.enabled || !available || isDefault} onClick={() => void run(platform.id, () => saveSettings({ defaultPlatformId: platform.id }), '已设为默认平台')}><Star className="h-3.5 w-3.5" />{isDefault ? '默认平台' : '设为默认'}</Button><Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void run(platform.id, () => savePlatform({ ...platform, enabled: !platform.enabled }), platform.enabled ? '平台已停用' : '平台已启用')}>{platform.enabled ? '停用平台' : '启用平台'}</Button><Button variant="ghost" size="sm" className="text-danger" disabled={!!busy} onClick={() => setDeleting(platform)}><Trash2 className="h-3.5 w-3.5" />删除</Button></div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">API Key <span className="text-text-muted">({platform.keys.length})</span></h3>{!!platform.keys.length && <div className="flex gap-2"><Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void run(platform.id, () => savePlatform({ ...platform, keys: platform.keys.map((key) => ({ ...key, status: 'active' })) }), '已恢复全部 Key')}>全部恢复</Button><Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void run(platform.id, () => savePlatform({ ...platform, keys: platform.keys.map((key) => ({ ...key, status: 'disabled' })) }), '已禁用全部 Key')}>全部禁用</Button></div>}</div>
          {platform.keys.length ? <div className="space-y-2">{platform.keys.map((key) => <KeyRow key={key.id} keyData={key} disabled={!!busy} onToggle={() => void run(platform.id, () => savePlatform({ ...platform, keys: platform.keys.map((existing) => existing.id === key.id ? { ...existing, status: key.status === 'active' ? 'disabled' : 'active' } : existing) }), key.status === 'active' ? 'Key 已禁用' : 'Key 已恢复')} onDelete={() => setKeyDeleting({ platform, key })} />)}</div> : <p className="rounded-lg border border-warning/25 bg-warning/5 p-4 text-xs text-warning">尚无 API Key。编辑平台添加密钥后即可获取模型。</p>}
          <div className="mt-5 border-t border-border pt-4"><h3 className="mb-2 text-xs font-medium text-text-secondary">平台专用接入地址</h3><div className="credential-row"><code>{clientBaseUrl(data.proxy)}/{platform.id}/v1</code><CopyButton text={`${clientBaseUrl(data.proxy)}/${platform.id}/v1`} /></div><p className="mt-2 text-xs leading-relaxed text-text-muted">在 URL 中指定平台时只使用这个平台，不会切换到其他上游。</p></div>
          <div className="mt-5"><h3 className="mb-3 text-xs font-medium text-text-secondary">模型列表</h3>{platform.models.length ? <div className="flex flex-wrap gap-2">{platform.models.slice(0, 12).map((model) => <span key={model} className="rounded border border-border px-2 py-1 font-mono text-xs text-text-muted">{model}</span>)}{platform.models.length > 12 && <span className="px-2 py-1 text-xs text-text-muted">另有 {platform.models.length - 12} 个模型</span>}</div> : <p className="text-xs leading-relaxed text-text-muted">点击获取模型，或编辑平台手动填写。按模型路由需要已配置的精确名称。</p>}</div>
        </div>}
      </section>
    })}</div>}
    {editor && <PlatformEditor platform={editor} onClose={() => setEditor(null)} onSave={async (platform) => { await savePlatform(platform, editor); setEditor(null); selectPlatform(platform.id); showToast({ type: 'success', message: '平台已保存' }) }} />}
    <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="删除上游平台？" description={`将删除“${deleting?.name}”及其 ${deleting?.keys.length || 0} 个真实 Key。使用此平台的请求会受到影响，操作不能撤销。`} confirmLabel="删除平台" busy={!!busy} onConfirm={() => { if (deleting) void run(deleting.id, async () => { await deletePlatform(deleting.id); setDeleting(null); if (selected === deleting.id) selectPlatform(null) }, '平台已删除') }} />
    <ConfirmDialog open={!!keyDeleting} onClose={() => setKeyDeleting(null)} title="删除这个 API Key？" description={`将从“${keyDeleting?.platform.name}”删除“${keyDeleting?.key.label}”。正在进行的请求不受影响，后续请求不再使用这个 Key。`} confirmLabel="删除 Key" busy={!!busy} onConfirm={() => { if (keyDeleting) void run(keyDeleting.platform.id, async () => { await savePlatform({ ...keyDeleting.platform, keys: keyDeleting.platform.keys.filter((key) => key.id !== keyDeleting.key.id) }); setKeyDeleting(null) }, 'Key 已删除') }} />
  </div>
}

function KeyRow({ keyData, onToggle, onDelete, disabled }: { keyData: UpstreamKey; onToggle: () => void; onDelete: () => void; disabled: boolean }) {
  const [visible, setVisible] = useState(false)
  const status = keyData.status === 'error' && keyData.retryAt !== undefined && keyData.retryAt > Date.now() ? { ...keyStates.error, label: '冷却中' } : keyStates[keyData.status]
  const Icon = status.icon
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg-primary/50 p-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><KeyRound className="h-3.5 w-3.5 text-text-muted" /><span className="text-sm font-medium">{keyData.label}</span><Badge variant={status.variant}><Icon className="h-3 w-3" />{status.label}</Badge><span className="text-xs text-text-muted">{formatCount(keyData.requestCount)} 次请求</span></div><code className="mt-1.5 block break-all text-xs text-text-muted">{visible ? keyData.key : maskSecret(keyData.key)}</code>{keyData.lastError && <p className="mt-1 max-w-lg break-words text-xs text-warning">{keyData.lastError}</p>}</div><div className="flex items-center gap-1"><Button variant="ghost" size="sm" onClick={() => setVisible(!visible)} aria-label={visible ? `隐藏 ${keyData.label}` : `显示 ${keyData.label}`}>{visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</Button><CopyButton text={keyData.key} label="" /><Button variant="ghost" size="sm" onClick={onToggle} disabled={disabled}>{keyData.status === 'active' ? '禁用' : '恢复'}</Button><Button variant="ghost" size="sm" onClick={onDelete} disabled={disabled} aria-label={`删除 ${keyData.label}`} className="text-danger"><Trash2 className="h-3.5 w-3.5" /></Button></div></div>
}

function PlatformEditor({ platform, onSave, onClose }: { platform: UpstreamPlatform; onSave: (platform: UpstreamPlatform) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(() => structuredClone(platform))
  const [models, setModels] = useState(platform.models.join('\n'))
  const [headers, setHeaders] = useState(Object.keys(platform.customHeaders).length ? JSON.stringify(platform.customHeaders, null, 2) : '')
  const [keyInput, setKeyInput] = useState('')
  const [keyLabel, setKeyLabel] = useState('')
  const [visible, setVisible] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const showToast = useAppStore((state) => state.showToast)
  const dirty = JSON.stringify(draft) !== JSON.stringify(platform) || models !== platform.models.join('\n') || keyInput.length > 0 || headers !== (Object.keys(platform.customHeaders).length ? JSON.stringify(platform.customHeaders, null, 2) : '')
  const close = () => { if (!saving) { if (dirty) setDiscard(true); else onClose() } }
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])
  const newKeys = async () => {
    const existing = new Set(draft.keys.map((key) => key.key))
    const values = [...new Set(keyInput.split(/\r?\n/).map((key) => key.trim()).filter(Boolean))].filter((key) => !existing.has(key))
    return Promise.all(values.map((value, index) => window.extraApi.createKey(value, keyLabel.trim() ? `${keyLabel.trim()}${values.length > 1 ? `-${index + 1}` : ''}` : `Key-${draft.keys.length + index + 1}`)))
  }
  const addKeys = async () => {
    setSaving(true)
    try { const keys = await newKeys(); if (!keys.length) { setErrors({ ...errors, key: '没有新的 Key，可能已经添加过。' }); return }; setDraft({ ...draft, keys: [...draft.keys, ...keys] }); setKeyInput(''); setKeyLabel(''); setErrors({}) }
    catch (error) { showToast({ type: 'error', message: errorMessage(error) }) }
    finally { setSaving(false) }
  }
  const save = async () => {
    const validation: Record<string, string> = {}
    if (!draft.name.trim()) validation.name = '请输入平台名称'
    try { const url = new URL(draft.baseUrl.trim()); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error(); }
    catch { validation.url = '请输入有效的 http(s) 基础地址，不要包含账号或片段。' }
    let customHeaders: Record<string, string> = {}
    try { const parsed = headers.trim() ? JSON.parse(headers) : {}; if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== 'string')) throw new Error(); customHeaders = parsed }
    catch { validation.headers = '请求头必须是 JSON 对象，所有值使用字符串。' }
    if (draft.keys.some((key) => !Number.isFinite(key.weight) || key.weight <= 0 || key.weight > 1000000 || !Number.isInteger(key.priority) || Math.abs(key.priority) > 1000000 || !Number.isFinite(key.quotaLimit) || key.quotaLimit < 0 || key.quotaLimit > Number.MAX_SAFE_INTEGER)) validation.keys = '权重须大于 0 且不超过 1000000；优先级为 -1000000 至 1000000 的整数；额度上限为非负有限数。'
    setErrors(validation)
    if (Object.keys(validation).length) return
    setSaving(true)
    try {
      const added = await newKeys()
      await onSave({ ...draft, name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), keys: [...draft.keys, ...added], models: [...new Set(models.split(/[\r\n,]+/).map((model) => model.trim()).filter(Boolean))], customHeaders, updatedAt: Date.now() })
    } catch (error) { showToast({ type: 'error', message: errorMessage(error) }) }
    finally { setSaving(false) }
  }
  return <Modal open onClose={close} title={discard ? '放弃未保存的修改？' : `${platform.name ? '编辑' : '添加'}上游平台`} width="700px" busy={saving} footer={discard ? <><Button variant="secondary" onClick={() => setDiscard(false)}>继续编辑</Button><Button variant="danger" onClick={onClose}>放弃修改</Button></> : <><Button variant="secondary" onClick={close} disabled={saving}>取消</Button><Button onClick={() => void save()} loading={saving}>保存平台</Button></>}>
    {discard ? <p className="text-sm leading-relaxed text-text-secondary">刚才输入的平台、模型与密钥尚未保存。放弃后不会修改现有配置。</p> : <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2"><Input label="平台名称" value={draft.name} placeholder="例如：开发环境" error={errors.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /><Select label="上游接口格式" value={draft.upstreamProtocol} onChange={(protocol) => setDraft({ ...draft, upstreamProtocol: protocol as ApiProtocol })} options={PROTOCOL_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} /></div>
      <p className="-mt-2 text-xs leading-relaxed text-text-muted">选择上游真实支持的生成接口。下游可以使用任意一种接口，Keyhide 会自动转换请求与响应。</p>
      <div className="grid gap-4 sm:grid-cols-2"><Select label="认证方式" value={draft.type} onChange={(type) => setDraft({ ...draft, type: type as PlatformType })} options={[{ value: 'openai', label: 'Bearer（OpenAI 兼容）' }, { value: 'anthropic', label: 'x-api-key（Anthropic）' }, { value: 'custom', label: '自定义请求头认证' }]} /><Input label="上游基础地址" value={draft.baseUrl} placeholder="https://api.example.com" error={errors.url} hint="支持带 /v1、/v1beta 或服务路径前缀；不要填写具体接口或真实密钥。" onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></div>
      <div className="flex items-center justify-between gap-3"><span className="text-sm text-text-secondary">允许这个平台接收代理请求</span><Toggle label="启用此平台" checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} /></div>
      <div className="border-t border-border pt-5"><h3 className="mb-3 text-sm font-semibold">真实 API Key</h3><div className="rounded-lg border border-border bg-bg-primary/50 p-4"><div className="mb-3 flex items-center justify-between gap-3"><label htmlFor="new-platform-keys" className="field-label">添加 Key（每行一个，支持批量粘贴）</label><Button variant="ghost" size="sm" aria-label={visible ? '隐藏输入的密钥' : '显示输入的密钥'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</Button></div><textarea id="new-platform-keys" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} rows={2} spellCheck={false} autoComplete="off" className="input font-mono text-xs" style={visible ? undefined : { WebkitTextSecurity: 'disc' } as CSSProperties} placeholder="粘贴真实 API Key" /><div className="mt-3 flex flex-wrap items-end gap-3"><div className="min-w-[140px] flex-1"><Input label="Key 标签（可选）" value={keyLabel} onChange={(event) => setKeyLabel(event.target.value)} placeholder="例如：主账户" /></div><Button variant="secondary" size="sm" onClick={() => void addKeys()} disabled={!keyInput.trim()} loading={saving}><Plus className="h-3.5 w-3.5" />添加到列表</Button></div>{errors.key && <p className="mt-2 text-xs text-danger">{errors.key}</p>}<p className="mt-3 text-xs text-text-muted">直接点击“保存平台”也会保存尚未添加到列表的 Key。真实密钥不会写入项目代码。</p></div>
        <div className="mt-3 space-y-2">{draft.keys.map((key) => <div key={key.id} className="rounded-lg border border-border p-3"><div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="text-sm">{key.label}</p><code className="text-xs text-text-muted">{maskSecret(key.key)}</code></div><Button variant="ghost" size="sm" aria-label={`移除 ${key.label}`} className="text-danger" onClick={() => setDraft({ ...draft, keys: draft.keys.filter((existing) => existing.id !== key.id) })}><Trash2 className="h-3.5 w-3.5" /></Button></div>{advanced && <div className="mt-3 grid grid-cols-3 gap-3">{[{ field: 'weight', label: '权重', min: Number.MIN_VALUE, max: 1000000, step: 'any' }, { field: 'priority', label: '优先级', min: -1000000, max: 1000000, step: 1 }, { field: 'quotaLimit', label: 'Token 估算上限', min: 0, max: Number.MAX_SAFE_INTEGER, step: 'any' }].map(({ field, label, min, max, step }) => <Input key={field} label={label} type="number" min={min} max={max} step={step} value={key[field as 'weight' | 'priority' | 'quotaLimit']} onChange={(event) => setDraft({ ...draft, keys: draft.keys.map((existing) => existing.id === key.id ? { ...existing, [field]: Number(event.target.value) } : existing) })} />)}</div>}</div>)}</div>{errors.keys && <p className="mt-2 text-xs text-danger">{errors.keys}</p>}
      </div>
      <div><label htmlFor="platform-models" className="field-label">支持的模型（每行一个，也可用逗号分隔）</label><textarea id="platform-models" className="input mt-2 font-mono text-xs" rows={3} value={models} onChange={(event) => setModels(event.target.value)} placeholder="可先保存，再通过“获取模型”自动填充" /><p className="mt-2 text-xs text-text-muted">按模型路由精确匹配名称。不配置列表时，自动模式仍可使用默认平台。</p></div>
      <Button variant="ghost" size="sm" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}><Settings2 className="h-3.5 w-3.5" />{advanced ? '收起高级配置' : '负载均衡与自定义请求头'}</Button>
      {advanced && <div className="space-y-4 rounded-lg border border-border p-4"><Select label="多 Key 选择策略" value={draft.strategy} onChange={(strategy) => setDraft({ ...draft, strategy: strategy as LoadBalanceStrategy })} options={[{ value: 'round-robin', label: '轮询：依次使用可用 Key' }, { value: 'priority', label: '优先级：数字越小越优先' }, { value: 'weighted', label: '加权：按 Key 权重分配' }, { value: 'random', label: '随机选择可用 Key' }]} /><p className="text-xs text-text-muted">每个 Key 的权重、优先级和 Token 估算上限可在上方调整，0 表示不限。估算依赖上游报告，并非账单或严格的费用限制。</p><div><label htmlFor="platform-headers" className="field-label">自定义请求头（JSON）</label><textarea id="platform-headers" className="input mt-2 font-mono text-xs" rows={3} value={headers} onChange={(event) => setHeaders(event.target.value)} placeholder={'{"X-Project": "development"}'} />{errors.headers && <p className="mt-2 text-xs text-danger">{errors.headers}</p>}</div></div>}
    </div>}
  </Modal>
}
