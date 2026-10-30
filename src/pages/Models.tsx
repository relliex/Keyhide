import { useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Boxes, Search, Network, ChevronLeft, ChevronRight } from 'lucide-react'
import { useAppStore } from '../stores/app'
import { Badge, Button, CopyButton, EmptyState, Input, PageHeader, Select, Toggle } from '../components/ui'
import { usableKeys } from '../lib/utils'

export function Models() {
  const data = useAppStore((state) => state.data)
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const query = params.get('q') || ''
  const platformId = params.get('platform') || 'all'
  const availableOnly = params.get('available') !== 'false'
  const requestedPage = Math.max(1, Number(params.get('page')) || 1)
  const changeFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value && value !== 'all') next.set(key, value); else next.delete(key)
    next.delete('page')
    setParams(next, { replace: true })
  }
  const list = useMemo(() => {
    const models = new Map<string, { name: string; platforms: NonNullable<typeof data>['platforms'] }>()
    const search = query.trim().toLowerCase()
    for (const platform of data?.platforms || []) {
      if (platformId !== 'all' && platform.id !== platformId) continue
      if (availableOnly && (!platform.enabled || !usableKeys(platform).length)) continue
      for (const model of new Set(platform.models)) {
        if (search && !`${model} ${platform.name} ${platform.type}`.toLowerCase().includes(search)) continue
        const row = models.get(model) || { name: model, platforms: [] }
        row.platforms.push(platform)
        models.set(model, row)
      }
    }
    return [...models.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [data?.platforms, query, platformId, availableOnly])
  if (!data) return null
  const pages = Math.max(1, Math.ceil(list.length / 30))
  const page = Math.min(requestedPage, pages)
  const shown = list.slice((page - 1) * 30, page * 30)
  const setPage = (value: number) => { const next = new URLSearchParams(params); next.set('page', String(value)); setParams(next) }
  return <div className="page-shell">
    <PageHeader title="模型目录" description="查找模型名称和所属平台。复制名称后可直接用于本地代理请求。" action={<Button variant="secondary" onClick={() => navigate('/platforms')}><Network className="h-4 w-4" />管理平台与获取模型</Button>} />
    <div className="filter-bar"><div className="min-w-[180px] flex-1"><Input label="搜索模型或平台" value={query} placeholder="输入模型名称、平台或格式" onChange={(event) => changeFilter('q', event.target.value)} /></div><div className="w-48"><Select label="所属平台" value={platformId} onChange={(value) => changeFilter('platform', value)} options={[{ value: 'all', label: '全部平台' }, ...data.platforms.map((platform) => ({ value: platform.id, label: platform.name }))]} /></div><div className="flex min-h-10 items-center gap-2"><Toggle label="只显示可用平台的模型" checked={availableOnly} onChange={(value) => changeFilter('available', String(value))} /><span className="text-xs text-text-secondary">仅可用平台</span></div></div>
    <p className="mb-4 text-xs text-text-muted">{list.length} 个去重模型{availableOnly ? '，来自已启用且有可用 Key 的平台' : '，包含已禁用或暂无可用 Key 的平台'}。模型支持不代表所有协议均可互换。</p>
    {shown.length ? <><div className="table-wrap"><table><caption className="sr-only">模型目录与所属上游平台</caption><thead><tr><th>模型名称</th><th>所属平台</th><th>状态</th><th className="text-right">操作</th></tr></thead><tbody>{shown.map((row) => {
      const available = row.platforms.some((platform) => platform.enabled && usableKeys(platform).length)
      return <tr key={row.name}><td><code className="break-all text-sm">{row.name}</code></td><td><div className="flex flex-wrap gap-2">{row.platforms.map((platform) => <button key={platform.id} onClick={() => navigate(`/platforms?selected=${encodeURIComponent(platform.id)}`)} className="rounded text-left text-xs text-text-secondary hover:text-accent" title={`管理 ${platform.name}`}>{platform.name}<span className="ml-1 text-text-muted">({platform.type})</span></button>)}</div></td><td><Badge variant={available ? 'success' : 'default'}>{available ? '可用' : '不可用'}</Badge></td><td className="text-right"><CopyButton text={row.name} label="复制名称" /></td></tr>
    })}</tbody></table></div><div className="mt-4 flex items-center justify-between gap-3 text-xs text-text-muted"><span>第 {page} / {pages} 页，共 {list.length} 个模型</span><div className="flex gap-2"><Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="h-3.5 w-3.5" />上一页</Button><Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页<ChevronRight className="h-3.5 w-3.5" /></Button></div></div></> : <div className="card"><EmptyState icon={query ? <Search className="h-6 w-6" /> : <Boxes className="h-6 w-6" />} title={query || platformId !== 'all' ? '没有匹配的模型' : '模型目录暂时为空'} description={query || platformId !== 'all' ? '调整搜索内容或平台筛选，再试一次。' : '在上游平台获取模型列表，或编辑平台手动添加模型名称。如果已配置模型，请检查平台与 Key 是否可用。'} action={query || platformId !== 'all' ? <Button variant="secondary" onClick={() => setParams(availableOnly ? {} : { available: 'false' })}>清除筛选</Button> : <Button onClick={() => navigate('/platforms')}>配置上游平台</Button>} /></div>}
  </div>
}
