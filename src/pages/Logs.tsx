import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAppStore } from '../stores/app'
import { Card, Button, Badge, Input, Select, EmptyState, Modal, PageHeader, ConfirmDialog } from '../components/ui'
import {
  ScrollText, Trash2, Download, Pause, Play, ChevronLeft, ChevronRight,
  CheckCircle2, AlertTriangle, CircleMinus, Clock, RotateCcw, X
} from 'lucide-react'
import type { RequestLog } from '../../electron/shared/types'
import { errorMessage } from '../lib/utils'

const PAGE_SIZE = 50
const STATUS_FILTERS = ['all', 'success', 'error', 'network', 'other']
const FORMAT_FILTERS = ['all', 'openai', 'anthropic']
const PERIOD_FILTERS = ['all', 'today', '24h']
const FILTER_KEYS = ['search', 'platform', 'status', 'format', 'period']

type FrozenView = { logs: RequestLog[]; capturedAt: number }

function isNetworkError(log: RequestLog) {
  return !Number.isFinite(log.statusCode) || log.statusCode <= 0 ||
    ([502, 504].includes(log.statusCode) && Boolean(log.error) && !/^HTTP\s+\d{3}\b/i.test(log.error!.trim()))
}

function isFailed(log: RequestLog) {
  return isNetworkError(log) || log.statusCode >= 400 || Boolean(log.error)
}

function isSuccess(log: RequestLog) {
  return log.statusCode >= 200 && log.statusCode < 300 && !log.error
}

export function Logs() {
  const data = useAppStore((s) => s.data)
  const loading = useAppStore((s) => s.loading)
  const error = useAppStore((s) => s.error)
  const loadData = useAppStore((s) => s.loadData)
  const clearLogs = useAppStore((s) => s.clearLogs)
  const showToast = useAppStore((s) => s.showToast)
  const [params, setParams] = useSearchParams()
  const [selectedLog, setSelectedLog] = useState<RequestLog | null>(null)
  const [frozenView, setFrozenView] = useState<FrozenView | null>(null)
  const [now, setNow] = useState(Date.now)
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState('')

  const search = params.get('search') || ''
  const filterPlatform = params.get('platform') || 'all'
  const filterStatus = validFilter(params.get('status'), STATUS_FILTERS)
  const filterFormat = validFilter(params.get('format'), FORMAT_FILTERS)
  const period = validFilter(params.get('period'), PERIOD_FILTERS)
  const filterSignature = [search, filterPlatform, filterStatus, filterFormat, period].join('\u0000')
  const hasFilters = Boolean(search || filterPlatform !== 'all' || filterStatus !== 'all' || filterFormat !== 'all' || period !== 'all')
  const sourceLogs = frozenView?.logs ?? data?.logs ?? []
  const referenceTime = useMemo(() => frozenView?.capturedAt ?? Date.now(), [frozenView, data?.logs, now])

  useEffect(() => setPage(1), [filterSignature])

  useEffect(() => {
    if (frozenView || period === 'all') return
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(interval)
  }, [period, frozenView])

  const filteredLogs = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    const today = new Date(referenceTime)
    today.setHours(0, 0, 0, 0)
    const since = period === 'today' ? today.getTime() : period === '24h' ? referenceTime - 86_400_000 : 0

    return sourceLogs.filter((log) => {
      if (query && ![log.model, log.path, log.platformName, log.keyLabel, log.error || '']
        .some((value) => value.toLocaleLowerCase().includes(query))) return false
      if (filterPlatform === 'unrouted' && log.platformId) return false
      if (filterPlatform !== 'all' && filterPlatform !== 'unrouted' && log.platformId !== filterPlatform) return false
      if (filterStatus === 'success' && !isSuccess(log)) return false
      if (filterStatus === 'error' && !isFailed(log)) return false
      if (filterStatus === 'network' && !isNetworkError(log)) return false
      if (filterStatus === 'other' && (isSuccess(log) || isFailed(log))) return false
      if (filterFormat !== 'all' && log.format !== filterFormat) return false
      if (period !== 'all' && log.timestamp < since) return false
      return true
    })
  }, [sourceLogs, search, filterPlatform, filterStatus, filterFormat, period, referenceTime])

  const stats = useMemo(() => {
    let success = 0
    let failed = 0
    let duration = 0
    for (const log of filteredLogs) {
      if (isSuccess(log)) success++
      if (isFailed(log)) failed++
      duration += log.duration
    }
    return { success, failed, average: filteredLogs.length ? Math.round(duration / filteredLogs.length) : null }
  }, [filteredLogs])

  const platformOptions = useMemo(() => {
    const platforms = new Map((data?.platforms ?? []).map((platform) => [platform.id, platform.name || '未命名平台']))
    for (const log of sourceLogs) {
      if (log.platformId && !platforms.has(log.platformId)) {
        platforms.set(log.platformId, `${log.platformName || '未知平台'}（历史记录）`)
      }
    }
    if (filterPlatform !== 'all' && filterPlatform !== 'unrouted' && !platforms.has(filterPlatform)) {
      platforms.set(filterPlatform, '当前筛选平台（无保留记录）')
    }
    return [
      { value: 'all', label: '全部平台' },
      { value: 'unrouted', label: '未命中平台' },
      ...Array.from(platforms, ([value, label]) => ({ value, label }))
    ]
  }, [data?.platforms, sourceLogs, filterPlatform])

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageStart = (currentPage - 1) * PAGE_SIZE
  const pageLogs = filteredLogs.slice(pageStart, pageStart + PAGE_SIZE)

  function updateFilter(key: string, value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous)
      if (!value || value === 'all') next.delete(key)
      else next.set(key, value)
      return next
    }, { replace: true })
    setPage(1)
  }

  function resetFilters() {
    setParams((previous) => {
      const next = new URLSearchParams(previous)
      FILTER_KEYS.forEach((key) => next.delete(key))
      return next
    }, { replace: true })
    setPage(1)
  }

  async function handleReload() {
    try {
      await loadData()
    } catch (err) {
      showToast({ type: 'error', message: `读取日志失败：${errorMessage(err)}` })
    }
  }

  async function handleClear() {
    if (clearing) return
    setClearing(true)
    setClearError('')
    try {
      await clearLogs()
      setFrozenView((current) => current ? { logs: [], capturedAt: Date.now() } : null)
      setSelectedLog(null)
      setPage(1)
      setClearOpen(false)
      showToast({ type: 'success', message: '保留日志已清空，Key 计数未改变' })
    } catch (err) {
      const message = errorMessage(err)
      setClearError(message)
      showToast({ type: 'error', message: `清空日志失败：${message}` })
    } finally {
      setClearing(false)
    }
  }

  async function handleExport() {
    if (!data || exporting || !filteredLogs.length) return
    setExporting(true)
    try {
      // Explicit metadata-only export; never spread app data, credentials or request bodies.
      const secrets = Array.from(new Set([
        data.proxy.maskedApiKey,
        ...data.platforms.flatMap((platform) => [
          ...platform.keys.map((key) => key.key),
          ...Object.values(platform.customHeaders)
        ])
      ].filter((value) => value.length > 0))).sort((a, b) => b.length - a.length)
      const redact = (value: string) => redactLogText(value, secrets)
      const logs = filteredLogs.map((log) => ({
        id: redact(log.id),
        timestamp: log.timestamp,
        method: redact(log.method),
        path: redact(log.path),
        format: log.format,
        model: redact(log.model),
        platformId: redact(log.platformId),
        platformName: redact(log.platformName),
        keyLabel: redact(log.keyLabel),
        statusCode: log.statusCode,
        duration: log.duration,
        promptTokens: log.promptTokens,
        completionTokens: log.completionTokens,
        stream: log.stream,
        error: log.error ? redact(log.error) : null,
        clientIp: redact(log.clientIp)
      }))
      const filename = `keyhide-logs-${new Date().toISOString().slice(0, 10)}.json`
      const result = await window.extraApi.saveFileDialog(filename, JSON.stringify({
        exportedAt: new Date().toISOString(),
        scope: '当前筛选的保留日志；不含凭证、请求头或请求/响应正文',
        frozenAt: frozenView?.capturedAt ?? null,
        count: logs.length,
        logs
      }, null, 2))
      showToast(result.success
        ? { type: 'success', message: `已导出 ${logs.length} 条筛选日志：${result.path}` }
        : { type: 'info', message: '已取消日志导出' })
    } catch (err) {
      showToast({ type: 'error', message: `导出日志失败：${errorMessage(err)}` })
    } finally {
      setExporting(false)
    }
  }

  if (!data) {
    return (
      <div className="page-shell">
        <PageHeader title="请求日志" description="查看保留在本机的请求记录，定位转发与连接问题。" />
        <Card>
          {loading ? <p role="status" className="py-8 text-sm text-text-secondary">正在读取本机日志…</p> : (
            <EmptyState icon={<ScrollText className="h-8 w-8" />} title="无法读取日志"
              description={error || '本机数据尚未加载，请重试。'}
              action={<Button onClick={handleReload}>重新读取</Button>} />
          )}
        </Card>
      </div>
    )
  }

  return (
    <div className="page-shell">
      <PageHeader
        title="请求日志"
        description="只展示本机保留的记录，不代表累计请求量。筛选条件保存在当前页面地址中。"
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={clearing || exporting} aria-pressed={Boolean(frozenView)} onClick={() => {
              if (frozenView) {
                setFrozenView(null)
                setNow(Date.now())
              } else {
                setFrozenView({ logs: data.logs.map((log) => ({ ...log })), capturedAt: Date.now() })
              }
            }}>
              {frozenView ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              {frozenView ? '恢复实时查看' : '冻结视图'}
            </Button>
            <Button variant="secondary" onClick={handleExport} loading={exporting} disabled={clearing || !filteredLogs.length}>
              <Download className="h-4 w-4" />导出筛选日志
            </Button>
            <Button variant="danger" disabled={clearing || exporting || !data.logs.length} onClick={() => { setClearError(''); setClearOpen(true) }}>
              <Trash2 className="h-4 w-4" />清空日志
            </Button>
          </div>
        }
      />

      {error && <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm">
        <p className="text-text-secondary">本机数据读取失败：{error}。当前显示上次读取的日志。</p>
        <Button variant="secondary" size="sm" onClick={handleReload} disabled={loading}>重新读取</Button>
      </div>}

      <section aria-label="日志筛选" className="mb-5">
        <div className="filter-bar">
          <div className="min-w-0 flex-1 basis-64">
            <Input label="搜索日志" value={search} onChange={(event) => updateFilter('search', event.target.value)}
              placeholder="模型、路径、平台、Key 标签或错误" type="search" />
          </div>
          <Select label="平台" value={filterPlatform} onChange={(value) => updateFilter('platform', value)} options={platformOptions} className="min-w-40" />
          <Select label="状态" value={filterStatus} onChange={(value) => updateFilter('status', value)} options={[
            { value: 'all', label: '全部状态' }, { value: 'success', label: '成功（2xx）' },
            { value: 'error', label: '失败（含网络错误）' }, { value: 'network', label: '网络错误' }, { value: 'other', label: '其他响应' }
          ]} className="min-w-40" />
          <Select label="格式" value={filterFormat} onChange={(value) => updateFilter('format', value)} options={[
            { value: 'all', label: '全部格式' }, { value: 'openai', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }
          ]} className="min-w-32" />
          <Select label="时间范围" value={period} onChange={(value) => updateFilter('period', value)} options={[
            { value: 'all', label: '全部保留记录' }, { value: 'today', label: '今天（本地时间）' }, { value: '24h', label: '最近 24 小时' }
          ]} className="min-w-40" />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
          <p>{frozenView ? '快照中的保留日志' : '保留日志'} {sourceLogs.length.toLocaleString()} 条，最多保留 {data.proxy.maxLogs.toLocaleString()} 条；统计仅覆盖当前筛选结果。</p>
          {hasFilters && <Button variant="ghost" size="sm" onClick={resetFilters}><X className="h-3.5 w-3.5" />重置筛选</Button>}
        </div>
        {frozenView && <p role="status" className="mt-2 flex items-center gap-2 text-sm text-text-secondary">
          <Pause className="h-4 w-4 shrink-0 text-warning" />
          视图冻结于 {new Date(frozenView.capturedAt).toLocaleTimeString('zh-CN')}，新请求仍在后台记录。导出使用此快照的筛选结果。
        </p>}
        {!data.proxy.logRequests && <p className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
          <CircleMinus className="h-4 w-4 shrink-0" />当前已关闭日志记录；可在「代理服务」中开启，新请求才会出现在这里。
        </p>}
      </section>

      <dl className="stat-strip mb-5" aria-label="当前筛选结果统计">
        <Summary label="匹配的保留日志" value={filteredLogs.length.toLocaleString()} />
        <Summary label="成功（2xx）" value={stats.success.toLocaleString()} icon={<CheckCircle2 className="h-3.5 w-3.5" />} />
        <Summary label="失败（含网络错误）" value={stats.failed.toLocaleString()} icon={<AlertTriangle className="h-3.5 w-3.5" />} />
        <Summary label="平均耗时" value={stats.average === null ? '—' : `${stats.average.toLocaleString()} ms`} icon={<Clock className="h-3.5 w-3.5" />} />
      </dl>

      {filteredLogs.length === 0 ? (
        <Card>
          <EmptyState icon={<ScrollText className="h-8 w-8" />} title={sourceLogs.length === 0 ? '暂无保留日志' : '没有匹配的日志'}
            description={sourceLogs.length === 0
              ? frozenView ? '此快照中没有记录。恢复实时查看以读取最新日志。' : '启动代理并发送请求后，已开启记录的请求会显示在这里。'
              : '调整搜索词或筛选条件；较早的日志可能已超出保留上限。'}
            action={hasFilters ? <Button variant="secondary" onClick={resetFilters}><RotateCcw className="h-4 w-4" />重置筛选</Button> : undefined} />
        </Card>
      ) : (
        <div className="card overflow-hidden">
          <div className="table-wrap rounded-none border-0" role="region" aria-label="请求日志表格，可横向滚动" tabIndex={0}>
            <table className="w-full min-w-[1040px] text-left text-sm">
              <caption className="sr-only">当前筛选的保留日志，第 {currentPage} 页，共 {totalPages} 页，每页最多 50 条。使用每行的查看详情按钮打开完整记录。</caption>
              <thead className="border-b border-border bg-bg-tertiary text-xs text-text-secondary">
                <tr>
                  {['状态', '模型 / 路径', '平台 / Key 标签', '格式', 'Token', '耗时', '时间', '操作'].map((label) =>
                    <th key={label} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">{label}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {pageLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-bg-tertiary/60">
                    <td className="whitespace-nowrap px-4 py-3"><LogStatus log={log} /></td>
                    <td className="max-w-[260px] px-4 py-3">
                      <p className="truncate font-mono text-xs text-text-primary" title={log.model || '未记录模型'}>{log.model || '未记录模型'}</p>
                      <p className="mt-1 truncate font-mono text-xs text-text-muted" title={`${log.method} ${log.path}`}>{log.method} {log.path}</p>
                    </td>
                    <td className="max-w-[170px] px-4 py-3">
                      <p className="truncate text-xs text-text-secondary" title={log.platformName}>{log.platformName || '未命中平台'}</p>
                      <p className="mt-1 truncate text-xs text-text-muted" title={log.keyLabel}>{log.keyLabel || '未记录 Key 标签'}</p>
                    </td>
                    <td className="px-4 py-3"><Badge>{log.format === 'openai' ? 'OpenAI' : 'Anthropic'}</Badge></td>
                    <td className="numeric whitespace-nowrap px-4 py-3 text-xs tabular-nums text-text-secondary">{log.promptTokens + log.completionTokens > 0 ? (log.promptTokens + log.completionTokens).toLocaleString() : '—'}</td>
                    <td className="numeric whitespace-nowrap px-4 py-3 text-xs tabular-nums text-text-secondary">{log.duration.toLocaleString()} ms</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-text-muted"><time dateTime={new Date(log.timestamp).toISOString()} title={new Date(log.timestamp).toLocaleString('zh-CN')}>{formatTime(log.timestamp, referenceTime)}</time></td>
                    <td className="px-4 py-3"><Button variant="ghost" size="sm" onClick={() => setSelectedLog(log)} aria-label={`查看 ${log.model || log.path} 在 ${new Date(log.timestamp).toLocaleString('zh-CN')} 的请求详情`}>详情<ChevronRight className="h-3.5 w-3.5" /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav aria-label="日志分页" className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
            <p className="text-xs text-text-secondary" role="status">第 {pageStart + 1}–{pageStart + pageLogs.length} 条，共 {filteredLogs.length.toLocaleString()} 条；第 {currentPage} / {totalPages} 页</p>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" disabled={currentPage === 1} onClick={() => setPage(1)}>首页</Button>
              <Button variant="secondary" size="sm" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft className="h-3.5 w-3.5" />上一页</Button>
              <Button variant="secondary" size="sm" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)}>下一页<ChevronRight className="h-3.5 w-3.5" /></Button>
              <Button variant="secondary" size="sm" disabled={currentPage === totalPages} onClick={() => setPage(totalPages)}>末页</Button>
            </div>
          </nav>
        </div>
      )}

      <ConfirmDialog open={clearOpen} onClose={() => { if (!clearing) setClearOpen(false) }} onConfirm={handleClear}
        title="清空所有保留日志？" confirmLabel="清空日志" variant="danger" busy={clearing}
        description={<><p>将删除所有保留日志，不仅是当前筛选的 {filteredLogs.length} 条；Key 请求计数和 Token 用量不会改变。此操作不可撤销。</p>{clearError && <p role="alert" className="mt-3 break-words text-danger">上次清空失败：{clearError}。请重试或取消。</p>}</>} />

      {selectedLog && <Modal open onClose={() => setSelectedLog(null)} title="请求详情" width="720px"
        footer={<Button variant="secondary" onClick={() => setSelectedLog(null)}>关闭详情</Button>}>
        <div className="mb-5 flex flex-wrap items-center gap-3"><LogStatus log={selectedLog} /><span className="text-xs text-text-muted">此记录不包含真实 API Key 或请求正文。</span></div>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <DetailItem label="请求方法" value={selectedLog.method} />
          <DetailItem label="请求路径" value={selectedLog.path} />
          <DetailItem label="格式" value={selectedLog.format === 'openai' ? 'OpenAI' : 'Anthropic'} />
          <DetailItem label="流式请求" value={selectedLog.stream ? '是' : '否'} />
          <DetailItem label="模型" value={selectedLog.model || '未记录'} />
          <DetailItem label="耗时" value={`${selectedLog.duration.toLocaleString()} ms`} />
          <DetailItem label="平台" value={selectedLog.platformName || '未命中平台'} />
          <DetailItem label="平台 ID" value={selectedLog.platformId || '未命中平台'} />
          <DetailItem label="Key 标签" value={selectedLog.keyLabel || '未记录'} />
          <DetailItem label="客户端 IP" value={selectedLog.clientIp || '未记录'} />
          <DetailItem label="输入 Token" value={selectedLog.promptTokens.toLocaleString()} />
          <DetailItem label="输出 Token" value={selectedLog.completionTokens.toLocaleString()} />
          <DetailItem label="请求时间" value={new Date(selectedLog.timestamp).toLocaleString('zh-CN')} />
          <DetailItem label="记录 ID" value={selectedLog.id} />
        </dl>
        {selectedLog.error && <div className="mt-5 rounded-lg border border-danger/30 bg-danger/5 p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-medium text-text-primary"><AlertTriangle className="h-4 w-4 text-danger" />错误信息</p>
          <p className="whitespace-pre-wrap break-words text-sm text-text-secondary">{selectedLog.error}</p>
        </div>}
      </Modal>}
    </div>
  )
}

function validFilter(value: string | null, allowed: string[]) {
  return value && allowed.includes(value) ? value : 'all'
}

function Summary({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return <div className="stat-item"><dt className="flex items-center gap-1.5 text-xs text-text-secondary">{icon}{label}</dt><dd className="mt-2 text-xl font-semibold text-text-primary">{value}</dd></div>
}

function LogStatus({ log }: { log: RequestLog }) {
  const network = isNetworkError(log)
  const failed = isFailed(log)
  const success = isSuccess(log)
  const label = network ? log.statusCode === 504 ? '上游超时' : '网络错误' : log.statusCode === 499 ? '请求中断' : failed ? log.statusCode < 400 ? '传输失败' : '失败' : success ? '成功' : '其他响应'
  const Icon = failed ? AlertTriangle : success ? CheckCircle2 : CircleMinus
  return <Badge variant={failed ? 'danger' : success ? 'success' : 'default'}>
    <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    <span className="tabular-nums">{Number.isFinite(log.statusCode) ? log.statusCode : '—'}</span>
    <span>{label}</span>
  </Badge>
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-text-muted">{label}</dt><dd className="mt-1 break-words text-sm text-text-primary [overflow-wrap:anywhere]">{value}</dd></div>
}

function formatTime(timestamp: number, now: number) {
  const diff = now - timestamp
  if (diff >= 0 && diff < 60_000) return '刚刚'
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff >= 0 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function redactLogText(value: string, secrets: string[]) {
  let safe = value
  for (const secret of secrets) {
    safe = safe.split(secret).join('[已隐藏]')
    const encoded = encodeURIComponent(secret)
    if (encoded !== secret) safe = safe.split(encoded).join('[已隐藏]')
  }
  return safe
    .replace(/([?&](?:api[_-]?key|key|token|access_token|authorization|secret|password)=)[^&#\s]*/gi, '$1[已隐藏]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-[a-z0-9_-]{8,}/gi, '[已隐藏]')
}
