import { NavLink } from 'react-router-dom'
import { LayoutDashboard, Server, Network, ScrollText, Settings, ShieldCheck, Boxes, Search, LockKeyhole } from 'lucide-react'
import { useAppStore } from '../stores/app'
import { APP_VERSION } from '../../electron/shared/version'

export const navItems = [
  { path: '/dashboard', label: '工作台', description: '连接状态与快速开始', icon: LayoutDashboard },
  { path: '/platforms', label: '上游平台', description: '平台与真实密钥管理', icon: Network },
  { path: '/models', label: '模型目录', description: '搜索模型与复制名称', icon: Boxes },
  { path: '/proxy', label: '代理服务', description: '本地地址与接入凭证', icon: Server },
  { path: '/logs', label: '请求日志', description: '筛选、查看与导出请求', icon: ScrollText },
  { path: '/settings', label: '设置与路由', description: '路由预览与全局设置', icon: Settings }
]

export function Sidebar({ onSearch }: { onSearch: () => void }) {
  const proxyRunning = useAppStore((state) => state.proxyRunning)
  return <aside className="sidebar" aria-label="主导航">
    <div className="brand"><div className="brand-mark"><ShieldCheck className="h-6 w-6" /></div><div className="brand-text"><p className="text-lg font-semibold tracking-tight">Keyhide</p><p className="mt-0.5 text-xs text-text-muted">真实密钥，留在本机</p></div></div>
    <button onClick={onSearch} title="快速导航 (Ctrl+K)" className="mx-3 mb-5 flex min-h-9 items-center justify-between gap-2 rounded-lg border border-border px-3 text-xs text-text-muted"><span className="flex items-center gap-2"><Search className="h-4 w-4" /><span className="sidebar-command-label">快速导航</span></span><kbd className="sidebar-command-label text-[11px]">Ctrl K</kbd></button>
    <nav className="flex-1 space-y-1 px-3">{navItems.map(({ path, label, icon: Icon }) => <NavLink key={path} to={path} title={label} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}><Icon className="h-[18px] w-[18px] flex-shrink-0" aria-hidden="true" /><span className="nav-label">{label}</span></NavLink>)}</nav>
    <div className="sidebar-footer m-4 rounded-xl border border-border p-4"><div className="flex items-center gap-2 text-xs"><span className={`status-dot ${proxyRunning ? 'active' : ''}`} /><span>{proxyRunning ? '本地服务运行中' : '本地服务已停止'}</span></div><p className="mt-3 flex items-center gap-1.5 text-[11px] text-text-muted"><LockKeyhole className="h-3 w-3" />本地加密存储</p></div>
    <p className="sidebar-footer px-5 pb-5 text-[11px] text-text-muted">版本 {APP_VERSION}</p>
  </aside>
}
