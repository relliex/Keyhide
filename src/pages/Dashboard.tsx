import { useNavigate } from 'react-router-dom'
import { ArrowRight, Activity, ShieldCheck, KeyRound, Network, Play, Square, Plus, Boxes, CheckCircle2, Circle, Server, Code2 } from 'lucide-react'
import { useAppStore } from '../stores/app'
import { publicModelNames } from '../../electron/shared/models'
import { Button, Badge, Card, PageHeader, StatCard, CopyButton, EmptyState } from '../components/ui'
import { clientBaseUrl, usableKeys, formatCount, formatDuration } from '../lib/utils'

export function Dashboard() {
  const navigate = useNavigate()
  const data = useAppStore((state) => state.data)
  const running = useAppStore((state) => state.proxyRunning)
  const busy = useAppStore((state) => state.proxyBusy)
  const start = useAppStore((state) => state.startProxy)
  const stop = useAppStore((state) => state.stopProxy)
  if (!data) return null
  const enabled = data.platforms.filter((platform) => platform.enabled)
  const ready = enabled.filter((platform) => usableKeys(platform).length > 0)
  const keys = ready.reduce((sum, platform) => sum + usableKeys(platform).length, 0)
  const models = new Set(ready.flatMap((platform) => publicModelNames(platform, data.settings.enableModelAliases))).size
  const logs = data.logs
  const success = logs.filter((log) => log.statusCode >= 200 && log.statusCode < 300).length
  const defaultPlatform = ready.find((platform) => platform.id === data.settings.defaultPlatformId)
  const url = clientBaseUrl(data.proxy)
  return <div className="page-shell">
    <PageHeader title="工作台" description="连接你的应用与上游平台。真实密钥只需在这里配置。" action={<Button variant="secondary" onClick={() => navigate('/platforms?new=1')}><Plus className="h-4 w-4" />添加平台</Button>} />
    <section className="connection-panel">
      <div className="connection-main">
        <div className="flex flex-wrap items-start justify-between gap-5"><div><Badge variant={running ? 'success' : 'default'}>{running ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}{running ? '本地代理已连接' : '本地代理未启动'}</Badge><h2 className="mt-4 text-[28px] font-semibold leading-tight tracking-tight">让项目只看见本地凭证。</h2><p className="mt-3 max-w-xl text-sm leading-relaxed text-text-muted">{ready.length ? `已准备好 ${ready.length} 个平台和 ${keys} 个可用密钥，随时可以接入。` : '先添加上游平台与真实密钥，再把本地地址和接入 Key 填入你的应用。'}</p></div><Button size="lg" variant={running ? 'secondary' : 'primary'} loading={busy} disabled={!running && !ready.length} onClick={() => void (running ? stop() : start())}>{running ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}{running ? '停止服务' : '启动服务'}</Button></div>
        <div className="connection-path" aria-label="请求通过 Keyhide 从应用转发到上游平台">
          <div className="connection-node"><Code2 className="h-5 w-5 text-text-muted" /><p>你的应用</p><span>只使用本地地址和接入 Key</span></div><ArrowRight className="h-4 w-4 text-text-muted" aria-hidden="true" />
          <div className="connection-node center"><ShieldCheck className="h-5 w-5 text-accent" /><p>Keyhide</p><span>{url.replace('http://', '')}</span></div><ArrowRight className="h-4 w-4 text-text-muted" aria-hidden="true" />
          <div className="connection-node"><Network className="h-5 w-5 text-text-muted" /><p>{defaultPlatform?.name || (ready.length ? `${ready.length} 个可用上游` : '上游平台')}</p><span>{data.settings.routeMode === 'by-model' ? '按模型精确匹配' : data.settings.routeMode === 'by-path' ? '默认平台转发' : '自动选择匹配平台'}</span></div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-bg-primary/30 px-7 py-4"><span className="flex items-center gap-2 text-xs text-text-muted"><KeyRound className="h-4 w-4" />接入凭证与真实密钥分离；接入 Key 仍需妥善保管。</span><Button variant="ghost" size="sm" onClick={() => navigate('/proxy')}>查看接入地址与配置<ArrowRight className="h-3.5 w-3.5" /></Button></div>
    </section>
    {!ready.length && <section className="mt-6 rounded-xl border border-border p-5"><h2 className="text-sm font-semibold">开始使用</h2><ol className="mt-4 grid gap-3 md:grid-cols-3">{[
      { title: '添加上游平台', detail: '填写地址与真实 API Key', done: ready.length > 0, action: () => navigate('/platforms?new=1') },
      { title: '确认可用模型', detail: '获取列表或手动填写模型', done: models > 0, action: () => navigate('/models') },
      { title: '接入你的应用', detail: '复制本地地址与接入 Key', done: running, action: () => navigate('/proxy') }
    ].map((step, index) => <li key={step.title}><button onClick={step.action} className="flex w-full items-start gap-3 rounded-lg p-2 text-left hover:bg-bg-secondary"><span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-border text-xs text-accent">{step.done ? <CheckCircle2 className="h-4 w-4" /> : index + 1}</span><span><span className="block text-sm">{step.title}</span><span className="mt-1 block text-xs text-text-muted">{step.detail}</span></span></button></li>)}</ol></section>}
    <section className="stat-strip my-6" aria-label="当前配置与保留日志统计"><StatCard label="可用上游平台" value={ready.length} icon={<Network />} trend={`${data.platforms.length} 个平台已配置`} /><StatCard label="可路由模型" value={models} icon={<Boxes />} trend="跨平台去重后数量" /><StatCard label="保留请求记录" value={formatCount(logs.length)} icon={<Activity />} trend={logs.length ? `成功率 ${Math.round(success / logs.length * 100)}%` : '尚未收到请求'} /><StatCard label="保留日志 Token" value={formatCount(logs.reduce((sum, log) => sum + log.promptTokens + log.completionTokens, 0))} icon={<Server />} trend="仅统计当前保留日志" /></section>
    <div className="grid items-start gap-6 xl:grid-cols-[1.2fr_1fr]">
      <section><div className="section-heading"><h2>最近请求</h2><Button variant="ghost" size="sm" onClick={() => navigate('/logs')}>查看全部<ArrowRight className="h-3.5 w-3.5" /></Button></div><div className="card overflow-hidden">{!logs.length ? <EmptyState icon={<Activity className="h-6 w-6" />} title="等待第一条请求" description={data.proxy.logRequests ? '从你的应用调用本地代理后，这里会显示路由结果、状态和耗时。' : '请求日志已关闭。可在代理服务设置中开启记录。'} action={!data.proxy.logRequests ? <Button variant="secondary" size="sm" onClick={() => navigate('/proxy')}>开启日志</Button> : undefined} /> : logs.slice(0, 5).map((log) => <button key={log.id} onClick={() => navigate(`/logs?search=${encodeURIComponent(log.model || log.path)}`)} className="flex w-full items-center justify-between gap-3 border-b border-border/60 p-4 text-left last:border-b-0 hover:bg-bg-tertiary"><div className="min-w-0"><p className="truncate text-sm font-medium">{log.model || log.path}</p><p className="mt-1 truncate text-xs text-text-muted">{log.platformName || '未匹配平台'} / {log.keyLabel || '未使用密钥'}</p></div><div className="flex flex-shrink-0 items-center gap-3"><span className="text-xs text-text-muted">{formatDuration(log.duration)}</span><Badge variant={log.statusCode >= 200 && log.statusCode < 300 ? 'success' : 'danger'}>{log.statusCode || '连接失败'}</Badge></div></button>)}</div></section>
      <section><div className="section-heading"><h2>接入信息</h2><Button variant="ghost" size="sm" onClick={() => navigate('/settings')}>预览路由<ArrowRight className="h-3.5 w-3.5" /></Button></div><Card><p className="mb-2 text-xs text-text-muted">OpenAI / Responses SDK 地址</p><div className="credential-row"><code>{url}/v1</code><CopyButton text={`${url}/v1`} /></div><p className="mb-2 mt-4 text-xs text-text-muted">Anthropic SDK / Gemini 基础地址</p><div className="credential-row"><code>{url}</code><CopyButton text={url} /></div><p className="mt-4 text-xs leading-relaxed text-text-muted">四种格式共用同一个接入 Key；Keyhide 会按平台设置自动转换协议。查看代理服务可复制凭证与调用示例。</p><Button variant="secondary" className="mt-5 w-full" onClick={() => navigate('/proxy')}><KeyRound className="h-4 w-4" />查看接入凭证</Button></Card></section>
    </div>
  </div>
}
