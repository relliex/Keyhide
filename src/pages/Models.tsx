import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Boxes, Search, Network, ChevronLeft, ChevronRight, Save, RotateCcw, AlertTriangle } from 'lucide-react'
import { useAppStore } from '../stores/app'
import { Badge, Button, CopyButton, EmptyState, Input, PageHeader, Select, Toggle } from '../components/ui'
import type { UpstreamPlatform } from '../../electron/shared/types'
import { aliasValidationError, invalidAliasModels, modelAliasEntry, publicModelNames } from '../../electron/shared/models'
import { errorMessage, usableKeys } from '../lib/utils'

type AliasRow = { name: string; model: string; platform: UpstreamPlatform }

export function Models() {
  const data = useAppStore((state) => state.data)
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const query = params.get('q') || ''
  const platformId = params.get('platform') || 'all'
  const availableOnly = params.get('available') !== 'false'
  const requestedPage = Math.max(1, Number(params.get('page')) || 1)
  const aliasesEnabled = !!data?.settings.enableModelAliases
  const changeFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value && value !== 'all') next.set(key, value); else next.delete(key)
    next.delete('page')
    setParams(next, { replace: true })
  }
  const list = useMemo(() => {
    const search = query.trim().toLowerCase()
    if (!aliasesEnabled) {
      const models = new Map<string, { name: string; platforms: UpstreamPlatform[] }>()
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
    }
    const rows: AliasRow[] = []
    const seen = new Set<string>()
    for (const platform of data?.platforms || []) {
      if (platformId !== 'all' && platform.id !== platformId) continue
      if (availableOnly && (!platform.enabled || !usableKeys(platform).length)) continue
      for (const model of platform.models) {
        for (const name of publicModelNames({ ...platform, models: [model] }, true)) {
          if (search && !`${name} ${model} ${platform.name}`.toLowerCase().includes(search)) continue
          const key = `${platform.id}\u0000${name}`
          if (seen.has(key)) continue
          seen.add(key)
          rows.push({ name, model, platform })
        }
      }
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name) || a.platform.name.localeCompare(b.platform.name))
  }, [data?.platforms, query, platformId, availableOnly, aliasesEnabled])
  if (!data) return null
  const pages = Math.max(1, Math.ceil(list.length / 30))
  const page = Math.min(requestedPage, pages)
  const shown = list.slice((page - 1) * 30, page * 30)
  const setPage = (value: number) => { const next = new URLSearchParams(params); next.set('page', String(value)); setParams(next) }
  const aliasPlatform = data.platforms.find((platform) => platform.id === (platformId !== 'all' ? platformId : '')) || data.platforms.find((platform) => platform.enabled) || data.platforms[0]
  return <div className="page-shell">
    <PageHeader title="模型目录" description={aliasesEnabled ? '显示下游可见的公开模型名称。真实模型、别名与显示原名开关在上方按平台维护。' : '查找模型名称和所属平台。复制名称后可直接用于本地代理请求。'} action={<Button variant="secondary" onClick={() => navigate('/platforms')}><Network className="h-4 w-4" />管理平台与获取模型</Button>} />
    {aliasesEnabled && <AliasPanel key={platformId} platforms={data.platforms} platform={aliasPlatform} />}
    <div className="filter-bar"><div className="min-w-[180px] flex-1"><Input label="搜索模型或平台" value={query} placeholder="输入模型名称、平台或格式" onChange={(event) => changeFilter('q', event.target.value)} /></div><div className="w-48"><Select label="所属平台" value={platformId} onChange={(value) => changeFilter('platform', value)} options={[{ value: 'all', label: '全部平台' }, ...data.platforms.map((platform) => ({ value: platform.id, label: platform.name }))]} /></div><div className="flex min-h-10 items-center gap-2"><Toggle label="只显示可用平台的模型" checked={availableOnly} onChange={(value) => changeFilter('available', String(value))} /><span className="text-xs text-text-secondary">仅可用平台</span></div></div>
    <p className="mb-4 text-xs text-text-muted">{list.length} 个{aliasesEnabled ? '下游公开名称' : '去重模型'}{availableOnly ? '，来自已启用且有可用 Key 的平台' : '，包含已禁用或暂无可用 Key 的平台'}。{aliasesEnabled ? '开启别名后，下游目录只展示这些名称。' : '模型支持不代表所有协议均可互换。'}</p>
    {shown.length ? <><div className="table-wrap"><table><caption className="sr-only">{aliasesEnabled ? '下游公开模型目录与实际模型' : '模型目录与所属上游平台'}</caption><thead><tr><th>模型名称</th>{aliasesEnabled && <th>实际模型</th>}<th>所属平台</th><th>状态</th><th className="text-right">操作</th></tr></thead><tbody>{shown.map((row) => {
      if ('platform' in row) {
        const available = row.platform.enabled && usableKeys(row.platform).length > 0
        return <tr key={`${row.platform.id}:${row.name}`}><td><code className="break-all text-sm">{row.name}</code></td><td><code className="break-all text-xs text-text-secondary">{row.model}</code>{row.name === row.model && <Badge variant="warning">原名</Badge>}</td><td><button onClick={() => navigate(`/platforms?selected=${encodeURIComponent(row.platform.id)}`)} className="rounded text-left text-xs text-text-secondary hover:text-accent" title={`管理 ${row.platform.name}`}>{row.platform.name}<span className="ml-1 text-text-muted">({row.platform.upstreamProtocol})</span></button></td><td><Badge variant={available ? 'success' : 'default'}>{available ? '可用' : '不可用'}</Badge></td><td className="text-right"><CopyButton text={row.name} label="复制名称" /></td></tr>
      }
      const available = row.platforms.some((platform) => platform.enabled && usableKeys(platform).length)
      return <tr key={row.name}><td><code className="break-all text-sm">{row.name}</code></td><td><div className="flex flex-wrap gap-2">{row.platforms.map((platform) => <button key={platform.id} onClick={() => navigate(`/platforms?selected=${encodeURIComponent(platform.id)}`)} className="rounded text-left text-xs text-text-secondary hover:text-accent" title={`管理 ${platform.name}`}>{platform.name}<span className="ml-1 text-text-muted">({platform.upstreamProtocol})</span></button>)}</div></td><td><Badge variant={available ? 'success' : 'default'}>{available ? '可用' : '不可用'}</Badge></td><td className="text-right"><CopyButton text={row.name} label="复制名称" /></td></tr>
    })}</tbody></table></div><div className="mt-4 flex items-center justify-between gap-3 text-xs text-text-muted"><span>第 {page} / {pages} 页，共 {list.length} 个模型</span><div className="flex gap-2"><Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="h-3.5 w-3.5" />上一页</Button><Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页<ChevronRight className="h-3.5 w-3.5" /></Button></div></div></> : <div className="card"><EmptyState icon={query ? <Search className="h-6 w-6" /> : <Boxes className="h-6 w-6" />} title={query || platformId !== 'all' ? '没有匹配的模型' : '模型目录暂时为空'} description={query || platformId !== 'all' ? '调整搜索内容或平台筛选，再试一次。' : '在上游平台获取模型列表，或编辑平台手动添加模型名称。如果已配置模型，请检查平台与 Key 是否可用。'} action={query || platformId !== 'all' ? <Button variant="secondary" onClick={() => setParams(availableOnly ? {} : { available: 'false' })}>清除筛选</Button> : <Button onClick={() => navigate('/platforms')}>配置上游平台</Button>} /></div>}
  </div>
}

function AliasPanel({ platforms, platform }: { platforms: UpstreamPlatform[]; platform?: UpstreamPlatform }) {
  const [selectedId, setSelectedId] = useState(platform?.id || '')
  const current = platforms.find((item) => item.id === selectedId) || platform
  if (!current) return <div className="card mb-5 p-5 text-sm text-text-muted">先添加一个上游平台，再配置模型别名。</div>
  return <div className="card mb-5 p-5">
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div><h2 className="text-sm font-semibold">模型别名编辑</h2><p className="mt-1 text-xs text-text-muted">真实模型名称来自平台目录；每个模型可配置多个公开名称。隐藏原名不会阻止已知真实名称直接请求。</p></div>
      <div className="w-56"><Select label="编辑平台" value={current.id} onChange={setSelectedId} options={platforms.map((item) => ({ value: item.id, label: item.name || '未命名平台' }))} /></div>
    </div>
    <AliasEditor key={current.id} platform={current} />
  </div>
}

function AliasEditor({ platform }: { platform: UpstreamPlatform }) {
  const saveModelAliases = useAppStore((state) => state.saveModelAliases)
  const showToast = useAppStore((state) => state.showToast)
  const [drafts, setDrafts] = useState<Record<string, { aliases: string; showOriginal: boolean }>>(() => {
    const initial: Record<string, { aliases: string; showOriginal: boolean }> = {}
    for (const model of platform.models) {
      const entry = modelAliasEntry(platform, model)
      initial[model] = { aliases: entry?.aliases.join(', ') || '', showOriginal: entry?.showOriginal ?? true }
    }
    return initial
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const invalid = invalidAliasModels(platform)
  const models = platform.models.filter((model) => !search.trim() || model.toLowerCase().includes(search.trim().toLowerCase()))
  const pageSize = 20
  const pages = Math.max(1, Math.ceil(models.length / pageSize))
  const currentPage = Math.min(page, pages)
  const rows = models.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const save = async (model: string) => {
    if (saving) return
    const entry = modelAliasEntry(platform, model)
    const draft = drafts[model]
    const aliases = [...new Set(draft.aliases.split(/[\r\n,]+/).map((alias) => alias.trim()).filter(Boolean))]
    const problem = aliasValidationError(platform, model, aliases)
    setErrors((previous) => ({ ...previous, [model]: problem || '' }))
    if (problem) return
    setSaving(model)
    try {
      await saveModelAliases({ platformId: platform.id, model, aliases, showOriginal: draft.showOriginal, expectedAliases: entry?.aliases || [], expectedShowOriginal: entry?.showOriginal ?? true })
      showToast({ type: 'success', message: `已保存 ${model} 的别名` })
    } catch (error) {
      const message = errorMessage(error)
      setErrors((previous) => ({ ...previous, [model]: message }))
      showToast({ type: 'error', message })
    } finally { setSaving(null) }
  }
  const reset = (model: string) => {
    const entry = modelAliasEntry(platform, model)
    setDrafts((previous) => ({ ...previous, [model]: { aliases: entry?.aliases.join(', ') || '', showOriginal: entry?.showOriginal ?? true } }))
    setErrors((previous) => ({ ...previous, [model]: '' }))
  }
  return <div>
    {invalid.length > 0 && <div className="mb-4 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs leading-relaxed text-text-secondary"><p className="flex items-center gap-2 font-medium text-warning"><AlertTriangle className="h-4 w-4" />失效别名映射</p><p className="mt-1">以下真实模型已不在平台目录中，配置会保留但不会公开：{invalid.map((model) => <code key={model} className="mx-1 break-all font-mono">{model}</code>)}。可重新获取模型或编辑平台恢复。</p></div>}
    {!platform.models.length ? <p className="rounded-lg border border-border bg-bg-tertiary p-4 text-xs text-text-muted">该平台还没有模型目录。请先在「上游平台」获取模型或手动填写模型名称。</p> : <>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3"><div className="w-full max-w-xs"><Input label="筛选真实模型" value={search} placeholder="输入模型名称" onChange={(event) => { setSearch(event.target.value); setPage(1) }} /></div><span className="text-xs text-text-muted">{models.length} 个真实模型，第 {currentPage}/{pages} 页</span></div>
      <div className="space-y-2">{rows.map((model) => {
        const entry = modelAliasEntry(platform, model)
        const draft = drafts[model] || { aliases: '', showOriginal: true }
        const parsed = [...new Set(draft.aliases.split(/[\r\n,]+/).map((alias) => alias.trim()).filter(Boolean))]
        const dirty = JSON.stringify(parsed) !== JSON.stringify(entry?.aliases || []) || draft.showOriginal !== (entry?.showOriginal ?? true)
        return <div key={model} className="rounded-lg border border-border bg-bg-primary/40 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1"><p className="text-xs text-text-muted">真实模型</p><code className="mt-1 block break-all font-mono text-sm text-text-primary">{model}</code></div>
            <div className="flex items-center gap-2"><span className="text-xs text-text-secondary">显示原名</span><Toggle label={`${model} 显示原名`} checked={draft.showOriginal} onChange={(showOriginal) => setDrafts((previous) => ({ ...previous, [model]: { ...draft, showOriginal } }))} />{dirty && <Badge variant="warning">未保存</Badge>}</div>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1"><Input label="公开名称（逗号或换行分隔）" value={draft.aliases} placeholder="例如：deepseek-v4, company-chat" onChange={(event) => setDrafts((previous) => ({ ...previous, [model]: { ...draft, aliases: event.target.value } }))} error={errors[model]} /></div>
            <Button variant="secondary" size="sm" disabled={!dirty || !!saving} loading={saving === model} onClick={() => void save(model)}><Save className="h-3.5 w-3.5" />保存</Button>
            <Button variant="ghost" size="sm" disabled={!dirty || !!saving} onClick={() => reset(model)} aria-label={`撤销 ${model} 的别名修改`}><RotateCcw className="h-3.5 w-3.5" />撤销</Button>
          </div>
          {parsed.length > 0 && !errors[model] && <p className="mt-2 text-xs text-text-muted">下游可用名称：{parsed.map((alias) => <code key={alias} className="mx-1 font-mono text-text-secondary">{alias}</code>)}{draft.showOriginal && <code className="mx-1 font-mono text-text-secondary">{model}</code>}</p>}
        </div>
      })}</div>
      <div className="mt-3 flex items-center justify-end gap-2"><Button variant="secondary" size="sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft className="h-3.5 w-3.5" />上一页</Button><Button variant="secondary" size="sm" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>下一页<ChevronRight className="h-3.5 w-3.5" /></Button></div>
    </>}
  </div>
}
