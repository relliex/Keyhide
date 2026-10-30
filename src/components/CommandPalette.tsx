import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Plus, Copy } from 'lucide-react'
import { Modal, Input, EmptyState } from './ui'
import { navItems } from './Sidebar'
import { useAppStore } from '../stores/app'
import { clientBaseUrl, errorMessage } from '../lib/utils'

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const data = useAppStore((state) => state.data)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const commands = useMemo(() => {
    const list: { id: string; label: string; description: string; icon: ReactNode; action: () => void | Promise<void> }[] = navItems.map(({ path, label, description, icon: Icon }) => ({ id: path, label, description, icon: <Icon className="h-4 w-4" />, action: () => navigate(path) }))
    list.push({ id: 'add-platform', label: '添加平台', description: '配置新的上游地址与 API Key', icon: <Plus className="h-4 w-4" />, action: () => navigate('/platforms?new=1') })
    if (data) list.push({ id: 'copy-url', label: '复制本地接入地址', description: `${clientBaseUrl(data.proxy)}/v1`, icon: <Copy className="h-4 w-4" />, action: async () => {
      try { await window.extraApi.clipboardWrite(`${clientBaseUrl(data.proxy)}/v1`); useAppStore.getState().showToast({ type: 'success', message: '本地接入地址已复制' }) }
      catch (error) { useAppStore.getState().showToast({ type: 'error', message: errorMessage(error) }) }
    } })
    const search = query.trim().toLowerCase()
    return list.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(search))
  }, [data, navigate, query])
  useEffect(() => { if (open) { setQuery(''); setSelected(0) } }, [open])
  const activeIndex = Math.max(0, Math.min(selected, commands.length - 1))
  const activate = (index: number) => { const command = commands[index]; if (command) { onClose(); void command.action() } }
  return <Modal open={open} onClose={onClose} title="快速导航" width="540px">
    <Input label="搜索页面或操作" value={query} placeholder="例如：模型、路由、添加平台" onChange={(event) => { setQuery(event.target.value); setSelected(0) }} role="combobox" aria-expanded="true" aria-controls="command-results" aria-activedescendant={commands[activeIndex] ? `command-${activeIndex}` : undefined} onKeyDown={(event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((value) => Math.min(value + 1, commands.length - 1)) }
      if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)) }
      if (event.key === 'Enter') { event.preventDefault(); activate(activeIndex) }
    }} />
    <div id="command-results" role="listbox" aria-label="导航结果" className="mt-4 space-y-1">{commands.map((command, index) => <button key={command.id} id={`command-${index}`} role="option" aria-selected={index === activeIndex} className={`flex w-full items-center gap-3 rounded-lg p-3 text-left ${index === activeIndex ? 'bg-accent/10' : 'hover:bg-bg-tertiary'}`} onMouseEnter={() => setSelected(index)} onClick={() => activate(index)}><span className="text-accent">{command.icon}</span><span><span className="block text-sm font-medium">{command.label}</span><span className="mt-0.5 block text-xs text-text-muted">{command.description}</span></span></button>)}</div>
    {!commands.length && <EmptyState icon={<Search className="h-5 w-5" />} title="没有匹配的操作" description="尝试搜索页面名称，如“模型”或“设置”。" />}
    <p className="mt-4 text-xs text-text-muted">↑ ↓ 选择　Enter 打开　Esc 关闭</p>
  </Modal>
}
