import { useState } from 'react'
import { UnsavedChangesGuard } from '../components/UnsavedChangesGuard'
import { useNavigate } from 'react-router-dom'
import { Server, Play, Square, RefreshCw, Eye, EyeOff, KeyRound, Info, ShieldCheck, Circle, CheckCircle2, Network } from 'lucide-react'
import { useAppStore } from '../stores/app'
import { Badge, Button, Card, ConfirmDialog, CopyButton, Input, PageHeader, SettingRow, Toggle } from '../components/ui'
import { clientBaseUrl, errorMessage, usableKeys } from '../lib/utils'

interface ProxyDraft { host: string; port: string; timeout: string; maxLogs: string; cors: boolean; logRequests: boolean }

export function ProxyPage() {
  const data = useAppStore((state) => state.data)
  const running = useAppStore((state) => state.proxyRunning)
  const proxyBusy = useAppStore((state) => state.proxyBusy)
  const start = useAppStore((state) => state.startProxy)
  const stop = useAppStore((state) => state.stopProxy)
  const saveConfig = useAppStore((state) => state.saveProxyConfig)
  const showToast = useAppStore((state) => state.showToast)
  const navigate = useNavigate()
  const [showKey, setShowKey] = useState(false)
  const [regenerate, setRegenerate] = useState(false)
  const [saving, setSaving] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [format, setFormat] = useState<'openai' | 'anthropic'>('openai')
  const saved: ProxyDraft = { host: data?.proxy.host || '127.0.0.1', port: String(data?.proxy.port || 7860), timeout: String((data?.proxy.timeout || 120000) / 1000), maxLogs: String(data?.proxy.maxLogs ?? 2000), cors: !!data?.proxy.cors, logRequests: data?.proxy.logRequests ?? true }
  const [draft, setDraft] = useState<ProxyDraft>(saved)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  if (!data) return null
  const url = clientBaseUrl(data.proxy)
  const ready = data.platforms.filter((platform) => platform.enabled && usableKeys(platform).length)
  const model = ready.find((platform) => platform.id === data.settings.defaultPlatformId)?.models[0] || ready.flatMap((platform) => platform.models)[0] || 'model-id'
  const body = format === 'openai' ? { model, messages: [{ role: 'user', content: 'Hello' }], stream: false } : { model, max_tokens: 128, messages: [{ role: 'user', content: 'Hello' }] }
  const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  const snippet = `curl ${shellQuote(`${url}/v1/${format === 'openai' ? 'chat/completions' : 'messages'}`)} \\\n  -H ${shellQuote(format === 'openai' ? 'Authorization: Bearer YOUR_KEYHIDE_KEY' : 'x-api-key: YOUR_KEYHIDE_KEY')} \\\n${format === 'anthropic' ? "  -H 'anthropic-version: 2023-06-01' \\\n" : ''}  -H 'Content-Type: application/json' \\\n  -d ${shellQuote(JSON.stringify(body, null, 2))}`
  const save = async () => {
    const validation: Record<string, string> = {}
    if (!Number.isInteger(Number(draft.port)) || Number(draft.port) < 1 || Number(draft.port) > 65535) validation.port = '端口必须是 1–65535 之间的整数'
    if (!draft.host.trim() || /[\s/]/.test(draft.host.trim())) validation.host = '请输入有效的监听 IP 或主机名，不需要 http://'
    if (!Number.isInteger(Number(draft.timeout) * 1000) || Number(draft.timeout) < 0.1 || Number(draft.timeout) > 3600) validation.timeout = '超时必须在 0.1–3600 秒之间'
    if (!Number.isInteger(Number(draft.maxLogs)) || Number(draft.maxLogs) < 0 || Number(draft.maxLogs) > 20000) validation.maxLogs = '日志上限必须是 0–20000 之间的整数'
    setErrors(validation)
    if (Object.keys(validation).length) return
    setSaving(true)
    try {
      await saveConfig({ host: draft.host.trim(), port: Number(draft.port), timeout: Number(draft.timeout) * 1000, maxLogs: Number(draft.maxLogs), cors: draft.cors, logRequests: draft.logRequests })
      setDraft({ ...draft, host: draft.host.trim(), port: String(Number(draft.port)), timeout: String(Number(draft.timeout)), maxLogs: String(Number(draft.maxLogs)) })
      showToast({ type: 'success', message: '代理配置已保存' })
    } catch (error) { showToast({ type: 'error', message: errorMessage(error) }) }
    finally { setSaving(false) }
  }
  const rotate = async () => {
    setRotating(true)
    try { await window.extraApi.regenerateMaskedKey(); await useAppStore.getState().loadData(); setRegenerate(false); setShowKey(false); showToast({ type: 'success', message: '已生成新的接入 Key，请同步更新你的应用' }) }
    catch (error) { showToast({ type: 'error', message: errorMessage(error) }) }
    finally { setRotating(false) }
  }
  return <div className="page-shell">
    <UnsavedChangesGuard dirty={dirty} />
    <PageHeader title="代理服务" description="复制本地地址与接入 Key，替代应用中的真实上游凭证。" action={<Button variant={running ? 'secondary' : 'primary'} loading={proxyBusy} disabled={saving || (!running && (!ready.length || dirty))} onClick={() => void (running ? stop() : start())}>{running ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}{running ? '停止服务' : '启动服务'}</Button>} />
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-bg-secondary p-5"><div className="flex items-center gap-3"><Server className="h-5 w-5 text-accent" /><div><div className="flex items-center gap-2"><span className="text-sm font-semibold">本地连接</span><Badge variant={running ? 'success' : 'default'}>{running ? <CheckCircle2 className="h-3 w-3" /> : <Circle className="h-3 w-3" />}{running ? '运行中' : '已停止'}</Badge></div><p className="mt-2 font-mono text-xs text-text-muted">{url}</p></div></div><p className="max-w-sm text-xs leading-relaxed text-text-muted">{!ready.length ? '请先配置一个已启用、包含可用 Key 的上游平台。' : dirty ? '有未保存的设置，保存后再启动服务。' : running ? '当前应用请求会通过已保存的配置进行转发。' : '接入信息可以先复制，发送请求前请启动服务。'}</p>{!ready.length && <Button variant="secondary" size="sm" onClick={() => navigate('/platforms')}><Network className="h-3.5 w-3.5" />配置平台</Button>}</div>
    <div className="grid items-start gap-6 xl:grid-cols-[1.05fr_1fr]">
      <div className="space-y-6">
        <Card><div className="section-heading"><h2 className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-accent" />本地接入 Key</h2><Button variant="ghost" size="sm" onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}{showKey ? '隐藏' : '显示'}</Button></div><div className="credential-row"><code>{showKey ? data.proxy.maskedApiKey : 'sk-keyhide-••••••••••••••••••••'}</code><CopyButton text={data.proxy.maskedApiKey} label="复制 Key" /></div><p className="mt-3 text-xs leading-relaxed text-text-muted">这不是上游真实密钥，但持有它的人可以通过你的代理使用额度。不要公开分享接入 Key。</p><div className="mt-4 flex justify-end"><Button variant="ghost" size="sm" onClick={() => setRegenerate(true)}><RefreshCw className="h-3.5 w-3.5" />重新生成</Button></div></Card>
        <Card><div className="section-heading"><h2>SDK 接入地址</h2><ShieldCheck className="h-4 w-4 text-text-muted" /></div><p className="mb-2 text-xs text-text-secondary">OpenAI 兼容 SDK</p><div className="credential-row"><code>{url}/v1</code><CopyButton text={`${url}/v1`} /></div><p className="mb-2 mt-5 text-xs text-text-secondary">Anthropic SDK</p><div className="credential-row"><code>{url}</code><CopyButton text={url} /></div><div className="notice mt-5"><Info /><p>Anthropic SDK 的基础地址不带 /v1，SDK 会自行拼接 /v1/messages。OpenAI SDK 使用带 /v1 的地址。Keyhide 不会自动转换两种请求协议。</p></div>{['0.0.0.0', '::'].includes(data.proxy.host) && <div className="notice notice-warning mt-3"><Info /><p>服务监听所有网络接口。这里显示本机接入地址；其他设备使用本机局域网 IP，并注意防火墙和密钥安全。</p></div>}</Card>
        <Card><div className="section-heading"><h2>调用示例</h2><CopyButton text={snippet} label="复制示例" /></div><div className="mb-4 flex gap-2" role="tablist" aria-label="请求格式">{(['openai', 'anthropic'] as const).map((value) => <button key={value} role="tab" aria-selected={format === value} className={`rounded-lg border px-3 py-2 text-xs ${format === value ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-text-muted'}`} onClick={() => setFormat(value)}>{value === 'openai' ? 'OpenAI 格式' : 'Anthropic 格式'}</button>)}</div><pre className="code-block" role="tabpanel">{snippet}</pre><p className="mt-3 text-xs leading-relaxed text-text-muted">在 Bash 中执行示例前，将 YOUR_KEYHIDE_KEY 替换为上面的接入 Key，并确认模型属于对应请求格式的上游。示例不会自动发送请求。</p></Card>
      </div>
      <Card><div className="section-heading"><h2>服务设置</h2>{dirty && <Badge variant="warning">未保存</Badge>}</div><p className="mb-5 text-xs leading-relaxed text-text-muted">地址、端口与跨域设置需要先停止服务再修改。其他设置保存后对新请求生效。</p><div className="grid gap-4 sm:grid-cols-2"><Input label="监听地址" value={draft.host} disabled={running || saving} error={errors.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} hint="127.0.0.1 仅本机访问" /><Input label="监听端口" value={draft.port} type="number" min={1} max={65535} disabled={running || saving} error={errors.port} onChange={(event) => setDraft({ ...draft, port: event.target.value })} /></div><SettingRow title="允许浏览器跨域调用" description="开启后持有接入 Key 的网页可调用代理。非浏览器客户端不需要此项。"><Toggle label="允许跨域调用" checked={draft.cors} disabled={running || saving} onChange={(cors) => setDraft({ ...draft, cors })} /></SettingRow><SettingRow title="记录请求日志" description="保存状态、路由、耗时和 Token 用量，不保存聊天正文。"><Toggle label="记录请求日志" checked={draft.logRequests} disabled={saving} onChange={(logRequests) => setDraft({ ...draft, logRequests })} /></SettingRow><div className="mt-5 grid gap-4 sm:grid-cols-2"><Input label="上游超时（秒）" type="number" min={0.1} max={3600} step={0.1} value={draft.timeout} error={errors.timeout} onChange={(event) => setDraft({ ...draft, timeout: event.target.value })} /><Input label="最多保留日志" type="number" min={0} max={20000} value={draft.maxLogs} error={errors.maxLogs} onChange={(event) => setDraft({ ...draft, maxLogs: event.target.value })} /></div><p className="mt-3 text-xs leading-relaxed text-text-muted">超过上限会淘汰最早的日志。用量统计仅代表保留记录，不是账单或历史总量。</p><div className="mt-6 flex justify-end gap-2"><Button variant="ghost" disabled={!dirty || saving} onClick={() => { setDraft(saved); setErrors({}) }}>撤销修改</Button><Button onClick={() => void save()} loading={saving} disabled={!dirty || proxyBusy}>保存配置</Button></div></Card>
    </div>
    <ConfirmDialog open={regenerate} onClose={() => setRegenerate(false)} title="重新生成接入 Key？" description="旧的接入 Key 将立即失效，已配置的应用需要同步更新。真实上游密钥不会改变。" confirmLabel="生成新 Key" variant="primary" busy={rotating} onConfirm={() => void rotate()} />
  </div>
}
